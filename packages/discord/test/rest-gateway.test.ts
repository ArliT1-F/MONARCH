import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RestDiscordGateway.getBotGuildInfo — regression coverage for the bug where
 * Publish in the Embed/Message designer failed with "Monarch isn't installed
 * in this server" for servers the bot WAS in.
 *
 * Root cause: the gateway requested `GET /guilds/:id/members/@me`. Discord
 * has no such endpoint (it only exists as PATCH for nickname changes); the
 * GET 404s, the catch-all returned null, and the Target Resolver read null as
 * "bot not installed". The fix resolves the bot's real user id from
 * `/users/@me` and only reports "not installed" for definitive Discord
 * answers — transient failures degrade to "permissions unknown" instead.
 */

const rest = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@discordjs/rest", () => ({
  REST: vi.fn(() => ({ setToken: () => rest })),
}));

import { RestDiscordGateway } from "../src/rest-gateway.js";
import { resolveTarget } from "../src/target-resolver.js";
import { isNotInGuildError } from "../src/errors.js";

class FakeDiscordError extends Error {
  constructor(
    readonly status: number,
    readonly code?: number,
  ) {
    super(`discord ${status}${code ? ` (${code})` : ""}`);
  }
}

const BOT_ID = "1234567890";
const GUILD = "9876543210";

function routeMock(handlers: Record<string, () => unknown>) {
  rest.get.mockImplementation(async (route: string) => {
    const handler = handlers[route];
    if (!handler) throw new Error(`unexpected route ${route}`);
    return handler();
  });
}

beforeEach(() => {
  rest.get.mockReset();
});

describe("RestDiscordGateway.getBotGuildInfo", () => {
  it("fetches the bot's own member via its real user id, never /members/@me", async () => {
    const gw = new RestDiscordGateway("token");
    routeMock({
      "/users/%40me": () => ({ id: BOT_ID }),
      [`/guilds/${GUILD}/members/${BOT_ID}`]: () => ({ roles: ["r1"], permissions: "8" }),
      [`/guilds/${GUILD}/roles`]: () => [
        { id: "r1", permissions: "8", position: 5 },
        { id: GUILD, permissions: "1024", position: 0 },
      ],
    });

    const info = await gw.getBotGuildInfo(GUILD);
    expect(info).toEqual({ id: GUILD, botPermissions: "8", botHighestRolePosition: 5 });

    const routes = rest.get.mock.calls.map((c) => c[0]);
    expect(routes).not.toContain(`/guilds/${GUILD}/members/@me`);
    expect(routes).toContain(`/guilds/${GUILD}/members/${BOT_ID}`);
  });

  it("resolves the bot user id once and reuses it across guilds", async () => {
    const gw = new RestDiscordGateway("token");
    const member = () => ({ roles: [], permissions: "3072" });
    routeMock({
      "/users/%40me": () => ({ id: BOT_ID }),
      [`/guilds/${GUILD}/members/${BOT_ID}`]: member,
      [`/guilds/${GUILD}/roles`]: () => [],
      [`/guilds/other/members/${BOT_ID}`]: member,
      "/guilds/other/roles": () => [],
    });

    await gw.getBotGuildInfo(GUILD);
    await gw.getBotGuildInfo("other");
    const meCalls = rest.get.mock.calls.filter((c) => c[0] === "/users/%40me");
    expect(meCalls).toHaveLength(1);
  });

  it("returns null (not installed) for a definitive Unknown Member / Unknown Guild", async () => {
    const gw = new RestDiscordGateway("token");
    routeMock({
      "/users/%40me": () => ({ id: BOT_ID }),
      [`/guilds/${GUILD}/members/${BOT_ID}`]: () => {
        throw new FakeDiscordError(404, 10007);
      },
    });
    expect(await gw.getBotGuildInfo(GUILD)).toBeNull();
  });

  it("returns null for Missing Access (bot kicked / no access)", async () => {
    const gw = new RestDiscordGateway("token");
    routeMock({
      "/users/%40me": () => ({ id: BOT_ID }),
      [`/guilds/${GUILD}/members/${BOT_ID}`]: () => {
        throw new FakeDiscordError(403, 50001);
      },
    });
    expect(await gw.getBotGuildInfo(GUILD)).toBeNull();
  });

  it("degrades to permissions-unknown on a transient failure instead of 'not installed'", async () => {
    const gw = new RestDiscordGateway("token");
    routeMock({
      "/users/%40me": () => ({ id: BOT_ID }),
      [`/guilds/${GUILD}/members/${BOT_ID}`]: () => {
        throw new FakeDiscordError(429);
      },
    });
    const info = await gw.getBotGuildInfo(GUILD);
    expect(info).not.toBeNull();
    expect(info?.botPermissions).toBeNull();
  });

  it("falls back to member.permissions when the roles read fails", async () => {
    const gw = new RestDiscordGateway("token");
    routeMock({
      "/users/%40me": () => ({ id: BOT_ID }),
      [`/guilds/${GUILD}/members/${BOT_ID}`]: () => ({ roles: ["r1"], permissions: "3072" }),
      [`/guilds/${GUILD}/roles`]: () => {
        throw new FakeDiscordError(500);
      },
    });
    const info = await gw.getBotGuildInfo(GUILD);
    expect(info?.botPermissions).toBe("3072");
  });

  it("does not cache a failed /users/@me lookup", async () => {
    const gw = new RestDiscordGateway("token");
    let meAttempts = 0;
    routeMock({
      "/users/%40me": () => {
        meAttempts += 1;
        if (meAttempts === 1) throw new FakeDiscordError(503);
        return { id: BOT_ID };
      },
      [`/guilds/${GUILD}/members/${BOT_ID}`]: () => ({ roles: [], permissions: "8" }),
      [`/guilds/${GUILD}/roles`]: () => [],
    });

    const first = await gw.getBotGuildInfo(GUILD);
    expect(first?.botPermissions).toBeNull(); // transient → unknown, not "missing"
    const second = await gw.getBotGuildInfo(GUILD);
    expect(second?.botPermissions).toBe("8");
    expect(meAttempts).toBe(2);
  });
});

