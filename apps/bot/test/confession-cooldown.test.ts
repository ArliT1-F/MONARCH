import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONFESSION_COOLDOWN_MS } from "@monarch/shared";
import {
  ConfessionCooldowns,
  internalConfessionCooldownStore,
  type ConfessionCooldownStore,
} from "../src/confession-cooldown.js";

/**
 * The confession cooldown registry: a cache of *live* windows in front of the
 * dashboard's internal API. The properties that matter are the ones that keep
 * the feature honest and forgiving at the same time:
 *
 * - a claimed window blocks the next confession — in every server, since the
 *   key is the user id and not the guild;
 * - it expires on its own, without a round trip (absolute timestamps);
 * - a dead dashboard **fails open**: the confession still goes out;
 * - a released window is really gone (a failed post must not cost six hours).
 */

const USER = "700000000000000001";
const OTHER = "700000000000000002";

const log = { info: vi.fn(), warn: vi.fn() };

/** An in-memory stand-in for the dashboard's cooldown table, on a shared clock. */
function memoryStore(now: () => number, initial: Record<string, number> = {}) {
  const windows = new Map<string, number>(Object.entries(initial));
  const store: ConfessionCooldownStore = {
    status: vi.fn(async (userId: string) => {
      const until = windows.get(userId);
      return until !== undefined && until > now() ? until : null;
    }),
    claim: vi.fn(async (userId: string) => {
      const until = windows.get(userId);
      if (until !== undefined && until > now()) return { claimed: false, nextAllowedAt: until };
      const nextAllowedAt = now() + CONFESSION_COOLDOWN_MS;
      windows.set(userId, nextAllowedAt);
      return { claimed: true, nextAllowedAt };
    }),
    release: vi.fn(async (userId: string) => {
      windows.delete(userId);
    }),
  };
  return { store, windows };
}

/** A store whose every call fails — the dashboard is down. */
function deadStore(): ConfessionCooldownStore {
  const boom = async () => {
    throw new Error("dashboard down");
  };
  return { status: boom, claim: boom, release: boom };
}

describe("ConfessionCooldowns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("isn't enforced at all without a store", async () => {
    const cooldowns = new ConfessionCooldowns();
    expect(cooldowns.persistent).toBe(false);
    expect(await cooldowns.blockedUntil(USER)).toBeNull();
    expect(await cooldowns.claim(USER)).toEqual({ allowed: true, nextAllowedAt: null });
    await cooldowns.release(USER); // no store, no throw
  });

  it("hands out a six hour window and blocks the next claim", async () => {
    let now = 1_700_000_000_000;
    const { store, windows } = memoryStore(() => now);
    const cooldowns = new ConfessionCooldowns({ store, now: () => now, log });

    const first = await cooldowns.claim(USER);
    expect(first.allowed).toBe(true);
    const until = first.allowed ? first.nextAllowedAt : null;
    expect(until).toBe(now + CONFESSION_COOLDOWN_MS);
    expect(windows.get(USER)).toBe(now + CONFESSION_COOLDOWN_MS);
    expect(CONFESSION_COOLDOWN_MS).toBe(6 * 60 * 60 * 1000);

    // Same person, a second later — the window is keyed by user, not guild, so
    // confessing in another server runs into the very same clock.
    now += 1_000;
    expect(await cooldowns.claim(USER)).toEqual({ allowed: false, nextAllowedAt: until });
    expect(windows.get(USER)).toBe(until); // untouched: a refused claim extends nothing
  });

  it("keeps other people's windows to themselves", async () => {
    const now = 1_700_000_000_000;
    const { store } = memoryStore(() => now);
    const cooldowns = new ConfessionCooldowns({ store, now: () => now });

    expect((await cooldowns.claim(USER)).allowed).toBe(true);
    expect((await cooldowns.claim(OTHER)).allowed).toBe(true);
  });

  it("answers the button from the cache — no round trip per click", async () => {
    const now = 1_700_000_000_000;
    const { store } = memoryStore(() => now);
    const cooldowns = new ConfessionCooldowns({ store, now: () => now });

    await cooldowns.claim(USER); // seeds the cache
    expect(store.status).not.toHaveBeenCalled();
    expect(await cooldowns.blockedUntil(USER)).toBe(now + CONFESSION_COOLDOWN_MS);
    expect(await cooldowns.blockedUntil(USER)).toBe(now + CONFESSION_COOLDOWN_MS);
    expect(store.status).not.toHaveBeenCalled();
  });

  it("expires on its own, without asking the dashboard again", async () => {
    let now = 1_700_000_000_000;
    const { store } = memoryStore(() => now);
    const cooldowns = new ConfessionCooldowns({ store, now: () => now });

    await cooldowns.claim(USER);
    now += CONFESSION_COOLDOWN_MS - 1;
    expect(await cooldowns.blockedUntil(USER)).toBe(now + 1); // one ms left
    now += 1;
    expect(await cooldowns.blockedUntil(USER)).toBeNull();
    expect(store.status).not.toHaveBeenCalled();
    expect((await cooldowns.claim(USER)).allowed).toBe(true);
  });

  it("reads a window it hasn't seen once, then remembers it", async () => {
    const now = 1_700_000_000_000;
    const until = now + 60_000;
    const { store } = memoryStore(() => now, { [USER]: until });
    const cooldowns = new ConfessionCooldowns({ store, now: () => now });

    expect(await cooldowns.blockedUntil(USER)).toBe(until);
    expect(store.status).toHaveBeenCalledOnce();
    expect(await cooldowns.blockedUntil(USER)).toBe(until);
    expect(store.status).toHaveBeenCalledOnce(); // cached
    // And the submit-time claim agrees with the button.
    const decision = await cooldowns.claim(USER);
    expect(decision.allowed).toBe(false);
  });

  it("treats an expired stored window as free", async () => {
    const now = 1_700_000_000_000;
    const { store } = memoryStore(() => now, { [USER]: now - 1 });
    const cooldowns = new ConfessionCooldowns({ store, now: () => now });

    expect(await cooldowns.blockedUntil(USER)).toBeNull();
    expect(cooldowns.size).toBe(0); // nothing worth remembering
  });

  it("fails open when the dashboard is unreachable — and says so", async () => {
    const cooldowns = new ConfessionCooldowns({ store: deadStore(), log });

    expect(await cooldowns.blockedUntil(USER)).toBeNull();
    expect(await cooldowns.claim(USER)).toEqual({ allowed: true, nextAllowedAt: null });
    await cooldowns.release(USER); // best effort, never throws
    expect(log.warn).toHaveBeenCalled();
  });

  it("release gives the window back immediately", async () => {
    const now = 1_700_000_000_000;
    const { store, windows } = memoryStore(() => now);
    const cooldowns = new ConfessionCooldowns({ store, now: () => now });

    await cooldowns.claim(USER);
    expect(await cooldowns.blockedUntil(USER)).not.toBeNull();

    await cooldowns.release(USER);
    expect(windows.has(USER)).toBe(false);
    expect(await cooldowns.blockedUntil(USER)).toBeNull();
    expect((await cooldowns.claim(USER)).allowed).toBe(true);
  });

  it("prunes expired windows instead of growing forever", () => {
    let now = 1_700_000_000_000;
    const cooldowns = new ConfessionCooldowns({
      store: memoryStore(() => now).store,
      now: () => now,
    });

    for (let i = 0; i < 600; i++) cooldowns.remember(`user-${i}`, now + 1_000);
    expect(cooldowns.size).toBe(600);
    now += 2_000; // every window has run out
    cooldowns.remember("one-more", now + 1_000);
    expect(cooldowns.size).toBe(1);
  });
});

