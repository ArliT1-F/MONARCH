/**
 * Snapshot retention.
 *
 * Every apply writes two snapshots (the `pre-apply` undo point and the
 * `post-apply` record), and both stores kept them forever: the file store
 * rewrites the entire `snapshots.json` — every guild's full designs — on each
 * add, and the history page reads all of it back. Unbounded growth made the
 * one feature that exists to make applying safe progressively slower, and it
 * was the only record type in the store with no cap (audit rows keep the last
 * 2000).
 *
 * The rule is deliberately simple and explainable from the UI:
 *
 *  - `manual` snapshots (a "Backup" the user asked for, by name) are never
 *    pruned automatically — deleting somebody's restore point on a schedule
 *    is not Monarch's call to make.
 *  - automatic ones (`pre-apply` / `post-apply`) keep the newest
 *    {@link AUTO_SNAPSHOT_LIMIT_PER_KIND} **per kind**, so the most recent
 *    undo point and the most recent "what was applied" record always survive
 *    together however lopsided the two streams are.
 *  - anything written within {@link PRUNE_GRACE_MS} survives, so pruning can
 *    never eat the snapshot the apply currently running just took.
 *
 * Pure and dependency-free on purpose: `FileStore` and `PrismaStore` both call
 * it, and neither should have to import the other to agree on the rule.
 */

export const AUTO_SNAPSHOT_LIMIT_PER_KIND = 25;
export const PRUNE_GRACE_MS = 60_000;

/** The columns a retention decision needs — never the design payload itself. */
export interface PrunableSnapshot {
  id: string;
  /** "manual" | "pre-apply" | "post-apply" (SnapshotRecord["kind"]). */
  kind: string;
  /** ISO-8601, as stored on SnapshotRecord.createdAt. */
  createdAt: string;
}

/** Newest first, deterministic when two rows share a timestamp. */
function byNewest(a: PrunableSnapshot, b: PrunableSnapshot): number {
  const byTime = b.createdAt.localeCompare(a.createdAt);
  return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
}

/**
 * Ids to delete from ONE guild's snapshots. Callers pass what they already
 * have in hand: the file store its array, Prisma an `{ id, kind, createdAt }`
 * projection — so no full design JSON is read just to decide what to drop.
 */
export function snapshotIdsToPrune(
  guildSnapshots: PrunableSnapshot[],
  options: { limitPerKind?: number; now?: number; graceMs?: number } = {},
): string[] {
  const limit = options.limitPerKind ?? AUTO_SNAPSHOT_LIMIT_PER_KIND;
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? PRUNE_GRACE_MS;

  const kept: Record<string, number> = {};
  const doomed: string[] = [];
  for (const snapshot of [...guildSnapshots].sort(byNewest)) {
    const automatic = snapshot.kind !== "manual";
    const tooOldToRescue = now - Date.parse(snapshot.createdAt) > graceMs;
    const overLimit = (kept[snapshot.kind] ?? 0) >= limit;
    if (!automatic || !tooOldToRescue || !overLimit) {
      kept[snapshot.kind] = (kept[snapshot.kind] ?? 0) + 1;
      continue;
    }
    doomed.push(snapshot.id);
  }
  return doomed;
}