describe("resolveTarget with the REST gateway", () => {
  const guildRoutes = (memberHandler: () => unknown) => ({
    "/users/%40me": () => ({ id: BOT_ID }),
    [`/guilds/${GUILD}`]: () => ({ id: GUILD, name: "Guild" }),
    [`/guilds/${GUILD}/channels`]: () => [
      { id: "c1", name: "announcements", type: 0, position: 0 },
    ],
    [`/guilds/${GUILD}/roles`]: () => [{ id: GUILD, name: "@everyone", color: 0, position: 0, managed: false, hoist: false, mentionable: false, permissions: "3072" }],
    [`/guilds/${GUILD}/members/${BOT_ID}`]: memberHandler,
  });

  it("publishes to an explicit channel when the bot is installed (the reported bug)", async () => {
    const gw = new RestDiscordGateway("token");
    routeMock(guildRoutes(() => ({ roles: [], permissions: "3072" })));
    const res = await resolveTarget(gw, GUILD, { kind: "explicit", guildId: GUILD, channelId: "c1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.channelName).toBe("announcements");
  });

  it("does not block publishing when permissions are temporarily unknown", async () => {
    const gw = new RestDiscordGateway("token");
    routeMock(
      guildRoutes(() => {
        throw new FakeDiscordError(429);
      }),
    );
    const res = await resolveTarget(gw, GUILD, { kind: "explicit", guildId: GUILD, channelId: "c1" });
    expect(res.ok).toBe(true);
  });

  it("still reports target.bot-missing when Discord says the bot is not a member", async () => {
    const gw = new RestDiscordGateway("token");
    routeMock(
      guildRoutes(() => {
        throw new FakeDiscordError(404, 10007);
      }),
    );
    const res = await resolveTarget(gw, GUILD, { kind: "explicit", guildId: GUILD, channelId: "c1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("target.bot-missing");
  });

  it("still reports target.bot-permissions when permissions are known and insufficient", async () => {
    const gw = new RestDiscordGateway("token");
    routeMock(guildRoutes(() => ({ roles: [], permissions: "0" })));
    const res = await resolveTarget(gw, GUILD, { kind: "explicit", guildId: GUILD, channelId: "c1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("target.bot-permissions");
  });
});

describe("isNotInGuildError", () => {
  it("recognises definitive not-a-member answers", () => {
    expect(isNotInGuildError(new FakeDiscordError(404, 10004))).toBe(true);
    expect(isNotInGuildError(new FakeDiscordError(404, 10007))).toBe(true);
    expect(isNotInGuildError(new FakeDiscordError(403, 50001))).toBe(true);
    expect(isNotInGuildError(new FakeDiscordError(404))).toBe(true);
  });
  it("treats rate limits, server errors and network failures as unknown", () => {
    expect(isNotInGuildError(new FakeDiscordError(429))).toBe(false);
    expect(isNotInGuildError(new FakeDiscordError(502))).toBe(false);
    expect(isNotInGuildError(new TypeError("fetch failed"))).toBe(false);
  });
});
