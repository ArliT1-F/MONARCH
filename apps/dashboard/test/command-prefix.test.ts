import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DEFAULT_COMMAND_PREFIX } from "@monarch/shared";

/**
 * Prefix commands, dashboard side: the bot reads and writes a server's prefix
 * through `/api/internal/guilds/:id/prefix` with INTERNAL_API_TOKEN. These
 * tests run the real route handlers against the FileStore — the same shape as
 * backups.test.ts — because the guarantees that matter live there:
 *
 * - the prefix survives a restart (it's stored, not remembered);
 * - it can't be clobbered by the designated-channels settings form;
 * - an illegal prefix is refused with a message the bot can show a human;
 * - without the internal token the route is closed, exactly like the other
 *   bot-facing routes.
 */
const dataDir = mkdtempSync(path.join(tmpdir(), "monarch-prefix-"));
process.env.MONARCH_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
process.env.INTERNAL_API_TOKEN = "test-internal-token";

// lib/store imports the Postgres backend statically. It is never constructed
// here (no DATABASE_URL → FileStore), so it's stubbed — that also keeps the
// suite runnable where the generated Prisma client isn't available.
vi.mock("@/lib/prisma-store", () => ({ PrismaStore: class {} }));

const { GET, PUT } = await import("@/app/api/internal/guilds/[guildId]/prefix/route");
const { getStore } = await import("@/lib/store");

const GUILD = "900000000000000001";

function request(body?: unknown, token: string | null = "test-internal-token") {
  return new NextRequest("http://localhost:3000/api/internal/guilds/" + GUILD + "/prefix", {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ guildId: GUILD }) };

beforeEach(async () => {
  await getStore().putCommandPrefix(GUILD, null);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("command prefix store", () => {
  it("defaults to null (the shared default prefix)", async () => {
    expect(await getStore().getCommandPrefix(GUILD)).toBeNull();
    expect(await getStore().getCommandPrefix("some-other-guild")).toBeNull();
  });

  it("round-trips a prefix per guild", async () => {
    await getStore().putCommandPrefix(GUILD, "m!");
    await getStore().putCommandPrefix("111111111111111111", ">>");

    expect(await getStore().getCommandPrefix(GUILD)).toBe("m!");
    expect(await getStore().getCommandPrefix("111111111111111111")).toBe(">>");

    await getStore().putCommandPrefix(GUILD, null);
    expect(await getStore().getCommandPrefix(GUILD)).toBeNull();
    expect(await getStore().getCommandPrefix("111111111111111111")).toBe(">>");
  });

  it("is untouched by the designated-channels settings form", async () => {
    await getStore().putCommandPrefix(GUILD, "?");
    // The settings PUT rewrites the whole GuildSettingsRecord — the prefix
    // lives outside it on purpose (same rule as the analyzer dismissals).
    await getStore().putGuildSettings({
      guildId: GUILD,
      designatedChannels: { testing: "555555555555555555" },
    });

    expect(await getStore().getCommandPrefix(GUILD)).toBe("?");
    const settings = await getStore().getGuildSettings(GUILD);
    expect(settings.designatedChannels.testing).toBe("555555555555555555");
    expect((settings as unknown as Record<string, unknown>).commandPrefix).toBeUndefined();
  });
});

describe("GET /api/internal/guilds/:id/prefix", () => {
  it("reports the default until one is saved", async () => {
    const res = await GET(request(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      prefix: DEFAULT_COMMAND_PREFIX,
      customized: false,
      default: DEFAULT_COMMAND_PREFIX,
      maxLength: expect.any(Number),
    });
  });

  it("reports a saved prefix as customized", async () => {
    await getStore().putCommandPrefix(GUILD, "m!");
    const res = await GET(request(), params);
    expect(await res.json()).toMatchObject({ prefix: "m!", customized: true });
  });

  it("is closed without the internal token", async () => {
    expect((await GET(request(undefined, null), params)).status).toBe(401);
    expect((await GET(request(undefined, "wrong"), params)).status).toBe(401);
  });
});

describe("PUT /api/internal/guilds/:id/prefix", () => {
  it("saves a legal prefix", async () => {
    const res = await PUT(request({ prefix: ">>" }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, prefix: ">>", customized: true });
    expect(await getStore().getCommandPrefix(GUILD)).toBe(">>");
  });

  it("normalizes case so matching stays case-insensitive", async () => {
    const res = await PUT(request({ prefix: "M!" }), params);
    expect(await res.json()).toMatchObject({ prefix: "m!" });
    expect(await getStore().getCommandPrefix(GUILD)).toBe("m!");
  });

  it("resets to the default with null", async () => {
    await getStore().putCommandPrefix(GUILD, "m!");
    const res = await PUT(request({ prefix: null }), params);
    expect(await res.json()).toEqual({ ok: true, prefix: DEFAULT_COMMAND_PREFIX, customized: false });
    expect(await getStore().getCommandPrefix(GUILD)).toBeNull();
  });

  it("refuses a prefix that would swallow ordinary words", async () => {
    for (const bad of ["hey", "h", "@", "/", "a b", "!!!!!", ""]) {
      const res = await PUT(request({ prefix: bad }), params);
      expect(res.status, `${bad} should be refused`).toBe(400);
      // jsonError nests under `error` — the shape every Monarch API error uses.
      const body = (await res.json()) as { error: { code: string; message: string; fix?: string } };
      expect(body.error.code).toBe("prefix.invalid");
      expect(body.error.message.length).toBeGreaterThan(0);
    }
    expect(await getStore().getCommandPrefix(GUILD)).toBeNull();
  });

  it("refuses a malformed payload", async () => {
    expect((await PUT(request({}), params)).status).toBe(400);
    expect((await PUT(request({ prefix: 42 }), params)).status).toBe(400);
  });

  it("is closed without the internal token", async () => {
    const res = await PUT(request({ prefix: "?" }, null), params);
    expect(res.status).toBe(401);
    expect(await getStore().getCommandPrefix(GUILD)).toBeNull();
  });
});
