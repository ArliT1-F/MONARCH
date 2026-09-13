import { describe, expect, it, vi } from "vitest";
import { CONFESSION_COOLDOWN_MS } from "@monarch/shared";
import { decryptSecret, encryptSecret } from "@/lib/secure-token";
import {
  PrismaStore,
  auditRowToRecord,
  confessionCooldownRowToRecord,
  designatedChannelsToColumns,
  draftRowToRecord,
  isUniqueViolation,
  sessionRowToRecord,
  settingsRowToRecord,
  snapshotRowToRecord,
  templateRowToRecord,
} from "@/lib/prisma-store";

/**
 * Pure row ↔ record mappers + token encryption, no database involved — plus
 * the confession cooldown's compare-and-set, driven against a fake delegate
 * (below), because that is the one piece of store logic whose *control flow*
 * matters: two racing claims must produce exactly one winner. The real
 * database version lives in prisma-store.integration.test.ts.
 */

describe("secure-token (AES-256-GCM)", () => {
  it("round-trips a token", () => {
    const token = "MTOKEN_secret-oauth-token-12345";
    const stored = encryptSecret(token);
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain(token);
    expect(decryptSecret(stored)).toBe(token);
  });

  it("never stores plaintext components", () => {
    const stored = encryptSecret("super-secret");
    const parts = stored.split(".");
    expect(parts).toHaveLength(4);
    expect(parts.every((p) => !p.toLowerCase().includes("secret"))).toBe(true);
  });

  it("produces distinct ciphertexts for the same input (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("returns undefined for absent, malformed, or tampered values", () => {
    expect(decryptSecret(null)).toBeUndefined();
    expect(decryptSecret(undefined)).toBeUndefined();
    expect(decryptSecret("garbage")).toBeUndefined();
    const stored = encryptSecret("super-secret-token");
    const parts = stored.split(".");
    const flipped = [parts[0], parts[1], parts[2], Buffer.from("tampered!").toString("base64url")].join(".");
    expect(decryptSecret(flipped)).toBeUndefined();
  });
});

describe("row → record mappers", () => {
  it("maps sessions, omitting absent OAuth tokens", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    expect(
      sessionRowToRecord(
        { id: "sess_1", userId: "u1", accessTokenEnc: null, createdAt, expiresAt: new Date(createdAt.getTime() + 1000) },
        { id: "u1", username: "alice", avatarUrl: null },
      ),
    ).toEqual({ id: "sess_1", userId: "u1", username: "alice", avatarUrl: null, createdAt: createdAt.toISOString() });
  });

  it("maps drafts (Json columns cast to ServerDesign)", () => {
    const updatedAt = new Date("2026-02-02T00:00:00.000Z");
    const design = { guildId: "g1", channels: [] } as never;
    const record = draftRowToRecord({ guildId: "g1", userId: "u1", design, baseDesign: design, updatedAt });
    expect(record.guildId).toBe("g1");
    expect(record.design).toBe(design);
    expect(record.updatedAt).toBe(updatedAt.toISOString());
  });

  it("maps snapshots with kind preserved", () => {
    const createdAt = new Date("2026-03-03T00:00:00.000Z");
    const record = snapshotRowToRecord({
      id: "snap_1", guildId: "g1", name: "before apply", kind: "pre-apply",
      design: { guildId: "g1" } as never, createdAt,
    });
    expect(record.kind).toBe("pre-apply");
    expect(record.createdAt).toBe(createdAt.toISOString());
  });

  it("maps guild settings both ways", () => {
    const row = {
      guildId: "g1",
      welcomeChannelId: "123",
      announcementsChannelId: null,
      testingChannelId: "456",
      templateTestingChannelId: null,
    };
    expect(settingsRowToRecord(row)).toEqual({
      guildId: "g1",
      designatedChannels: { welcome: "123", testing: "456" },
    });
    expect(settingsRowToRecord(null)).toEqual({ guildId: "", designatedChannels: {} });

    expect(designatedChannelsToColumns({ welcome: "123", testing: "456" })).toEqual({
      welcomeChannelId: "123",
      announcementsChannelId: null,
      testingChannelId: "456",
      templateTestingChannelId: null,
    });
    expect(designatedChannelsToColumns({})).toEqual({
      welcomeChannelId: null,
      announcementsChannelId: null,
      testingChannelId: null,
      templateTestingChannelId: null,
    });
  });

  it("maps audit entries", () => {
    const createdAt = new Date("2026-04-04T00:00:00.000Z");
    expect(
      auditRowToRecord({ id: "a1", guildId: "g1", userId: "u1", action: "apply", summary: "Applied 2 changes", createdAt }),
    ).toEqual({
      id: "a1", guildId: "g1", userId: "u1", action: "apply", summary: "Applied 2 changes", createdAt: createdAt.toISOString(),
    });
  });

  it("maps template rows (FEATURE 7) and tolerates a null payload", () => {
    const createdAt = new Date("2026-05-05T00:00:00.000Z");
    const updatedAt = new Date("2026-05-06T00:00:00.000Z");
    const data = { categories: [], channels: [], roles: [] };
    const record = templateRowToRecord({
      id: "tpl_1", ownerId: "u1", name: "Starter", type: "server", format: 1,
      data, createdAt, updatedAt,
    });
    expect(record).toEqual({
      id: "tpl_1", ownerId: "u1", name: "Starter", type: "server", format: 1,
      data, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
    });
    expect(templateRowToRecord({
      id: "tpl_2", ownerId: "u1", name: "Empty", type: "server", format: 1,
      data: null, createdAt, updatedAt,
    }).data).toEqual({});
  });
});

