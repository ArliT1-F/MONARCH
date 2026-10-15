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
  /** Idempotency key for safe retries (optional but recommended). */
  idempotencyKey: z.string().optional(),
});

/**
 * POST /api/guilds/:guildId/apply
 *
 * The only route that mutates Discord structure. Pipeline:
 * permission check → validation → fresh diff → destructive confirmation →
 * pre-apply snapshot → execute plan → post-apply snapshot → audit →
 * clear draft (on success).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ guildId: string }> }) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const { guildId } = await params;
  const access = await requireGuildAccess(guildId);
  if (!access.ok) return access.response;
  const { session, guild } = access.ctx;

  // Bot-side permission check (user-side already done by requireGuildAccess).
  // `hasPermission` treats the Administrator bit as granting every
  // permission, exactly like Discord. We only hard-block when we POSITIVELY
  // know Manage Channels is missing; if Discord's info can't be fetched we
  // try anyway and Discord enforces its own rules (a 403 comes back as a
  // translated, human-readable error from the executor).
  let botPermissions = guild.botPermissions ?? null;
  if (!botPermissions) {
    const fresh = await getGateway().getBotGuildInfo(guildId);
    botPermissions = fresh?.botPermissions ?? null;
    if (!botPermissions) {
      log.warn("bot permissions unknown at apply time — letting Discord enforce", { guildId });
    }
  }
  if (botPermissions && !hasPermission(botPermissions, Permission.ManageChannels)) {
    return jsonError(409, {
      code: "bot.permissions",
      message: "Monarch can't manage channels in this server.",
      reason: "The Monarch bot is missing Manage Channels (Administrator also satisfies this).",
      fix: "Grant Monarch the Manage Channels permission — or Administrator — in Server Settings → Roles.",
    });
  }

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return jsonError(400, { code: "apply.invalid", message: "The design payload is invalid." });
  }
  const desired = body.data.design;
  if (desired.guildId !== guildId) {
    return jsonError(400, {
      code: "apply.wrong-guild",
      message: "This design belongs to a different server.",
    });
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
    return jsonError(502, {
      code: "guild.state",
      message: "Monarch couldn't read this server's structure.",
    });
  }
  const diff = diffServerDesign(current, desired);
  if (diff.isEmpty) {
    return NextResponse.json({
      ok: true,
      applied: false,
      message: "No changes to apply.",
      steps: [],
    });
  }

  // Role mutations require Manage Roles. We only block when we POSITIVELY
  // know it's missing; an unknown-permissions bot tries anyway and Discord
  // enforces at the role step (translated, human-readable error from the
  // executor — same pattern as the channel check above).
  const hasRoleChanges = diff.entries.some((e) => e.resource === "role" && e.op !== "unsupported");
  if (hasRoleChanges && botPermissions && !hasPermission(botPermissions, Permission.ManageRoles)) {
    return jsonError(409, {
      code: "bot.permissions",
      message: "Monarch can't manage roles in this server.",
      reason: "Your draft includes role changes, and the Monarch bot is missing Manage Roles.",
      fix: "Grant Monarch the Manage Roles permission — or Administrator — in Server Settings → Roles.",
    });
  }

  const plan = planApply(diff);
  if (plan.destructive && !body.data.confirmDestructive) {
    return jsonError(409, {
      code: "apply.needs-confirmation",
      message: `This apply deletes ${diff.deletes.length} item(s) and requires explicit confirmation.`,
    });
  }

  const store = getStore();
  const idempotencyKey = body.data.idempotencyKey ?? newId("idemp");

  // Durable operation claim (idempotency + concurrency guard).
  const claimResult = await store.claimApplyOperation(guildId, session.userId, idempotencyKey);
  if (!claimResult.claimed) {
    const existing = claimResult.existing;
    return NextResponse.json({
      ok: existing?.status === "completed",
      applied: false,
      message: "A concurrent apply operation is in progress for this server.",
      operationId: existing?.id,
      status: existing?.status,
      idempotencyKey,
    });
  }

  const operationId = newId("op");
  let operationRecord: import("@/lib/store").OperationRecord = {
    id: operationId,
    guildId,
    userId: session.userId,
    idempotencyKey,
    action: "design.apply",
    status: "pending",
    planDigest: JSON.stringify(plan),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.putOperation(operationRecord);

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
    operationId,
    idempotencyKey,
  });

  let persistenceWarning: { auditFailed?: boolean; snapshotFailed?: boolean; message?: string } | undefined;

  try {
    const result = await executeApplyPlan(getGateway(), plan, desired);
    const after = await fetchCurrentDesign(guildId);

    // Update durable operation with step results and reconciliation.
    const updatedOp: import("@/lib/store").OperationRecord = {
      ...operationRecord,
      status: result.ok ? "completed" : (after ? "uncertain" : "failed"),
      stepResults: result.steps.map((s) => ({
        describe: s.describe,
        status: s.status,
        error: s.error ? { code: s.error.code, message: s.error.message } : undefined,
      })),
      reconciledDesign: after ?? undefined,
      updatedAt: new Date().toISOString(),
    };
    await store.putOperation(updatedOp);
    operationRecord = updatedOp;

    let auditFailed = false;
    let auditEntryId: string | undefined;
    try {
      const auditId = newId("audit");
      auditEntryId = auditId;
      await store.addAudit({
        id: auditId,
        guildId,
        userId: session.userId,
        action: "design.apply",
        summary: applySummary(plan, result),
        createdAt: new Date().toISOString(),
      });
    } catch (auditError) {
      auditFailed = true;
      log.error("audit persistence failed after apply", { guildId, operationId, error: auditError });
    }

    if (result.ok && after) {
      let snapshotFailed = false;
      try {
        await store.addSnapshot({
          id: newId("snap"),
          guildId,
          name: body.data.snapshotName?.trim() || "Applied design",
          kind: "post-apply",
          design: after,
          createdAt: new Date().toISOString(),
        });
      } catch (snapError) {
        snapshotFailed = true;
        log.error("post-apply snapshot persistence failed", { guildId, operationId, error: snapError });
      }

      // Only delete the draft if both Discord mutation and persistence succeeded.
      if (!auditFailed && !snapshotFailed) {
        await store.deleteDraft(guildId, session.userId);
      } else {
        persistenceWarning = {
          auditFailed,
          snapshotFailed,
          message: auditFailed || snapshotFailed ? "The apply completed, but some persistence records could not be saved. The draft has been preserved for review." : undefined,
        };
      }
    } else {
      // Partial or failed apply: keep the draft so the user can review and retry.
      persistenceWarning = {
        message: !result.ok ? "The apply did not complete. The draft has been preserved. Review the step results and try again." : undefined,
      };
    }

    // Update operation with audit entry reference.
    const finalOp: import("@/lib/store").OperationRecord = {
      ...operationRecord,
      status: result.ok ? "completed" : (after ? "uncertain" : "failed"),
      auditEntryId,
      stepResults: result.steps.map((s) => ({
        describe: s.describe,
        status: s.status,
        error: s.error ? { code: s.error.code, message: s.error.message } : undefined,
      })),
      reconciledDesign: after ?? undefined,
      updatedAt: new Date().toISOString(),
    };
    await store.putOperation(finalOp);
    operationRecord = finalOp;

    return NextResponse.json({
      ok: result.ok,
      applied: true,
      steps: result.steps,
      createdIds: result.createdIds,
      current: after,
      persistenceWarning,
      operationId,
      idempotencyKey,
    });
  } catch (executeError) {
    // Unexpected execution failure: update durable operation, do not delete draft.
    const errorOp: import("@/lib/store").OperationRecord = {
      ...operationRecord,
      status: "failed",
      stepResults: [{ describe: "Unexpected execution failure", status: "failed", error: { code: "execute.exception", message: String(executeError) } }],
      updatedAt: new Date().toISOString(),
    };
    await store.putOperation(errorOp);
    operationRecord = errorOp;
      stepResults: [{ describe: "Unexpected execution failure", status: "failed", error: { code: "execute.exception", message: String(executeError) } }],
      updatedAt: new Date().toISOString(),
    });
    persistenceWarning = { message: "The apply encountered an unexpected error. The draft has been preserved." };
    log.error("unexpected apply execution failure", { guildId, operationId, error: executeError });
    return NextResponse.json({
      ok: false,
      applied: false,
      message: "The apply encountered an unexpected error.",
      persistenceWarning,
      operationId,
      idempotencyKey,
    });
  }
}

/**
 * Audit summary. Counts what the executor ACTUALLY completed (a failed
 * apply stops at the first error and skips the rest — reporting the full
 * diff would overstate what changed). result.steps is index-aligned with
 * plan.steps by construction. Format:
 * `Applied: +a ~b -c (channels +c ~c -c · roles +r ~r -r)`
 * or, on failure, `Partially applied (N of M steps): …`
 */
function applySummary(
  plan: ReturnType<typeof planApply>,
  result: Awaited<ReturnType<typeof executeApplyPlan>>,
): string {
  const done = plan.steps.filter((_, i) => result.steps[i]?.status === "done");
  const c = (op: string, resource: string) =>
    done.filter((s) => s.entry.op === op && s.entry.resource === resource).length;
  const breakdown = (resource: string) =>
    `+${c("create", resource)} ~${c("modify", resource) + c("rename", resource) + c("move", resource)} -${c("delete", resource)}`;
  const totals = done.reduce(
    (acc, s) => {
      if (s.entry.op === "create") acc.created += 1;
      else if (s.entry.op === "delete") acc.deleted += 1;
      else if (s.entry.op !== "unsupported") acc.changed += 1;
      return acc;
    },
    { created: 0, changed: 0, deleted: 0 },
  );
  const prefix = result.ok
    ? "Applied"
    : `Partially applied (${done.length} of ${plan.steps.length} steps)`;
  return (
    `${prefix}: +${totals.created} ~${totals.changed} -${totals.deleted}` +
    ` (channels ${breakdown("channel")} · roles ${breakdown("role")})`
  );
}
