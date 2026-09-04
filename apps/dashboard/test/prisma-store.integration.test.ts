import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer as PGLiteSocketServerType } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { emptyServerDesign } from "@monarch/schemas";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { PrismaStore } from "@/lib/prisma-store";

// vitest's SSR transform redirects bare-specifier requires/imports of this
// package to a processed instance whose re-exported class goes missing;
// importing the resolved .cjs entry via a file:// URL goes through Node's
// native loader instead and works everywhere.
async function loadSocketServer() {
  const resolved = createRequire(import.meta.url).resolve("@electric-sql/pglite-socket");
  const mod = (await import(pathToFileURL(resolved).href)) as typeof import("@electric-sql/pglite-socket");
  return mod.PGLiteSocketServer;
}

/**
 * Integration test: the full MonarchStore contract against a real PostgreSQL
 * (PGlite — Postgres compiled to WASM) exposed over the actual PG wire
 * protocol, with Prisma connecting through the same pg driver adapter used
 * in production. The committed initial migration is applied first, so this
 * also proves prisma/migrations is valid and complete.
 */

let pglite: PGlite;
let server: PGLiteSocketServerType;
let connectionString: string;
let prisma: PrismaClient;
let store: PrismaStore;

beforeAll(async () => {
  pglite = new PGlite();
  const migrationDir = path.resolve(__dirname, "../../../prisma/migrations");
  const lock = readFileSync(path.join(migrationDir, "migration_lock.toml"), "utf8");
  expect(lock).toContain("postgresql");
  const sql = readFileSync(path.join(migrationDir, "20260902000000_init", "migration.sql"), "utf8");
  for (const stmt of sql.split(";").map((s) => s.replace(/--[^\n]*/g, "").trim()).filter(Boolean)) {
    await pglite.exec(stmt);
  }

  const SocketServer = await loadSocketServer();
  server = new SocketServer({ db: pglite, host: "127.0.0.1", port: 0, maxConnections: 10 });
  await server.start();
  // getServerConn() returns "host:port" after start (port 0 → ephemeral).
  const hostPort = server.getServerConn();
  connectionString = `postgresql://postgres:postgres@${hostPort}/postgres`;

  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 1 }) });
  store = new PrismaStore(prisma);
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect().catch(() => {});
  await server?.stop().catch(() => {});
});

