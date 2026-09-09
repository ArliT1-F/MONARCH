import type { ServerDesign } from "@monarch/schemas";
import type { ServerDiff, DiffEntry } from "./diff.js";

/**
 * Apply planning: orders diff entries into safe, sequential steps.
 *
 * Order matters on Discord:
 *   1. create categories        (channels may need their parent)
 *   2. create channels
 *   3. create roles             (independent of channels)
 *   4. renames / modifications
 *   5. moves (parent + position sync)
 *   6. deletions last (and only after explicit confirmation)
 *
 * The plan is consumed by the executor in @monarch/discord, which resolves
 * `new_*` local ids to real snowflakes as creations complete.
 */
export interface ApplyStep {
  entry: DiffEntry;
  /** Human-readable description shown in progress UI / audit log. */
  describe: string;
}

export interface ApplyPlan {
  guildId: string;
  steps: ApplyStep[];
  destructive: boolean;
}

const opOrder: Record<string, number> = {
  create: 0,
  rename: 2,
  modify: 2,
  move: 3,
  delete: 4,
  unsupported: 5,
};

/** Stable resource ordering within the same op bucket:
 *  categories → channels → roles (creates, renames, modifies, moves).
 *  For deletes, the order is the opposite: roles → channels → categories
 *  (so we never tear down a parent before its children).
 */
function resourceRank(op: string, resource: string): number {
  const creates = ["category", "channel", "role"];
  const deletes = ["role", "channel", "category"];
  const order = op === "delete" ? deletes : creates;
  return order.indexOf(resource);
}

export function planApply(diff: ServerDiff): ApplyPlan {
  const actionable = diff.entries.filter((e) => e.op !== "unsupported");
  const sorted = [...actionable].sort((a, b) => {
    const byOp = (opOrder[a.op] ?? 9) - (opOrder[b.op] ?? 9);
    if (byOp !== 0) return byOp;
    if (a.resource !== b.resource) {
      return resourceRank(a.op, a.resource) - resourceRank(b.op, b.resource);
    }
    return 0;
  });

  const steps: ApplyStep[] = sorted.map((entry) => ({ entry, describe: describeEntry(entry) }));
  return {
    guildId: diff.guildId,
    steps,
    destructive: diff.deletes.length > 0,
  };
}

export function describeEntry(e: DiffEntry): string {
  const label =
    e.resource === "category" ? "category" : e.resource === "channel" ? "channel" : e.resource;
  switch (e.op) {
    case "create":
      return `Create ${label} "${e.name}"`;
    case "rename":
      return `Rename ${label} "${e.before}" → "${e.after}"`;
    case "modify":
      return `Update ${label} "${e.name}" (${e.changes.map((c) => c.field).join(", ")})`;
    case "move":
      return `Move ${label} "${e.name}"`;
    case "delete":
      return `Delete ${label} "${e.name}"`;
    case "unsupported":
      return `Skip "${e.name}" — ${e.reason}`;
  }
}

/** Positions the desired design implies, used to sync ordering after moves. */
export function desiredPositions(design: ServerDesign) {
  return {
    categories: design.categories.map((c) => ({ id: c.id, position: c.position })),
    channels: design.channels.map((c) => ({
      id: c.id,
      position: c.position,
      parentId: c.parentId ?? null,
    })),
    roles: design.roles.map((r) => ({ id: r.id, position: r.position })),
  };
}