// ── confession cooldowns (compare-and-set) ───────────────────────────

type CooldownRow = { userId: string; nextAllowedAt: Date };

/** Prisma's P2002, the way the client raises it: a duplicate key. */
function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed on the fields: (`userId`)"), { code: "P2002" });
}

/**
 * A stand-in for the generated `confessionCooldown` delegate: an in-memory
 * table with Prisma's semantics for the three calls the store makes —
 * `updateMany` honouring its `lte` filter and reporting a count, `findUnique`,
 * and `create` failing with P2002 when the row appeared in the meantime.
 */
function fakeCooldownTable(rows: CooldownRow[] = []) {
  const table = new Map(rows.map((row) => [row.userId, row]));
  const delegate = {
    updateMany: vi.fn(async (args: any) => {
      const row = table.get(args.where.userId);
      if (!row) return { count: 0 };
      const lte = args.where.nextAllowedAt?.lte as Date | undefined;
      if (lte && row.nextAllowedAt.getTime() > lte.getTime()) return { count: 0 };
      row.nextAllowedAt = args.data.nextAllowedAt;
      return { count: 1 };
    }),
    findUnique: vi.fn(async (args: any) => {
      const row = table.get(args.where.userId);
      return row ? { userId: row.userId, nextAllowedAt: row.nextAllowedAt } : null;
    }),
    create: vi.fn(async (args: any) => {
      if (table.has(args.data.userId)) throw uniqueViolation();
      const row = { userId: args.data.userId, nextAllowedAt: args.data.nextAllowedAt };
      table.set(row.userId, row);
      return row;
    }),
    delete: vi.fn(async (args: any) => {
      const row = table.get(args.where.userId);
      if (!row) throw Object.assign(new Error("Record to delete does not exist."), { code: "P2025" });
      table.delete(args.where.userId);
      return row;
    }),
  };
  const store = new PrismaStore({ confessionCooldown: delegate } as never);
  return { store, table, delegate };
}

const USER = "555000000000000001";
const NOW = new Date("2026-09-13T12:00:00.000Z");

describe("confessionCooldownRowToRecord", () => {
  it("reports a running window and reads an expired one as free", () => {
    const until = new Date(NOW.getTime() + 60_000);
    expect(confessionCooldownRowToRecord(USER, { userId: USER, nextAllowedAt: until }, NOW)).toEqual({
      userId: USER,
      nextAllowedAt: until.toISOString(),
    });
    expect(confessionCooldownRowToRecord(USER, { userId: USER, nextAllowedAt: until }, new Date(until.getTime() + 1))).toEqual({
      userId: USER,
      nextAllowedAt: null,
    });
    expect(confessionCooldownRowToRecord(USER, null, NOW)).toEqual({ userId: USER, nextAllowedAt: null });
    // A window that ends exactly now is already over.
    expect(confessionCooldownRowToRecord(USER, { userId: USER, nextAllowedAt: until }, until).nextAllowedAt).toBeNull();
  });
});

