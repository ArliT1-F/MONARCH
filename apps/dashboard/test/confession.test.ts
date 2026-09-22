import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { CONFESSION_COOLDOWN_MS } from "@monarch/shared";

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
const {
  GET: cooldownGET,
  POST: cooldownPOST,
  DELETE: cooldownDELETE,
} = await import("@/app/api/internal/users/[userId]/confession-cooldown/route");
const { getStore } = await import("@/lib/store");

const GUILD = "900000000000000001";
const CHANNEL = "500000000000000001";
const LOG_CHANNEL = "400000000000000001";
/** The confessor: cooldowns are keyed by user id, never by guild. */
const USER = "700000000000000001";
const OTHER_USER = "700000000000000002";

function cooldownRequest(
  method: "GET" | "POST" | "DELETE",
  userId: string = USER,
  token: string | null = "test-internal-token",
) {
  return new NextRequest(`http://localhost:3000/api/internal/users/${userId}/confession-cooldown`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const cooldownParams = (userId: string = USER) => ({ params: Promise.resolve({ userId }) });

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
  await getStore().releaseConfessionCooldown(USER);
  await getStore().releaseConfessionCooldown(OTHER_USER);
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

// ── the six hour cooldown ────────────────────────────────────────────
//
// One window per Discord user, global across every server: the bot claims it
// just before posting a confession and releases it again when the post fails.

describe("confession cooldown store", () => {
  it("is free by default", async () => {
    expect(await getStore().getConfessionCooldown(USER)).toEqual({ userId: USER, nextAllowedAt: null });
  });

  it("claims a six hour window and refuses the next claim", async () => {
    const before = Date.now();
    const first = await getStore().claimConfessionCooldown(USER);
    expect(first.claimed).toBe(true);

    const until = Date.parse(first.nextAllowedAt);
    // Both bounds carry a tolerance: `before` is read just ahead of the claim,
    // so the window is the cooldown plus however long the claim itself took.
    expect(until - before).toBeGreaterThan(CONFESSION_COOLDOWN_MS - 5_000);
    expect(until - before).toBeLessThanOrEqual(CONFESSION_COOLDOWN_MS + 5_000);
    expect(CONFESSION_COOLDOWN_MS).toBe(6 * 60 * 60 * 1000);

    const second = await getStore().claimConfessionCooldown(USER);
    expect(second.claimed).toBe(false);
    expect(second.nextAllowedAt).toBe(first.nextAllowedAt); // a refused claim extends nothing
    expect((await getStore().getConfessionCooldown(USER)).nextAllowedAt).toBe(first.nextAllowedAt);
  });

  it("is one window per person, not per guild", async () => {
    // The record carries no guild id at all — confessing in one server is
    // what makes the person wait in every other server too.
    await getStore().claimConfessionCooldown(USER);
    expect(Object.keys(await getStore().getConfessionCooldown(USER))).toEqual(["userId", "nextAllowedAt"]);
    expect((await getStore().claimConfessionCooldown(OTHER_USER)).claimed).toBe(true);
  });

  it("releases a window so the person can confess again at once", async () => {
    await getStore().claimConfessionCooldown(USER);
    await getStore().releaseConfessionCooldown(USER);
    expect(await getStore().getConfessionCooldown(USER)).toEqual({ userId: USER, nextAllowedAt: null });
    expect((await getStore().claimConfessionCooldown(USER)).claimed).toBe(true);
  });

  it("releasing nothing is not an error", async () => {
    await expect(getStore().releaseConfessionCooldown(USER)).resolves.toBeUndefined();
  });

  it("treats an expired window as free and claims over it", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await getStore().claimConfessionCooldown(USER, { now: sevenHoursAgo });
    expect(await getStore().getConfessionCooldown(USER)).toEqual({ userId: USER, nextAllowedAt: null });
    const reclaimed = await getStore().claimConfessionCooldown(USER);
    expect(reclaimed.claimed).toBe(true);
    expect(Date.parse(reclaimed.nextAllowedAt)).toBeGreaterThan(Date.now());
  });

  it("honours an explicit window (tests, and nothing else)", async () => {
    const claimed = await getStore().claimConfessionCooldown(USER, { windowMs: 60_000 });
    expect(claimed.claimed).toBe(true);
    expect(Date.parse(claimed.nextAllowedAt) - Date.now()).toBeLessThanOrEqual(60_000);
    expect((await getStore().claimConfessionCooldown(USER)).claimed).toBe(false);
  });
});

describe("GET /api/internal/users/:id/confession-cooldown", () => {
  it("reports a free person as ready", async () => {
    const res = await cooldownGET(cooldownRequest("GET"), cooldownParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: USER,
      nextAllowedAt: null,
      ready: true,
      cooldownMs: CONFESSION_COOLDOWN_MS,
    });
  });

  it("reports a running window instead", async () => {
    await getStore().claimConfessionCooldown(USER);
    const res = await cooldownGET(cooldownRequest("GET"), cooldownParams());
    const data = (await res.json()) as { ready: boolean; nextAllowedAt: string; cooldownMs: number };
    expect(data.ready).toBe(false);
    expect(Date.parse(data.nextAllowedAt)).toBeGreaterThan(Date.now());
    expect(data.cooldownMs).toBe(CONFESSION_COOLDOWN_MS);
  });

  it("refuses a user id that is not a snowflake", async () => {
    const res = await cooldownGET(cooldownRequest("GET", "not-a-user"), cooldownParams("not-a-user"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("confession.invalid-user");
  });

  it("is closed without the internal token", async () => {
    expect((await cooldownGET(cooldownRequest("GET", USER, null), cooldownParams())).status).toBe(401);
    expect((await cooldownGET(cooldownRequest("GET", USER, "wrong"), cooldownParams())).status).toBe(401);
  });
});

describe("POST /api/internal/users/:id/confession-cooldown", () => {
  it("claims the window and stores it", async () => {
    const res = await cooldownPOST(cooldownRequest("POST"), cooldownParams());
    expect(res.status).toBe(200);
    const data = (await res.json()) as { claimed: boolean; nextAllowedAt: string; retryAfterMs: number };
    expect(data.claimed).toBe(true);
    expect(data.retryAfterMs).toBeGreaterThan(CONFESSION_COOLDOWN_MS - 10_000);
    expect((await getStore().getConfessionCooldown(USER)).nextAllowedAt).toBe(data.nextAllowedAt);
  });

  it("answers 'not yet' with the running window — 200, not an error", async () => {
    const first = await cooldownPOST(cooldownRequest("POST"), cooldownParams());
    const firstData = (await first.json()) as { nextAllowedAt: string };

    const second = await cooldownPOST(cooldownRequest("POST"), cooldownParams());
    expect(second.status).toBe(200);
    const data = (await second.json()) as { claimed: boolean; nextAllowedAt: string; retryAfterMs: number };
    expect(data.claimed).toBe(false);
    expect(data.nextAllowedAt).toBe(firstData.nextAllowedAt);
    expect(data.retryAfterMs).toBeGreaterThan(0);
  });

  it("is closed without the internal token", async () => {
    expect((await cooldownPOST(cooldownRequest("POST", USER, null), cooldownParams())).status).toBe(401);
    expect((await getStore().getConfessionCooldown(USER)).nextAllowedAt).toBeNull();
  });
});

describe("DELETE /api/internal/users/:id/confession-cooldown", () => {
  it("releases a claimed window so the next claim wins", async () => {
    await cooldownPOST(cooldownRequest("POST"), cooldownParams());
    const res = await cooldownDELETE(cooldownRequest("DELETE"), cooldownParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, userId: USER });

    const ready = await cooldownGET(cooldownRequest("GET"), cooldownParams());
    expect(((await ready.json()) as { ready: boolean }).ready).toBe(true);
    expect(
      ((await (await cooldownPOST(cooldownRequest("POST"), cooldownParams())).json()) as { claimed: boolean }).claimed,
    ).toBe(true);
  });

  it("is a no-op for somebody with no window", async () => {
    expect((await cooldownDELETE(cooldownRequest("DELETE"), cooldownParams())).status).toBe(200);
  });

  it("is closed without the internal token", async () => {
    expect((await cooldownDELETE(cooldownRequest("DELETE", USER, null), cooldownParams())).status).toBe(401);
  });
});
