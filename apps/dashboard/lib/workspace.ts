import {
  EmbedDesignSchema,
  MessageDesignSchema,
  type EmbedDesign,
  type GuildWorkspace,
  type MessageDesign,
  type TargetConfig,
} from "@monarch/schemas";
import { validateEmbedDesign, validateMessageDesign } from "@monarch/validation";
import {
  applyVariablesToEmbed,
  applyVariablesToMessage,
  renderMessagePayload,
} from "@monarch/renderer";
import { resolveTarget } from "@monarch/discord";
import { createLogger, monarchError, type MonarchError } from "@monarch/shared";
import { NextResponse } from "next/server";
import { getGateway } from "./discord";
import { getStore, newId } from "./store";

/**
 * Content workspace service — shared by the dashboard route handlers and
 * the internal bot API. Implements the mandatory publishing pipeline:
 *
 *   saved design → validation → Target Resolver → {variables} resolved
 *   → renderer payload → gateway.sendMessage → audit
 *
 * Routes stay thin; the pipeline lives here so both entry points behave
 * identically.
 */

const log = createLogger("workspace");

export type ContentKind = "embed" | "message";
export type SendMode = "test" | "publish";

export interface SendContext {
  guildId: string;
  userId: string;
  username: string;
  guildName?: string;
  memberCount?: number;
  kind: ContentKind;
  mode: SendMode;
  /** Send an in-memory design (dashboard). Falls back to the saved workspace. */
  design?: unknown;
  /** Explicit target; defaults to the designated testing/announcements channel. */
  target?: TargetConfig;
}

export type SendOutcome =
  | { ok: true; channelId: string; channelName: string; messageId: string }
  | { ok: false; error: MonarchError };

/**
 * Validate stored designs without throwing: a row written by an older (or
 * newer) schema version must degrade to an empty editor, never to a 500
 * with an empty body that crashes the client's `res.json()` call.
 * Pure — unit-tested without a database.
 */
export function parseStoredWorkspace(stored: { embed: unknown; message: unknown }): {
  embed: EmbedDesign | null;
  message: MessageDesign | null;
} {
  let embed: EmbedDesign | null = null;
  if (stored.embed != null) {
    const parsed = EmbedDesignSchema.safeParse(stored.embed);
    if (parsed.success) embed = parsed.data;
  }
  let message: MessageDesign | null = null;
  if (stored.message != null) {
    const parsed = MessageDesignSchema.safeParse(stored.message);
    if (parsed.success) message = parsed.data;
  }
  return { embed, message };
}

export async function loadWorkspace(guildId: string): Promise<GuildWorkspace> {
  const w = await getStore().getWorkspace(guildId);
  const parsed = parseStoredWorkspace({ embed: w.embed, message: w.message });
  if ((w.embed != null && !parsed.embed) || (w.message != null && !parsed.message)) {
    log.warn("stored workspace failed validation; starting from empty", { guildId });
  }
  return { guildId, ...parsed };
}

export async function saveWorkspace(
  guildId: string,
  part: { embed?: EmbedDesign | null; message?: MessageDesign | null },
): Promise<GuildWorkspace> {
  const current = await loadWorkspace(guildId);
  const workspace: GuildWorkspace = {
    guildId,
    embed: part.embed !== undefined ? part.embed : current.embed,
    message: part.message !== undefined ? part.message : current.message,
  };
  await getStore().putWorkspace({ ...workspace, updatedAt: new Date().toISOString() });
  return workspace;
}

