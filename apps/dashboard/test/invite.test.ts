import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

/**
 * lib/invite reads process.env through lib/env at import time, so each case
 * resets the module registry before importing with the env it needs.
 */
async function loadInvite(env: Record<string, string | undefined>) {
  Object.assign(process.env, env);
  vi.resetModules();
  return import("@/lib/invite");
}

const REAL = {
  DISCORD_CLIENT_ID: "123456789012345678",
  DISCORD_CLIENT_SECRET: "secret",
  DISCORD_BOT_TOKEN: "token",
  MONARCH_DEMO: "",
};

const DEMO = {
  DISCORD_CLIENT_ID: "",
  DISCORD_CLIENT_SECRET: "",
  DISCORD_BOT_TOKEN: "",
  MONARCH_DEMO: "",
};

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
});
afterEach(() => {
  process.env = saved;
});

describe("buildBotInviteUrl", () => {
  it("builds a Discord authorize URL with the bot scopes and permissions", async () => {
    const { buildBotInviteUrl, invitePermissionBits } = await loadInvite(REAL);
    const url = new URL(buildBotInviteUrl()!);

    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe(REAL.DISCORD_CLIENT_ID);
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    expect(url.searchParams.get("permissions")).toBe(invitePermissionBits());
    expect(url.searchParams.get("integration_type")).toBe("0");
    expect(url.searchParams.get("guild_id")).toBeNull();
  });

  it("pre-selects and locks the guild when a guild id is given", async () => {
    const { buildBotInviteUrl } = await loadInvite(REAL);
    const url = new URL(buildBotInviteUrl({ guildId: "100000000000000003" })!);

    expect(url.searchParams.get("guild_id")).toBe("100000000000000003");
    expect(url.searchParams.get("disable_guild_select")).toBe("true");
  });

  it("ignores guild ids that aren't snowflakes", async () => {
    const { buildBotInviteUrl } = await loadInvite(REAL);
    const url = new URL(buildBotInviteUrl({ guildId: "../evil" })!);

    expect(url.searchParams.get("guild_id")).toBeNull();
    expect(url.searchParams.get("disable_guild_select")).toBeNull();
  });

  it("requests only the permissions Monarch uses — never Administrator", async () => {
    const { invitePermissionBits, INVITE_PERMISSIONS } = await loadInvite(REAL);
    const bits = BigInt(invitePermissionBits());

    expect(INVITE_PERMISSIONS).not.toContain("Administrator");
    expect(bits & (1n << 3n)).toBe(0n); // Administrator
    expect(bits & (1n << 4n)).toBe(1n << 4n); // ManageChannels
    expect(bits & (1n << 28n)).toBe(1n << 28n); // ManageRoles
  });

  it("returns null with no Discord application configured", async () => {
    const { buildBotInviteUrl } = await loadInvite(DEMO);
    expect(buildBotInviteUrl()).toBeNull();
  });

  it("still offers the invite in demo mode (simulated install)", async () => {
    const { isInviteAvailable } = await loadInvite(DEMO);
    expect(isInviteAvailable()).toBe(true);
  });
});

describe("isValidGuildId", () => {
  it("accepts snowflakes and rejects anything else", async () => {
    const { isValidGuildId } = await loadInvite(REAL);
    expect(isValidGuildId("100000000000000001")).toBe(true);
    expect(isValidGuildId("12345")).toBe(true);
    expect(isValidGuildId("")).toBe(false);
    expect(isValidGuildId(null)).toBe(false);
    expect(isValidGuildId("1234")).toBe(false);
    expect(isValidGuildId("123 456")).toBe(false);
    expect(isValidGuildId("https://evil.example")).toBe(false);
  });
});
