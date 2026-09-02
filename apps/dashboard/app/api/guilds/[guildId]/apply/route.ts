import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ServerDesignSchema } from "@monarch/schemas";
import { validateServerDesign } from "@monarch/validation";
import { diffServerDesign, planApply } from "@monarch/design-engine";
import { executeApplyPlan } from "@monarch/discord";
import { hasPermission, Permission, createLogger } from "@monarch/shared";
import { assertSameOrigin, jsonError, requireGuildAccess } from "@/lib/api";
import { fetchCurrentDesign, getGateway } from "@/lib/discord";
import { getStore, newId } from "@/lib/store";

const log = createLogger("api.apply");

const Body = z.object({
  design: ServerDesignSchema,
  /** Client must acknowledge deletions explicitly. */
  confirmDestructive: z.boolean().default(false),
  snapshotName: z.string().max(100).optional(),
});

/**
 * POST /api/guilds/:guildId/apply
 *
 * The only route that mutates Discord structure. Pipeline:
 * permission check → validation → fresh diff → destructive confirmation →
 * pre-apply snapshot → execute plan → post-apply snapshot → audit →
 * clear draft (on success).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const { guildId } = await params;
  const access = await requireGuildAccess(guildId);
  if (!access.ok) return access.response;
  const { session, guild } = access.ctx;

  // Bot-side permission check (user-side already done by requireGuildAccess).
  if (!guild.botPermissions || !hasPermission(guild.botPermissions, Permission.ManageChannels)) {
    return jsonError(409, {
      code: "bot.permissions",
      message: "Monarch can't manage channels in this server.",
      reason: "The Monarch bot is missing the Manage Channels permission.",
      fix: "Grant Monarch the Manage Channels permission in Server Settings → Roles.",
    });
  }

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return jsonError(400, { code: "apply.invalid", message: "The design payload is invalid." });
  }
  const desired = body.data.design;
  if (desired.guildId !== guildId) {
    return jsonError(400, { code: "apply.wrong-guild", message: "This design belongs to a different server." });
  }

  const validation = validateServerDesign(desired);
  if (!validation.valid) {
    return jsonError(422, {
      code: "apply.validation",
      message: "The design has validation errors that must be fixed before applying.",
      detail: validation.errors,
    });
  }

  // Always diff against FRESH Discord state right before applying.
  const current = await fetchCurrentDesign(guildId);
  if (!current) {
    return jsonError(502, { code: "guild.state", message: "Monarch couldn't read this server's structure." });
  }
  const diff = diffServerDesign(current, desired);
  if (diff.isEmpty) {
    return NextResponse.json({ ok: true, applied: false, message: "No changes to apply.", steps: [] });
  }
  const plan = planApply(diff);
  if (plan.destructive && !body.data.confirmDestructive) {
    return jsonError(409, {
      code: "apply.needs-confirmation",
      message: `This apply deletes ${diff.deletes.length} item(s) and requires explicit confirmation.`,
    });
  }

  const store = getStore();
  await store.addSnapshot({
    id: newId("snap"),
    guildId,
    name: body.data.snapshotName?.trim() || "Before apply",
    kind: "pre-apply",
    design: current,
    createdAt: new Date().toISOString(),
  });

  log.info("applying design", {
    guildId,
    userId: session.userId,
    steps: plan.steps.length,
    destructive: plan.destructive,
  });
  const result = await executeApplyPlan(getGateway(), plan, desired);

  const after = await fetchCurrentDesign(guildId);
  if (result.ok && after) {
    await store.addSnapshot({
      id: newId("snap"),
      guildId,
      name: body.data.snapshotName?.trim() || "Applied design",
      kind: "post-apply",
      design: after,
      createdAt: new Date().toISOString(),
    });
    await store.deleteDraft(guildId, session.userId);
  }

  await store.addAudit({
    id: newId("audit"),
    guildId,
    userId: session.userId,
    action: "design.apply",
    summary: `${result.ok ? "Applied" : "Partially applied"} ${plan.steps.length} change(s): ` +
      `+${diff.creates.length} ~${diff.modifies.length + diff.renames.length + diff.moves.length} -${diff.deletes.length}`,
    createdAt: new Date().toISOString(),
  });

  return NextResponse.json({
    ok: result.ok,
    applied: true,
    steps: result.steps,
    createdIds: result.createdIds,
    current: after,
  });
}
