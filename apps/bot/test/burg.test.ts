import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BurgRegistry, toBurg } from "../src/burg.js";

describe("BurgRegistry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("toggles an indefinite burg entry through release", () => {
    const registry = new BurgRegistry();
    const entry = registry.burg({ guildId: "g", userId: "u", until: null, burgedBy: "mod" });

    expect(entry.style).toBe("random");
    expect(registry.isBurg("g", "u")).toBe(true);
    expect(registry.isBurg("other", "u")).toBe(false);
    expect(registry.release("g", "u")?.burgedBy).toBe("mod");
    expect(registry.isBurg("g", "u")).toBe(false);
  });

  it("auto-releases a timed entry and notifies", () => {
    const onExpire = vi.fn();
    const registry = new BurgRegistry(onExpire);
    registry.burg({ guildId: "g", userId: "u", until: Date.now() + 60_000, burgedBy: "mod", style: "cat" });

    vi.advanceTimersByTime(59_999);
    expect(registry.isBurg("g", "u")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(registry.isBurg("g", "u")).toBe(false);
    expect(onExpire).toHaveBeenCalledOnce();
    expect(onExpire.mock.calls[0]?.[0]).toMatchObject({ style: "cat" });
  });

  it("replacing an entry cancels the previous timer", () => {
    const onExpire = vi.fn();
    const registry = new BurgRegistry(onExpire);
    registry.burg({ guildId: "g", userId: "u", until: Date.now() + 1_000, burgedBy: "a" });
    registry.burg({ guildId: "g", userId: "u", until: null, burgedBy: "b", style: "soft" });

    vi.advanceTimersByTime(5_000);
    expect(registry.isBurg("g", "u")).toBe(true);
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe("toBurg", () => {
  it("uses readable uwu spellings and a cute flourish", () => {
    const result = toBurg("hello there how are you?", "soft", () => 0);
    expect(result).toContain("h-hewwo");
    expect(result).toContain("dewe");
    expect(result).toContain("u");
    expect(result).toContain("uwu~");
  });

  it("supports cat flourishes and preserves Discord special syntax", () => {
    const mention = "<@123456789012345678>";
    const emoji = "<:party:222222222222222222>";
    const timestamp = "<t:1700000000:R>";
    const link = "https://example.com/hello";
    const code = "`hello there`";
    const result = toBurg(`${mention} ${emoji} ${timestamp} ${link} ${code} hello`, "cat", () => 0);

    for (const kept of [mention, emoji, timestamp, link, code]) expect(result).toContain(kept);
    expect(result).toContain("nya~");
  });

  it("leaves a message made only of protected syntax byte-for-byte intact", () => {
    const code = "```js\nconst hello = 'there';\n```";
    expect(toBurg(code, "chaotic", () => 0)).toBe(code);
  });
});
