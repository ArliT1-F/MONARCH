import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Confessions, dashboard side: the bot reads and writes a server's confession
 * channels through `/api/internal/guilds/:id/confession` with
 * INTERNAL_API_TOKEN. These tests run the real route handlers against the
 * FileStore (same shape as command-prefix.test.ts), because the guarantees
 * that matter live there:
 *
 * - the setup survives a restart (it's stored, not remembered);
 * - it can't be clobbered by the designated-channels settings form;
 * - a channel id that isn't a snowflake is refused with a message the bot
 *   can show a human;
 * - the log channel can never be pointed at the confession channel (it
 *   would name every confessor);
 * - without the internal token the route is closed, exactly like the other
 *   bot-facing routes.
 */
const dataDir = mkdtempSync(path.join(tmpdir(), "monarch-confession-"));
process.env.MONARCH_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
process.env.INTERNAL_API_TOKEN = "test-internal-token";

// lib/store imports the Postgres backend statically. It is never constructed
// here (no DATABASE_URL → FileStore), so it's stubbed — that also keeps the
// suite runnable where the generated Prisma client isn't available.
vi.mock("@/lib/prisma-store", () => ({ PrismaStore: class {} }));

const { GET, PUT } = await import("@/app/api/internal/guilds/[guildId]/confession/route");
const { getStore } = await import("@/lib/store");

const GUILD = "900000000000000001";
const CHANNEL = "500000000000000001";
const LOG_CHANNEL = "400000000000000001";

function request(body?: unknown, token: string | null = "test-internal-token") {
  return new NextRequest("http://localhost:3000/api/internal/guilds/" + GUILD + "/confession", {
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
  await getStore().putConfessionChannels(GUILD, { guildId: GUILD, channelId: null, logChannelId: null });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("confession channel store", () => {
  it("defaults to off (no channels)", async () => {
    expect(await getStore().getConfessionChannels(GUILD)).toEqual({
      guildId: GUILD,
      channelId: null,
      logChannelId: null,
    });
    expect(await getStore().getConfessionChannels("some-other-guild")).toMatchObject({
      guildId: "some-other-guild",
      channelId: null,
    });
  });

  it("round-trips both channels per guild", async () => {
    await getStore().putConfessionChannels(GUILD, { guildId: GUILD, channelId: CHANNEL, logChannelId: LOG_CHANNEL });
    await getStore().putConfessionChannels("111111111111111111", {
      guildId: "111111111111111111",
      channelId: "222222222222222222",
      logChannelId: null,
    });

    expect(await getStore().getConfessionChannels(GUILD)).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
      logChannelId: LOG_CHANNEL,
    });
    expect(await getStore().getConfessionChannels("111111111111111111")).toEqual({
      guildId: "111111111111111111",
      channelId: "222222222222222222",
      logChannelId: null,
    });

    await getStore().putConfessionChannels(GUILD, { guildId: GUILD, channelId: null, logChannelId: null });
    expect(await getStore().getConfessionChannels(GUILD)).toMatchObject({ channelId: null, logChannelId: null });
    // The other guild is untouched.
    expect(await getStore().getConfessionChannels("111111111111111111")).toMatchObject({ channelId: "222222222222222222" });
  });

  it("is untouched by the designated-channels settings form", async () => {
    await getStore().putConfessionChannels(GUILD, { guildId: GUILD, channelId: CHANNEL, logChannelId: LOG_CHANNEL });
    // The settings PUT rewrites the whole GuildSettingsRecord — the
    // confession channels live outside it on purpose (same rule as the
    // command prefix).
    await getStore().putGuildSettings({
      guildId: GUILD,
      designatedChannels: { testing: "555555555555555555" },
    });

    expect(await getStore().getConfessionChannels(GUILD)).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
      logChannelId: LOG_CHANNEL,
    });
    const settings = await getStore().getGuildSettings(GUILD);
    expect(settings.designatedChannels.testing).toBe("555555555555555555");
    expect((settings as unknown as Record<string, unknown>).confessionChannelId).toBeUndefined();
  });
});

describe("GET /api/internal/guilds/:id/confession", () => {
  it("reports off until something is saved", async () => {
    const res = await GET(request(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ channelId: null, logChannelId: null });
  });

  it("reports the saved channels", async () => {
    await getStore().putConfessionChannels(GUILD, { guildId: GUILD, channelId: CHANNEL, logChannelId: LOG_CHANNEL });
    const res = await GET(request(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ channelId: CHANNEL, logChannelId: LOG_CHANNEL });
  });

  it("is closed without the internal token", async () => {
    expect((await GET(request(undefined, null), params)).status).toBe(401);
    expect((await GET(request(undefined, "wrong"), params)).status).toBe(401);
  });
});

describe("PUT /api/internal/guilds/:id/confession", () => {
  it("saves a configuration", async () => {
    const res = await PUT(request({ channelId: CHANNEL, logChannelId: LOG_CHANNEL }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, channelId: CHANNEL, logChannelId: LOG_CHANNEL });
    expect(await getStore().getConfessionChannels(GUILD)).toMatchObject({ channelId: CHANNEL, logChannelId: LOG_CHANNEL });
  });

  it("turns the feature off with both nulls", async () => {
    await getStore().putConfessionChannels(GUILD, { guildId: GUILD, channelId: CHANNEL, logChannelId: LOG_CHANNEL });
    const res = await PUT(request({ channelId: null, logChannelId: null }), params);
    expect(res.status).toBe(200);
    expect(await getStore().getConfessionChannels(GUILD)).toMatchObject({ channelId: null, logChannelId: null });
  });

  it("refuses a channel id that is not a snowflake", async () => {
    const res = await PUT(request({ channelId: "not-a-channel", logChannelId: null }), params);
    expect(res.status).toBe(400);
    expect(await getStore().getConfessionChannels(GUILD)).toMatchObject({ channelId: null });
  });

  it("refuses the log channel when it is the confession channel", async () => {
    const res = await PUT(request({ channelId: CHANNEL, logChannelId: CHANNEL }), params);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("confession.same-channel");
    expect(await getStore().getConfessionChannels(GUILD)).toMatchObject({ channelId: null });
  });

  it("is closed without the internal token", async () => {
    expect((await PUT(request({ channelId: CHANNEL, logChannelId: null }, null), params)).status).toBe(401);
  });
});