describe("isUniqueViolation", () => {
  it("recognises Prisma's P2002 and nothing else", () => {
    expect(isUniqueViolation(uniqueViolation())).toBe(true);
    expect(isUniqueViolation({ code: "P2025" })).toBe(false);
    expect(isUniqueViolation(new Error("connection lost"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe("PrismaStore.claimConfessionCooldown", () => {
  it("creates the row when the person has none", async () => {
    const { store, table, delegate } = fakeCooldownTable();
    const claim = await store.claimConfessionCooldown(USER, { now: NOW });

    expect(claim.claimed).toBe(true);
    expect(Date.parse(claim.nextAllowedAt) - NOW.getTime()).toBe(CONFESSION_COOLDOWN_MS);
    expect(table.get(USER)?.nextAllowedAt.toISOString()).toBe(claim.nextAllowedAt);
    expect(delegate.create).toHaveBeenCalledOnce();
  });

  it("refuses while a window is running, and leaves the row alone", async () => {
    const until = new Date(NOW.getTime() + 5 * 60 * 60 * 1000);
    const { store, table, delegate } = fakeCooldownTable([{ userId: USER, nextAllowedAt: until }]);

    const claim = await store.claimConfessionCooldown(USER, { now: NOW });
    expect(claim).toEqual({ claimed: false, nextAllowedAt: until.toISOString() });
    expect(table.get(USER)?.nextAllowedAt).toBe(until); // neither shortened nor extended
    expect(delegate.create).not.toHaveBeenCalled();
  });

  it("flips an expired row instead of inserting a second one", async () => {
    const expired = new Date(NOW.getTime() - 1_000);
    const { store, table, delegate } = fakeCooldownTable([{ userId: USER, nextAllowedAt: expired }]);

    const claim = await store.claimConfessionCooldown(USER, { now: NOW });
    expect(claim.claimed).toBe(true);
    expect(table.size).toBe(1);
    expect(table.get(USER)?.nextAllowedAt.toISOString()).toBe(claim.nextAllowedAt);
    expect(delegate.updateMany).toHaveBeenCalledOnce();
    expect(delegate.create).not.toHaveBeenCalled();
  });

  it("loses a create race and reports the winner's window", async () => {
    const { store, table, delegate } = fakeCooldownTable();
    const winner = new Date(NOW.getTime() + CONFESSION_COOLDOWN_MS);
    // Somebody else's claim lands between our findUnique and our create.
    delegate.create.mockImplementationOnce(async () => {
      table.set(USER, { userId: USER, nextAllowedAt: winner });
      throw uniqueViolation();
    });

    const claim = await store.claimConfessionCooldown(USER, { now: NOW });
    expect(claim).toEqual({ claimed: false, nextAllowedAt: winner.toISOString() });
    expect(delegate.updateMany).toHaveBeenCalledTimes(2); // the retry after P2002
    expect(table.get(USER)?.nextAllowedAt).toBe(winner); // untouched by the loser
  });

  it("rethrows anything that isn't a duplicate key", async () => {
    const { store, delegate } = fakeCooldownTable();
    delegate.create.mockRejectedValueOnce(new Error("connection lost"));
    await expect(store.claimConfessionCooldown(USER, { now: NOW })).rejects.toThrow("connection lost");
  });

  it("defaults to the shared six hour window", async () => {
    const { store } = fakeCooldownTable();
    const before = Date.now();
    const claim = await store.claimConfessionCooldown(USER);
    expect(claim.claimed).toBe(true);
    expect(Date.parse(claim.nextAllowedAt) - before).toBeGreaterThan(CONFESSION_COOLDOWN_MS - 5_000);
    expect(Date.parse(claim.nextAllowedAt) - before).toBeLessThanOrEqual(CONFESSION_COOLDOWN_MS);
  });
});

describe("PrismaStore confession cooldown reads and releases", () => {
  it("reads a live window, an expired one and a missing one", async () => {
    const until = new Date(Date.now() + 60_000);
    const { store, table } = fakeCooldownTable([{ userId: USER, nextAllowedAt: until }]);
    expect(await store.getConfessionCooldown(USER)).toEqual({ userId: USER, nextAllowedAt: until.toISOString() });

    table.set(USER, { userId: USER, nextAllowedAt: new Date(Date.now() - 1) });
    expect(await store.getConfessionCooldown(USER)).toEqual({ userId: USER, nextAllowedAt: null });

    table.delete(USER);
    expect(await store.getConfessionCooldown(USER)).toEqual({ userId: USER, nextAllowedAt: null });
  });

  it("releases a window, and swallows a release with nothing to delete", async () => {
    const { store, table, delegate } = fakeCooldownTable([{ userId: USER, nextAllowedAt: new Date(Date.now() + 60_000) }]);
    await store.releaseConfessionCooldown(USER);
    expect(table.has(USER)).toBe(false);
    expect(delegate.delete).toHaveBeenCalledOnce();

    await expect(store.releaseConfessionCooldown(USER)).resolves.toBeUndefined(); // P2025 is not an error here
  });
});