describe("PrismaStore against PostgreSQL (PGlite)", () => {
  it("round-trips a session and encrypts the OAuth token at rest", async () => {
    const session = {
      id: "sess_test_1",
      userId: "123456789012345678",
      username: "monarchfan",
      avatarUrl: "https://cdn.discordapp.com/avatars/1/abc.png",
      accessToken: "MTOK_plaintext-oauth-token",
      createdAt: new Date("2026-09-02T10:00:00.000Z").toISOString(),
    };
    await store.putSession(session);

    const raw = await pglite.query<{ accessTokenEnc: string | null }>(
      `SELECT "accessTokenEnc" FROM "Session" WHERE id = 'sess_test_1'`,
    );
    const storedToken = raw.rows[0]!.accessTokenEnc;
    expect(storedToken).toBeTruthy();
    expect(storedToken).not.toContain("MTOK_plaintext");
    expect(storedToken!.startsWith("v1.")).toBe(true);

    const loaded = await store.getSession("sess_test_1");
    expect(loaded).toEqual(session);
  });

  it("returns null for missing or expired sessions and cleans them up", async () => {
    expect(await store.getSession("sess_missing")).toBeNull();

    await pglite.exec(`
      INSERT INTO "User" ("id", "username") VALUES ('expired-user', 'ghost');
      INSERT INTO "Session" ("id", "userId", "expiresAt")
      VALUES ('sess_expired', 'expired-user', NOW() - INTERVAL '1 day');
    `);
    expect(await store.getSession("sess_expired")).toBeNull();
    const rows = await pglite.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "Session" WHERE id = 'sess_expired'`);
    expect(rows.rows[0]!.n).toBe(0);
    await store.deleteSession("sess_expired"); // idempotent
  });

  it("round-trips and deletes per-user drafts (one per guild+user)", async () => {
    const design = emptyServerDesign("987654321", "Monarch HQ");
    await store.putDraft("123456789012345678", {
      guildId: "987654321",
      design,
      baseDesign: design,
      updatedAt: "2026-09-02T12:00:00.000Z",
    });
    expect(await store.getDraft("987654321", "123456789012345678")).toEqual({
      guildId: "987654321",
      design,
      baseDesign: design,
      updatedAt: "2026-09-02T12:00:00.000Z",
    });

    const design2 = emptyServerDesign("987654321", "Monarch HQ");
    await store.putDraft("123456789012345678", {
      guildId: "987654321",
      design: design2,
      baseDesign: design2,
      updatedAt: "2026-09-02T13:00:00.000Z",
    });
    const drafts = await pglite.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "DesignDraft"`);
    expect(drafts.rows[0]!.n).toBe(1); // upsert, not duplicate
    expect((await store.getDraft("987654321", "123456789012345678"))!.updatedAt).toBe("2026-09-02T13:00:00.000Z");

    await store.deleteDraft("987654321", "123456789012345678");
    expect(await store.getDraft("987654321", "123456789012345678")).toBeNull();
    await store.deleteDraft("987654321", "123456789012345678"); // idempotent
  });

  it("lists snapshots newest-first", async () => {
    const base = { id: "", guildId: "987654321", name: "", kind: "manual" as const, design: emptyServerDesign("987654321", "Monarch HQ"), createdAt: "" };
    await store.addSnapshot({ ...base, id: "snap_old", name: "manual", createdAt: "2026-09-01T00:00:00.000Z" });
    await store.addSnapshot({ ...base, id: "snap_pre", name: "before apply", kind: "pre-apply", createdAt: "2026-09-02T00:00:00.000Z" });
    await store.addSnapshot({ ...base, id: "snap_post", name: "after apply", kind: "post-apply", createdAt: "2026-09-03T00:00:00.000Z" });

    const snapshots = await store.listSnapshots("987654321");
    expect(snapshots.map((s) => s.id)).toEqual(["snap_post", "snap_pre", "snap_old"]);
    expect(snapshots[0]!.kind).toBe("post-apply");
  });

  it("defaults guild settings to empty and persists designated channels", async () => {
    expect(await store.getGuildSettings("987654321")).toEqual({ guildId: "987654321", designatedChannels: {} });

    await store.putGuildSettings({
      guildId: "987654321",
      designatedChannels: { welcome: "111", templateTesting: "222" },
    });
    expect(await store.getGuildSettings("987654321")).toEqual({
      guildId: "987654321",
      designatedChannels: { welcome: "111", templateTesting: "222" },
    });

    // clearing channels clears columns
    await store.putGuildSettings({ guildId: "987654321", designatedChannels: {} });
    expect(await store.getGuildSettings("987654321")).toEqual({ guildId: "987654321", designatedChannels: {} });
  });

  it("records and lists audit entries newest-first with a limit", async () => {
    for (let i = 0; i < 5; i++) {
      await store.addAudit({
        id: `audit_${i}`,
        guildId: "987654321",
        userId: "123456789012345678",
        action: "apply",
        summary: `apply #${i}`,
        createdAt: new Date(Date.UTC(2026, 8, 2, 0, i)).toISOString(),
      });
    }
    const all = await store.listAudit("987654321");
    expect(all.map((a) => a.id)).toEqual(["audit_4", "audit_3", "audit_2", "audit_1", "audit_0"]);
    expect((await store.listAudit("987654321", 2)).map((a) => a.id)).toEqual(["audit_4", "audit_3"]);
  });

  it("persists demo-mode mock Discord state as a singleton", async () => {
    expect(await store.getMockState()).toBeNull();
    const state = {
      guilds: {
        "987654321": {
          id: "987654321",
          name: "Monarch HQ",
          memberCount: 42,
          botInstalled: true,
          botPermissions: "8",
          design: emptyServerDesign("987654321", "Monarch HQ"),
          outbox: [],
        },
      },
    };
    await store.putMockState(state);
    expect(await store.getMockState()).toEqual(state);
    const rows = await pglite.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "MockDiscordState"`);
    expect(rows.rows[0]!.n).toBe(1);
  });

  it("cascades guild deletion to dependent rows (schema FK behavior)", async () => {
    await pglite.exec(`DELETE FROM "Guild" WHERE id = '987654321'`);
    expect(await store.listSnapshots("987654321")).toEqual([]);
    expect((await store.listAudit("987654321")).length).toBe(0);
    expect(await store.getGuildSettings("987654321")).toEqual({ guildId: "987654321", designatedChannels: {} });
  });
});
