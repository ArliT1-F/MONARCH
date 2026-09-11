import { describe, expect, it } from "vitest";
import {
  DEFAULT_DJ_ROLE_NAMES,
  DEFAULT_STAFF_ROLE_NAMES,
  STAFF_PERMISSION_BITS,
  canForceSkip,
  formatDuration,
  hasNamedRole,
  parseVolume,
  progressBar,
  volumeToGain,
} from "../src/index.js";

const NO_PERMS = 0n;

describe("canForceSkip", () => {
  it("lets a member with a DJ role skip", () => {
    expect(canForceSkip({ roleNames: ["DJ", "Members"], permissions: NO_PERMS, isCurrentRequester: false })).toEqual({
      allowed: true,
      reason: "dj",
    });
  });

  it("recognizes configurable DJ role names", () => {
    expect(
      canForceSkip({
        roleNames: ["Resident DJ"],
        permissions: NO_PERMS,
        isCurrentRequester: false,
        config: { djRoleNames: ["Resident DJ", "DJ"] },
      }).reason,
    ).toBe("dj");
  });

  it("can disable DJ-role recognition entirely", () => {
    expect(
      canForceSkip({
        roleNames: ["DJ"],
        permissions: NO_PERMS,
        isCurrentRequester: false,
        config: { djRolesEnabled: false },
      }).allowed,
    ).toBe(false);
  });

  it("recognizes staff by role name", () => {
    for (const role of DEFAULT_STAFF_ROLE_NAMES) {
      expect(hasNamedRole([role], DEFAULT_STAFF_ROLE_NAMES)).toBe(true);
    }
    expect(canForceSkip({ roleNames: ["Staff"], permissions: NO_PERMS, isCurrentRequester: false }).reason).toBe("staff");
  });

  it("recognizes staff by real Discord permissions", () => {
    for (const bit of Object.values(STAFF_PERMISSION_BITS)) {
      expect(canForceSkip({ roleNames: [], permissions: bit, isCurrentRequester: false }).reason).toBe("staff");
    }
  });

  it("lets the current requester skip their own song", () => {
    expect(canForceSkip({ roleNames: [], permissions: NO_PERMS, isCurrentRequester: true })).toEqual({
      allowed: true,
      reason: "requester",
    });
  });

  it("sends everyone else to the vote", () => {
    expect(canForceSkip({ roleNames: ["Listener"], permissions: NO_PERMS, isCurrentRequester: false })).toEqual({
      allowed: false,
    });
  });
});

describe("format helpers", () => {
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(181_000)).toBe("3:01");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
    expect(formatDuration(null)).toBe("live");
    expect(formatDuration(-5)).toBe("live");
  });

  it("parses and clamps volume", () => {
    expect(parseVolume("80")).toBe(80);
    expect(parseVolume(120)).toBe(120);
    expect(parseVolume("999")).toBe(150);
    expect(parseVolume("-3")).toBe(0);
    expect(parseVolume("loud")).toBeNull();
    expect(parseVolume("50.5")).toBeNull();
  });

  it("converts volume to player gain", () => {
    expect(volumeToGain(100)).toBe(1);
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(150)).toBe(1.5);
  });

  it("draws a progress bar", () => {
    expect(progressBar(0, 100_000, 10)).toContain("🔘");
    expect(progressBar(50_000, 100_000, 10)).toBe("▬▬▬▬🔘▬▬▬▬▬");
    expect(progressBar(100_000, 100_000, 10)).toBe("▬▬▬▬▬▬▬▬▬🔘");
    expect(progressBar(5_000, 0)).toBe("");
  });
});