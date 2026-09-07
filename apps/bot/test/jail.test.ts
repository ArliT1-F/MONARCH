import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JailRegistry } from "../src/jail.js";

describe("JailRegistry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("jails indefinitely until released", () => {
    const reg = new JailRegistry();
    reg.jail({ guildId: "g", userId: "u", until: null, jailedBy: "mod" });
    expect(reg.isJailed("g", "u")).toBe(true);
    expect(reg.isJailed("other", "u")).toBe(false);
    vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
    expect(reg.isJailed("g", "u")).toBe(true);
    expect(reg.release("g", "u")?.jailedBy).toBe("mod");
    expect(reg.isJailed("g", "u")).toBe(false);
    expect(reg.release("g", "u")).toBeNull();
  });

  it("auto-releases timed jails and notifies", () => {
    const onExpire = vi.fn();
    const reg = new JailRegistry(onExpire);
    reg.jail({ guildId: "g", userId: "u", until: Date.now() + 60_000, jailedBy: "mod" });
    vi.advanceTimersByTime(59_999);
    expect(reg.isJailed("g", "u")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(reg.isJailed("g", "u")).toBe(false);
    expect(onExpire).toHaveBeenCalledOnce();
    expect(reg.size).toBe(0);
  });

  it("re-jailing replaces the previous timer", () => {
    const onExpire = vi.fn();
    const reg = new JailRegistry(onExpire);
    reg.jail({ guildId: "g", userId: "u", until: Date.now() + 1_000, jailedBy: "a" });
    reg.jail({ guildId: "g", userId: "u", until: null, jailedBy: "b" });
    vi.advanceTimersByTime(5_000);
    expect(reg.isJailed("g", "u")).toBe(true);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("handles durations beyond the setTimeout ceiling", () => {
    const onExpire = vi.fn();
    const reg = new JailRegistry(onExpire);
    const days28 = 28 * 24 * 60 * 60 * 1000;
    reg.jail({ guildId: "g", userId: "u", until: Date.now() + days28, jailedBy: "a" });
    vi.advanceTimersByTime(days28 - 1);
    expect(reg.isJailed("g", "u")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(reg.isJailed("g", "u")).toBe(false);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("lists only live entries for a guild", () => {
    const reg = new JailRegistry();
    reg.jail({ guildId: "g", userId: "u1", until: null, jailedBy: "a" });
    reg.jail({ guildId: "g", userId: "u2", until: Date.now() + 10, jailedBy: "a" });
    reg.jail({ guildId: "h", userId: "u3", until: null, jailedBy: "a" });
    expect(reg.list("g").map((e) => e.userId).sort()).toEqual(["u1", "u2"]);
    vi.advanceTimersByTime(11);
    expect(reg.list("g").map((e) => e.userId)).toEqual(["u1"]);
  });
});
