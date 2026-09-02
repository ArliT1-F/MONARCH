import type { ServerDesign } from "@monarch/schemas";
import type { ApplyPlan } from "@monarch/design-engine";
import { desiredPositions, describeEntry } from "@monarch/design-engine";
import { isLocalId, createLogger, type MonarchError } from "@monarch/shared";
import type { DiscordGateway } from "./gateway.js";

const log = createLogger("discord.executor");

/**
 * Apply executor: walks an ApplyPlan sequentially through the gateway.
 *
 * - Sequential on purpose: order is semantic (parents before children,
 *   deletes last) and @discordjs/rest already queues/rate-limits requests.
 * - Local `new_*` ids are resolved to real snowflakes as creations finish,
 *   so channels created inside a newly created category land correctly.
 * - Stops on the first error and reports exactly which steps succeeded,
 *   so a re-run only re-applies what's left (the diff is recomputed from
 *   fresh state by the caller).
 */
export interface ApplyStepResult {
  describe: string;
  status: "done" | "failed" | "skipped";
  error?: MonarchError;
}

export interface ApplyResult {
  ok: boolean;
  steps: ApplyStepResult[];
  /** Map of local ids → created snowflakes (for draft rebasing). */
  createdIds: Record<string, string>;
}

export async function executeApplyPlan(
  gateway: DiscordGateway,
  plan: ApplyPlan,
  desired: ServerDesign,
): Promise<ApplyResult> {
  const results: ApplyStepResult[] = [];
  const createdIds: Record<string, string> = {};
  const resolveId = (id: string) => (isLocalId(id) ? createdIds[id] : id);

  let failed = false;

  for (const step of plan.steps) {
    if (failed) {
      results.push({ describe: step.describe, status: "skipped" });
      continue;
    }
    const e = step.entry;
    let error: MonarchError | undefined;

    switch (e.op) {
      case "create": {
        if (e.resource === "category") {
          const res = await gateway.createCategory(plan.guildId, {
            name: e.name,
            position: (e.detail as { position?: number }).position,
          });
          if (res.ok) createdIds[e.localId] = res.value.id;
          else error = res.error;
        } else if (e.resource === "channel") {
          const detail = e.detail as {
            type: string; topic?: string; parentId?: string; nsfw?: boolean; slowmode?: number; position?: number;
          };
          const parentId = detail.parentId ? resolveId(detail.parentId) : undefined;
          const res = await gateway.createChannel(plan.guildId, {
            name: e.name,
            kind: detail.type,
            topic: detail.topic,
            parentId,
            nsfw: detail.nsfw,
            slowmode: detail.slowmode,
            position: detail.position,
          });
          if (res.ok) createdIds[e.localId] = res.value.id;
          else error = res.error;
        }
        break;
      }
      case "rename": {
        const res = await gateway.modifyChannel(plan.guildId, e.id, {
          name: e.after,
          ...changesToPayload(e.changes),
        });
        if (!res.ok) error = res.error;
        break;
      }
      case "modify": {
        const res = await gateway.modifyChannel(plan.guildId, e.id, changesToPayload(e.changes));
        if (!res.ok) error = res.error;
        break;
      }
      case "move": {
        const toParent = e.toParent ? (resolveId(e.toParent) ?? null) : null;
        const res = await gateway.modifyChannel(plan.guildId, e.id, {
          parentId: toParent,
          position: e.toPosition,
        });
        if (!res.ok) error = res.error;
        break;
      }
      case "delete": {
        const res = await gateway.deleteChannel(plan.guildId, e.id);
        if (!res.ok) error = res.error;
        break;
      }
      case "unsupported":
        results.push({ describe: describeEntry(e), status: "skipped" });
        continue;
    }

    if (error) {
      failed = true;
      log.error("apply step failed", { guildId: plan.guildId, step: step.describe, code: error.code });
      results.push({ describe: step.describe, status: "failed", error });
    } else {
      results.push({ describe: step.describe, status: "done" });
    }
  }

  // Final position sync so ordering matches the design exactly.
  if (!failed) {
    const positions = desiredPositions(desired);
    for (const cat of positions.categories) {
      const id = resolveId(cat.id);
      if (id) await gateway.modifyChannel(plan.guildId, id, { position: cat.position });
    }
    for (const ch of positions.channels) {
      const id = resolveId(ch.id);
      if (id) await gateway.modifyChannel(plan.guildId, id, { position: ch.position });
    }
  }

  return { ok: !failed, steps: results, createdIds };
}

function changesToPayload(changes: { field: string; after: unknown }[]) {
  const payload: { topic?: string | null; nsfw?: boolean; slowmode?: number } = {};
  for (const c of changes) {
    if (c.field === "topic") payload.topic = (c.after as string | undefined) ?? null;
    if (c.field === "nsfw") payload.nsfw = Boolean(c.after);
    if (c.field === "slowmode") payload.slowmode = (c.after as number | undefined) ?? 0;
  }
  return payload;
}