/** Resolve kind → design from the body (dashboard) or the saved workspace. */
function pickDesign(
  kind: ContentKind,
  provided: unknown,
  saved: GuildWorkspace,
): { ok: true; design: EmbedDesign | MessageDesign } | { ok: false; error: MonarchError } {
  if (provided !== undefined) {
    const parsed =
      kind === "embed"
        ? EmbedDesignSchema.safeParse(provided)
        : MessageDesignSchema.safeParse(provided);
    if (!parsed.success) {
      return { ok: false, error: monarchError("workspace.invalid", "The design payload is invalid.") };
    }
    return { ok: true, design: parsed.data };
  }
  const found = kind === "embed" ? saved.embed : saved.message;
  if (!found) {
    return {
      ok: false,
      error: monarchError("workspace.empty", `No ${kind} design is saved yet.`, {
        fix: "Open the editor, design something and save it first.",
      }),
    };
  }
  return { ok: true, design: found };
}

export async function sendWorkspaceDesign(ctx: SendContext): Promise<SendOutcome> {
  const saved = await loadWorkspace(ctx.guildId);
  const picked = pickDesign(ctx.kind, ctx.design, saved);
  if (!picked.ok) return picked;

  // 1. Validate the design (errors block test/publish — same rules as UI).
  const report =
    ctx.kind === "embed"
      ? validateEmbedDesign(picked.design as EmbedDesign)
      : validateMessageDesign(picked.design as MessageDesign);
  if (!report.valid) {
    return {
      ok: false,
      error: monarchError("workspace.validation", "The design has validation errors.", {
        reason: report.errors[0]?.message,
        fix: report.errors[0]?.fix,
      }),
    };
  }

  // 2. Resolve WHERE through the Target Resolver. Never guess #general.
  const target: TargetConfig =
    ctx.target ??
    (ctx.mode === "publish"
      ? { kind: "designated", key: "announcements" }
      : { kind: "designated", key: "testing" });

  const gateway = getGateway();
  const settings = await getStore().getGuildSettings(ctx.guildId);
  const resolved = await resolveTarget(gateway, ctx.guildId, target, {
    designatedChannels: settings.designatedChannels,
  });
  if (!resolved.ok) return resolved;

  // 3. Resolve {variables} against the real send context, then render.
  const variableCtx = {
    user: { id: ctx.userId, username: ctx.username },
    guild: { id: ctx.guildId, name: ctx.guildName ?? "", memberCount: ctx.memberCount },
    channel: { id: resolved.value.channelId, name: resolved.value.channelName },
  };

  let payload: { content?: string; embeds?: unknown[]; components?: unknown[] };
  if (ctx.kind === "embed") {
    const design = picked.design as EmbedDesign;
    payload = renderMessagePayload({
      content: "",
      embeds: [applyVariablesToEmbed(design, variableCtx)],
      buttons: [],
    });
  } else {
    const design = picked.design as MessageDesign;
    payload = renderMessagePayload(applyVariablesToMessage(design, variableCtx));
  }

  // 4. Send through the gateway (REST or Mock).
  const sent = await gateway.sendMessage(resolved.value.channelId, payload);
  if (!sent.ok) return sent;

  // 5. Audit trail.
  await getStore().addAudit({
    id: newId("audit"),
    guildId: ctx.guildId,
    userId: ctx.userId,
    action: `content.${ctx.mode}`,
    summary: `${ctx.mode === "publish" ? "Published" : "Tested"} ${ctx.kind} to #${resolved.value.channelName}`,
    createdAt: new Date().toISOString(),
  });

  log.info("content sent", {
    guildId: ctx.guildId,
    kind: ctx.kind,
    mode: ctx.mode,
    channelId: resolved.value.channelId,
  });

  return { ok: true, ...resolved.value, messageId: sent.value.messageId };
}

/** Map a SendOutcome to the HTTP response both entry points share. */
export function sendOutcomeResponse(outcome: SendOutcome): NextResponse {
  if (outcome.ok) {
    return NextResponse.json({
      ok: true,
      channelId: outcome.channelId,
      channelName: outcome.channelName,
      messageId: outcome.messageId,
    });
  }
  const { error } = outcome;
  const status =
    error.code === "workspace.validation"
      ? 422
      : error.code.startsWith("target.") || error.code.startsWith("workspace.")
        ? 409
        : 502;
  return NextResponse.json({ error }, { status });
}
