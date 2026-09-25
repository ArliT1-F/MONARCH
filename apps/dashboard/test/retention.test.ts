import { describe, expect, it } from "vitest";
import { AUTO_SNAPSHOT_LIMIT_PER_KIND, snapshotIdsToPrune } from "@/lib/retention";

/**
 * Snapshot retention (lib/retention.ts) — the pure rule both stores share.
 * The store-level wiring is exercised by backups.test.ts, which runs the real
 * FileStore; this file pins the rule itself, including the two properties that
 * matter to a user: a named backup is never silently deleted, and the snapshot
 * an apply just wrote can never be pruned by that same apply.
 */

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
/** `count` snapshots ending at `now`, oldest first, 1h apart. */
function make(
  count: number,
  kind: "manual" | "pre-apply" | "post-apply",
  at: (i: number) => number = (i) => NOW - (count - i) * 3_600_000,
) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${kind}-${i}`,
    kind,
    createdAt: new Date(at(i)).toISOString(),
  }));
}

describe("snapshot retention", () => {
  it("keeps everything while the cap has headroom", () => {
    const snapshots = make(AUTO_SNAPSHOT_LIMIT_PER_KIND, "pre-apply");
    expect(snapshotIdsToPrune(snapshots, { now: NOW })).toEqual([]);
  });

  it("drops the oldest automatic snapshots beyond the cap", () => {
    const snapshots = make(AUTO_SNAPSHOT_LIMIT_PER_KIND + 3, "pre-apply");
    const doomed = snapshotIdsToPrune(snapshots, { now: NOW }).sort();
    expect(doomed).toEqual(["pre-apply-0", "pre-apply-1", "pre-apply-2"]);
    // The newest one always survives.
    expect(doomed).not.toContain(`pre-apply-${snapshots.length - 1}`);
  });

  it("counts each kind separately", () => {
    const snapshots = [
      ...make(AUTO_SNAPSHOT_LIMIT_PER_KIND + 1, "pre-apply"),
      ...make(
        AUTO_SNAPSHOT_LIMIT_PER_KIND + 1,
        "post-apply",
        (i) => NOW - (AUTO_SNAPSHOT_LIMIT_PER_KIND + 1 - i) * 3_600_000,
      ),
    ];
    const doomed = snapshotIdsToPrune(snapshots, { now: NOW }).sort();
    expect(doomed).toEqual(["post-apply-0", "pre-apply-0"]);
  });

  it("never prunes a named backup, however old", () => {
    const ancient = make(500, "manual", () => NOW - 400 * 24 * 3_600_000);
    expect(snapshotIdsToPrune(ancient, { now: NOW })).toEqual([]);
  });

  it("rescues anything inside the grace window, so an apply cannot eat its own snapshot", () => {
    // 30 identical-timestamp writes (a script applying in a loop): all are
    // "now", so all are kept even though only 25 would survive once aged.
    const fresh = make(30, "pre-apply", () => NOW);
    expect(snapshotIdsToPrune(fresh, { now: NOW })).toEqual([]);
    expect(snapshotIdsToPrune(fresh, { now: NOW + 120_000 })).toHaveLength(5);
  });

  it("is deterministic when timestamps collide", () => {
    const tied = [
      { id: "a", kind: "pre-apply", createdAt: new Date(NOW).toISOString() },
      { id: "b", kind: "pre-apply", createdAt: new Date(NOW).toISOString() },
      { id: "c", kind: "pre-apply", createdAt: new Date(NOW).toISOString() },
    ];
    const once = snapshotIdsToPrune(tied, { now: NOW + 120_000, limitPerKind: 1 });
    const twice = snapshotIdsToPrune(tied.slice().reverse(), {
      now: NOW + 120_000,
      limitPerKind: 1,
    });
    expect(once).toEqual(twice);
    expect(once).toEqual(expect.arrayContaining(["a", "b"]));
    expect(once).not.toContain("c");
  });

  it("ignores ids it was not shown (guild scoping is the caller's job)", () => {
    const mine = make(AUTO_SNAPSHOT_LIMIT_PER_KIND + 2, "pre-apply");
    const doomed = snapshotIdsToPrune(mine, { now: NOW });
    expect(doomed.every((id) => id.startsWith("pre-apply-"))).toBe(true);
    expect(doomed).toHaveLength(2);
  });
});