describe("internalConfessionCooldownStore", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const store = internalConfessionCooldownStore("https://monarch.example", "secret-token");
  const url = `https://monarch.example/api/internal/users/${USER}/confession-cooldown`;

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("GETs the window with the bearer token", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ nextAllowedAt: "2026-09-13T12:00:00.000Z" }),
    });
    expect(await store.status(USER)).toBe(Date.parse("2026-09-13T12:00:00.000Z"));
    expect(fetchMock).toHaveBeenCalledWith(url, {
      headers: { Authorization: "Bearer secret-token" },
    });
  });

  it("reads a missing or unparseable window as 'free'", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ nextAllowedAt: null }) });
    expect(await store.status(USER)).toBeNull();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ nextAllowedAt: "not a date" }) });
    expect(await store.status(USER)).toBeNull();
  });

  it("throws on a failed lookup so the registry can fail open", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(store.status(USER)).rejects.toThrow(/503/);
  });

  it("POSTs to claim and reads both answers", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ claimed: true, nextAllowedAt: "2026-09-13T12:00:00.000Z" }),
    });
    expect(await store.claim(USER)).toEqual({
      claimed: true,
      nextAllowedAt: Date.parse("2026-09-13T12:00:00.000Z"),
    });
    expect(fetchMock).toHaveBeenCalledWith(url, {
      method: "POST",
      headers: { Authorization: "Bearer secret-token" },
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        claimed: false,
        nextAllowedAt: "2026-09-13T12:00:00.000Z",
        retryAfterMs: 1000,
      }),
    });
    expect((await store.claim(USER)).claimed).toBe(false);
  });

  it("treats a 200 without a timestamp as a full window from now", async () => {
    const before = Date.now();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ claimed: true }) });
    const result = await store.claim(USER);
    expect(result.claimed).toBe(true);
    expect(result.nextAllowedAt).toBeGreaterThanOrEqual(before + CONFESSION_COOLDOWN_MS - 5_000);
    expect(result.nextAllowedAt).toBeLessThanOrEqual(Date.now() + CONFESSION_COOLDOWN_MS);
  });

  it("surfaces the API's own message when the claim fails", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        error: {
          code: "store.unavailable",
          message: "Monarch couldn't reserve the confession cooldown.",
        },
      }),
    });
    await expect(store.claim(USER)).rejects.toThrow(/couldn't reserve/);
  });

  it("DELETEs to release, and throws when that fails", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    await expect(store.release(USER)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(url, {
      method: "DELETE",
      headers: { Authorization: "Bearer secret-token" },
    });

    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(store.release(USER)).rejects.toThrow(/500/);
  });
});
