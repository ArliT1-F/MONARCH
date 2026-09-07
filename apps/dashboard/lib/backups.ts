import { createLogger } from "@monarch/shared";
import type { ServerDesign } from "@monarch/schemas";
import { TEMPLATE_FORMAT, parseServerTemplate, type ServerTemplate } from "@monarch/schemas";
import { detachDesign, localiseIds, mergeDesigns, rebaseDesign } from "@monarch/design-engine";
import { validateServerDesign } from "@monarch/validation";
import { fetchCurrentDesign } from "./discord";
import { getStore, newId, type SnapshotRecord } from "./store";

/**
 * Backups & templates — shared by the dashboard routes (`/api/guilds/…`)
 * and the bot-facing internal routes (`/api/internal/guilds/…`), so both
 * surfaces behave identically. Nothing here talks to Discord except through
 * `fetchCurrentDesign`; restoring/importing only *stages a draft* — the
 * actual apply always goes through the Server Designer's review flow.
 */
const log = createLogger("backups");

export type BackupOutcome =
  | { ok: true; snapshot: Omit<SnapshotRecord, "design">; channelCount: number; categoryCount: number }
  | { ok: false; status: number; code: string; message: string };

/** Take a manual snapshot of the live structure. */
export async function createBackup(opts: {
  guildId: string;
  userId: string;
  name?: string;
}): Promise<BackupOutcome> {
  const current = await fetchCurrentDesign(opts.guildId);
  if (!current) {
    return {
      ok: false,
      status: 502,
      code: "guild.state",
      message: "Monarch couldn't read this server's structure.",
    };
  }
  const store = getStore();
  const snapshot: SnapshotRecord = {
    id: newId("snap"),
    guildId: opts.guildId,
    name: opts.name?.trim() || `Backup · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    kind: "manual",
    design: current,
    createdAt: new Date().toISOString(),
  };
  await store.addSnapshot(snapshot);
  await store.addAudit({
    id: newId("audit"),
    guildId: opts.guildId,
    userId: opts.userId,
    action: "backup.create",
    summary: `Backup "${snapshot.name}" saved (${current.categories.length} categories, ${current.channels.length} channels)`,
    createdAt: snapshot.createdAt,
  });
  log.info("backup created", { guildId: opts.guildId, userId: opts.userId, id: snapshot.id });
  return {
    ok: true,
    snapshot: withoutDesign(snapshot),
    channelCount: current.channels.length,
    categoryCount: current.categories.length,
  };
}

export function withoutDesign(snapshot: SnapshotRecord): Omit<SnapshotRecord, "design"> {
  const { design: _design, ...meta } = snapshot;
  return meta;
}

export type RestoreOutcome =
  | {
      ok: true;
      snapshot: Omit<SnapshotRecord, "design">;
      /** Entities that no longer exist and will be recreated on apply. */
      recreated: number;
      designerUrl: string;
    }
  | { ok: false; status: number; code: string; message: string; fix?: string };

/**
 * Stage a snapshot as the caller's draft. The designer then shows the exact
 * diff (creates for deleted channels, deletes for channels added since,
 * renames/moves for the rest) and the user applies it from there.
 */
export async function stageRestore(opts: {
  guildId: string;
  userId: string;
  snapshotId: string;
}): Promise<RestoreOutcome> {
  const store = getStore();
  const snapshot = await store.getSnapshot(opts.guildId, opts.snapshotId);
  if (!snapshot) {
    return { ok: false, status: 404, code: "snapshot.not-found", message: "That snapshot doesn't exist." };
  }
  const current = await fetchCurrentDesign(opts.guildId);
  if (!current) {
    return { ok: false, status: 502, code: "guild.state", message: "Monarch couldn't read this server's structure." };
  }
  const { design, recreated, adopted } = rebaseDesign(current, snapshot.design);
  await store.putDraft(opts.userId, {
    guildId: opts.guildId,
    design,
    baseDesign: current,
    updatedAt: new Date().toISOString(),
  });
  await store.addAudit({
    id: newId("audit"),
    guildId: opts.guildId,
    userId: opts.userId,
    action: "backup.restore-staged",
    summary: `Restore of "${snapshot.name}" staged as a draft${recreated ? ` (${recreated} deleted item(s) will be recreated)` : ""}`,
    createdAt: new Date().toISOString(),
  });
  log.info("restore staged", { guildId: opts.guildId, userId: opts.userId, id: snapshot.id, recreated, adopted });
  return { ok: true, snapshot: withoutDesign(snapshot), recreated, designerUrl: `/s/${opts.guildId}/designer` };
}

/** Portable template of the live structure (ids detached, guild-specific bits removed). */
export async function exportTemplate(guildId: string): Promise<
  { ok: true; template: ServerTemplate; fileName: string } | { ok: false; status: number; code: string; message: string }
> {
  const current = await fetchCurrentDesign(guildId);
  if (!current) {
    return { ok: false, status: 502, code: "guild.state", message: "Monarch couldn't read this server's structure." };
  }
  return { ok: true, template: buildTemplate(current), fileName: templateFileName(current.name) };
}

export function buildTemplate(design: ServerDesign): ServerTemplate {
  const detached = detachDesign(design);
  return {
    format: TEMPLATE_FORMAT,
    version: 1,
    type: "server",
    name: design.name,
    data: {
      ...detached,
      guildId: undefined,
      metadata: { ...detached.metadata, updatedAt: new Date().toISOString() },
    },
  };
}

function pickStructure(design: ServerDesign): Pick<ServerDesign, "categories" | "channels"> {
  return { categories: design.categories, channels: design.channels };
}

export function templateFileName(guildName: string): string {
  const slug = guildName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "server"}-monarch-template.json`;
}

export type ImportMode = "replace" | "add";

export type ImportOutcome =
  | {
      ok: true;
      templateName: string;
      mode: ImportMode;
      categoryCount: number;
      channelCount: number;
      designerUrl: string;
    }
  | { ok: false; status: number; code: string; message: string; detail?: unknown };

/**
 * Parse a template file and stage it as the caller's draft.
 * `replace` — the draft becomes the template (everything not in it is
 *             deleted on apply, after the destructive confirmation).
 * `add`     — the template is appended under the existing structure.
 */
export async function stageImport(opts: {
  guildId: string;
  userId: string;
  json: unknown;
  mode: ImportMode;
}): Promise<ImportOutcome> {
  const parsed = parseServerTemplate(opts.json);
  if (!parsed.ok) {
    return { ok: false, status: 400, code: "template.invalid", message: parsed.error };
  }
  const current = await fetchCurrentDesign(opts.guildId);
  if (!current) {
    return { ok: false, status: 502, code: "guild.state", message: "Monarch couldn't read this server's structure." };
  }
  // A template is portable structure only: never let it smuggle in another
  // server's roles or designated channels.
  const incoming: ServerDesign = {
    ...parsed.template.data,
    guildId: current.guildId,
    name: current.name,
    roles: current.roles,
    designatedChannels: current.designatedChannels,
  };
  const design =
    opts.mode === "add"
      ? mergeDesigns(current, incoming)
      : { ...current, ...pickStructure(localiseIds(incoming)) };

  const validation = validateServerDesign(design);
  if (!validation.valid) {
    return {
      ok: false,
      status: 422,
      code: "template.validation",
      message: "The template would produce an invalid server structure.",
      detail: validation.errors,
    };
  }

  const store = getStore();
  await store.putDraft(opts.userId, {
    guildId: opts.guildId,
    design,
    baseDesign: current,
    updatedAt: new Date().toISOString(),
  });
  const templateName = parsed.template.name ?? "template";
  await store.addAudit({
    id: newId("audit"),
    guildId: opts.guildId,
    userId: opts.userId,
    action: "template.import-staged",
    summary: `Template "${templateName}" staged as a draft (${opts.mode === "add" ? "added to" : "replacing"} the current structure)`,
    createdAt: new Date().toISOString(),
  });
  return {
    ok: true,
    templateName,
    mode: opts.mode,
    categoryCount: incoming.categories.length,
    channelCount: incoming.channels.length,
    designerUrl: `/s/${opts.guildId}/designer`,
  };
}
