import { describe, expect, it } from "vitest";
import { Permission } from "../src/permissions.js";
import {
  INVITE_PERMISSIONS,
  INVITE_SCOPES,
  buildBotInviteUrl,
  invitePermissionBits,
  invitePermissionNames,
  isValidGuildId,
} from "../src/invite.js";

/**
 * The invite link is built here — in shared — because two surfaces hand it
 * out: the dashboard's "Add Monarch to Discord" button (via `GET /api/invite`)
 * and the bot's `!invite` / `/monarch invite`. If they ever disagree, somebody
 * installs a bot with the wrong permissions.
 *
 * The load-bearing rule is the last one: **never Administrator**. Prefix
 * commands are open to every member, so `!invite` is reachable by people who
 * can't manage a server — the link must not carry any power they don't have.
 */
const CLIENT_ID = "123456789012345678";

describe("buildBotInviteUrl", () => {
  it("builds Discord's authorize URL with the bot scopes and guild install", () => {
    const url = new URL(buildBotInviteUrl({ clientId: CLIENT_ID })!);
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    expect(url.searchParams.get("permissions")).toBe(invitePermissionBits());
    expect(url.searchParams.get("integration_type")).toBe("0");
    expect(url.searchParams.get("guild_id")).toBeNull();
  });

  it("pre-selects a server when one is given, and ignores junk ids", () => {
    const selected = new URL(buildBotInviteUrl({ clientId: CLIENT_ID, guildId: "800000000000000001" })!);
    expect(selected.searchParams.get("guild_id")).toBe("800000000000000001");
    expect(selected.searchParams.get("disable_guild_select")).toBe("true");

    for (const junk of ["../evil", "not-a-snowflake", "https://evil.example", ""]) {
      const url = new URL(buildBotInviteUrl({ clientId: CLIENT_ID, guildId: junk })!);
      expect(url.searchParams.get("guild_id"), junk).toBeNull();
      expect(url.searchParams.get("disable_guild_select"), junk).toBeNull();
    }
  });

  it("returns null without an application id rather than inventing a link", () => {
    expect(buildBotInviteUrl({ clientId: null })).toBeNull();
    expect(buildBotInviteUrl({ clientId: undefined })).toBeNull();
    expect(buildBotInviteUrl({ clientId: "" })).toBeNull();
  });

  it("requests exactly the permissions Monarch uses — never Administrator", () => {
    const bits = BigInt(invitePermissionBits());
    expect(INVITE_PERMISSIONS).not.toContain("Administrator");
    expect(bits & Permission.Administrator).toBe(0n);
    // The ones the features actually need:
    expect(bits & Permission.ManageChannels).toBe(Permission.ManageChannels); // apply designs
    expect(bits & Permission.ManageRoles).toBe(Permission.ManageRoles);
    expect(bits & Permission.ManageWebhooks).toBe(Permission.ManageWebhooks); // jail/burg relays
    expect(bits & Permission.ManageMessages).toBe(Permission.ManageMessages);
    expect(bits & Permission.SendMessages).toBe(Permission.SendMessages); // prefix command replies
    expect(bits & Permission.AttachFiles).toBe(Permission.AttachFiles); // /monarch export
    // …and the union is exactly the list, no stray bits.
    expect(bits).toBe(INVITE_PERMISSIONS.reduce((acc, name) => acc | Permission[name], 0n));
  });

  it("keeps the scopes to bot + slash commands (no identify, no email)", () => {
    expect([...INVITE_SCOPES]).toEqual(["bot", "applications.commands"]);
  });

  it("names the permissions for humans", () => {
    expect(invitePermissionNames()).toEqual([...INVITE_PERMISSIONS]);
    expect(invitePermissionNames().length).toBeGreaterThan(5);
  });
});

describe("isValidGuildId", () => {
  it("accepts snowflakes and rejects everything else", () => {
    expect(isValidGuildId("100000000000000001")).toBe(true);
    expect(isValidGuildId("12345")).toBe(true);
    expect(isValidGuildId("1234")).toBe(false);
    expect(isValidGuildId("123 456")).toBe(false);
    expect(isValidGuildId("")).toBe(false);
    expect(isValidGuildId(null)).toBe(false);
    expect(isValidGuildId(undefined)).toBe(false);
  });
});
