import { describe, expect, it } from "vitest";
import { computeBotPermissions, type DiscordMemberInfo, type DiscordRoleInfo } from "../src/gateway.js";
import { hasPermission, Permission } from "@monarch/shared";

/**
 * Bot permission computation. Regression coverage for the bug where
 * Monarch reported "missing Manage Channels" for bots whose role actually
 * has Administrator.
 */

const roles: DiscordRoleInfo[] = [
  { id: "bot-role", permissions: "8", position: 10 }, // Administrator
  { id: "g1", permissions: "1024", position: 0 }, // @everyone (View Channel)
];

describe("computeBotPermissions", () => {
  it("prefers Discord's computed member.permissions when present", () => {
    const member: DiscordMemberInfo = { roles: ["bot-role"], permissions: "8" };
    expect(computeBotPermissions(member, roles, "g1")).toBe("8");
  });

  it("ORs role bitfields when member.permissions is absent (fallback)", () => {
    const member: DiscordMemberInfo = { roles: ["bot-role"] };
    const bits = computeBotPermissions(member, roles, "g1");
    // 8 (admin) | 1024 (everyone) = 1032
    expect(bits).toBe("1032");
  });

  it("includes the @everyone role in the fallback", () => {
    const member: DiscordMemberInfo = { roles: ["bot-role"] };
    expect(
      hasPermission(computeBotPermissions(member, roles, "g1"), Permission.ViewChannel),
    ).toBe(true);
  });

  it("Administrator implies Manage Channels — the reported bug", () => {
    const member: DiscordMemberInfo = { roles: ["bot-role"], permissions: "8" };
    const bits = computeBotPermissions(member, roles, "g1");
    expect(hasPermission(bits, Permission.ManageChannels)).toBe(true);
  });

  it("returns an empty bitfield for a member with no roles", () => {
    const member: DiscordMemberInfo = { roles: [] };
    expect(computeBotPermissions(member, [], "g1")).toBe("0");
  });
});
