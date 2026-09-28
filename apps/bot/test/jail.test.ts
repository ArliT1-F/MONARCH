import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JailRegistry, toJailSpeak, type StoredJailEntry } from "../src/jail.js";

describe("JailRegistry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("toggles an indefinite jail entry through release", () => {
    const registry = new JailRegistry();
    const entry = registry.jail({ guildId: "g", userId: "u", until: null, jailedBy: "mod" });

    expect(entry.style).toBe("random");
    expect(registry.isJailed("g", "u")).toBe(true);
    expect(registry.isJailed("other", "u")).toBe(false);
    expect(registry.release("g", "u")?.jailedBy).toBe("mod");
    expect(registry.isJailed("g", "u")).toBe(false);
  });

  it("auto-releases a timed entry and notifies", () => {
    const onExpire = vi.fn();
    const registry = new JailRegistry({ onExpire });
    registry.jail({
      guildId: "g",
      userId: "u",
      until: Date.now() + 60_000,
      jailedBy: "mod",
      style: "cat",
    });

    vi.advanceTimersByTime(59_999);
    expect(registry.isJailed("g", "u")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(registry.isJailed("g", "u")).toBe(false);
    expect(onExpire).toHaveBeenCalledOnce();
    expect(onExpire.mock.calls[0]?.[0]).toMatchObject({ style: "cat" });
  });

  it("replacing an entry cancels the previous timer", () => {
    const onExpire = vi.fn();
    const registry = new JailRegistry({ onExpire });
    registry.jail({ guildId: "g", userId: "u", until: Date.now() + 1_000, jailedBy: "a" });
    registry.jail({ guildId: "g", userId: "u", until: null, jailedBy: "b", style: "soft" });

    vi.advanceTimersByTime(5_000);
    expect(registry.isJailed("g", "u")).toBe(true);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("remembers a reason and hands it back with the entry", () => {
    const registry = new JailRegistry();
    registry.jail({
      guildId: "g",
      userId: "u",
      until: null,
      jailedBy: "mod",
      reason: "spamming general",
    });
    expect(registry.get("g", "u")?.reason).toBe("spamming general");
    expect(registry.list("g")[0]?.reason).toBe("spamming general");
  });
});

describe("JailRegistry persistence", () => {
  const row = (over: Partial<StoredJailEntry> = {}): StoredJailEntry => ({
    guildId: "g",
    userId: "u",
    until: null,
    jailedBy: "mod",
    style: "soft",
    reason: null,
    ...over,
  });

  function fakeStore(rows: StoredJailEntry[] = []) {
    return {
      list: vi.fn(async () => rows),
      put: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
  }

  it("writes through on jail and clears on release", async () => {
    const store = fakeStore();
    const registry = new JailRegistry({ store });
    expect(registry.persistent).toBe(true);

    registry.jail({ guildId: "g", userId: "u", until: null, jailedBy: "mod", style: "cat" });
    expect(store.put).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "g", userId: "u", style: "cat", until: null }),
    );

    registry.release("g", "u");
    expect(store.remove).toHaveBeenCalledWith("g", "u");
  });

  it("hydrates stored entries once, arming their timers", async () => {
    const store = fakeStore([row({ userId: "u1", until: new Date(Date.now() + 60_000).toISOString() })]);
    const registry = new JailRegistry({ store });

    const { entries, expired } = await registry.hydrate("g");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.userId).toBe("u1");
    expect(expired).toEqual([]);
    expect(registry.isJailed("g", "u1")).toBe(true);

    // A second call reuses memory instead of hitting the API again.
    await registry.hydrate("g");
    expect(store.list).toHaveBeenCalledTimes(1);
  });

  it("hands back windows that already ran out while the bot was down", async () => {
    const store = fakeStore([row({ userId: "u1", until: new Date(Date.now() - 1_000).toISOString() })]);
    const registry = new JailRegistry({ store });

    const { entries, expired } = await registry.hydrate("g");
    expect(entries).toHaveLength(0);
    expect(expired.map((e) => e.userId)).toEqual(["u1"]);
    expect(registry.isJailed("g", "u1")).toBe(false);
  });

  it("degrades to memory when the dashboard is unreachable", async () => {
    const store = {
      list: vi.fn(async () => {
        throw new Error("502");
      }),
      put: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    const log = { warn: vi.fn() };
    const registry = new JailRegistry({ store, log });

    expect(await registry.hydrate("g")).toEqual({ entries: [], expired: [] });
    expect(log.warn).toHaveBeenCalled();
  });

  it("prunes entries whose window passed without a timer", () => {
    vi.useFakeTimers();
    const registry = new JailRegistry();
    registry.jail({ guildId: "g", userId: "u", until: Date.now() + 1_000, jailedBy: "mod" });
    vi.setSystemTime(Date.now() + 5_000);
    // Simulate a lost timer (process paused, clock moved).
    const dead = registry.pruneExpired();
    expect(dead.map((e) => e.userId)).toEqual(["u"]);
    expect(registry.isJailed("g", "u")).toBe(false);
    vi.useRealTimers();
  });
});

describe("toJailSpeak", () => {
  it("uses readable uwu spellings and a cute flourish", () => {
    const result = toJailSpeak("hello there how are you?", "soft", () => 0);
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
    const result = toJailSpeak(
      `${mention} ${emoji} ${timestamp} ${link} ${code} hello`,
      "cat",
      () => 0,
    );

    for (const kept of [mention, emoji, timestamp, link, code]) expect(result).toContain(kept);
    expect(result).toContain("nya~");
  });

  it("leaves a message made only of protected syntax byte-for-byte intact", () => {
    const code = "```js\nconst hello = 'there';\n```";
    expect(toJailSpeak(code, "chaotic", () => 0)).toBe(code);
  });

  it("stutters the first word but closes the last segment with the suffix", () => {
    // A mention in the middle used to trap the cute ending mid-message.
    const mention = "<@123456789012345678>";
    const result = toJailSpeak(`hello ${mention} how are you`, "soft", () => 0);
    expect(result.startsWith("h-hewwo")).toBe(true);
    expect(result).toContain(mention);
    expect(result.endsWith("uwu~")).toBe(true);
    expect(result.indexOf("uwu~")).toBeGreaterThan(result.indexOf(mention));
  });

  it("keeps a leading mention untouched and still ends cute", () => {
    const mention = "<@123456789012345678>";
    const result = toJailSpeak(`${mention} hello there`, "cat", () => 0);
    expect(result.startsWith(mention)).toBe(true);
    expect(result).toContain("hewwo");
    expect(result.endsWith("nya~")).toBe(true);
  });

  it("speaks pirate, shakespeare and robot (the voter styles)", () => {
    const pirate = toJailSpeak("you are my friend", "pirate", () => 0.99);
    expect(pirate).toContain("ye be");
    expect(pirate).toContain("matey");

    const shakespeare = toJailSpeak("you are here", "shakespeare", () => 0.99);
    expect(shakespeare).toContain("thou art");

    const robot = toJailSpeak("you are the one", "robot", () => 0.99);
    expect(robot).toContain("y0u 4re th3");
  });

  it("random only ever draws from the free styles", () => {
    for (const roll of [0, 0.33, 0.5, 0.66, 0.99]) {
      const result = toJailSpeak("hello there", "random", () => roll);
      expect(result).not.toContain("BEEP BOOP");
      expect(result).not.toContain("arr!");
      expect(result).not.toContain("forsooth");
    }
  });
});
