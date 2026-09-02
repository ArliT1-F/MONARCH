import type { ServerDesign } from "@monarch/schemas";
import type { ServerDiff, DiffEntry } from "./diff.js";

/**
 * Apply planning: orders diff entries into safe, sequential steps.
 *
 * Order matters on Discord:
 *   1. create categories        (channels may need their parent)
 *   2. create channels
 *   3. renames / modifications
 *   4. moves (parent + position sync)
 *   5. deletions last (and only after explicit confirmation)
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

export function planApply(diff: ServerDiff): ApplyPlan {
  const actionable = diff.entries.filter((e) => e.op !== "unsupported");
  const sorted = [...actionable].sort((a, b) => {
    const byOp = (opOrder[a.op] ?? 9) - (opOrder[b.op] ?? 9);
    if (byOp !== 0) return byOp;
    // categories before channels for creates; channels before categories for deletes
    const catFirst = a.op === "delete" ? 1 : -1;
    if (a.resource !== b.resource) {
      return a.resource === "category" ? catFirst : -catFirst;
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
  const label = e.resource === "category" ? "category" : e.resource;
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
  };
}
