import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COMMAND_PREFIX } from "@monarch/shared";
import { PrefixRegistry, internalPrefixStore, type PrefixStore } from "../src/prefix/registry.js";

/**
 * Per-server prefix storage: an in-memory TTL cache in front of the
 * dashboard's internal API. The properties that matter are the ones that keep
 * a server from locking itself out of its own bot.
 */

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const store: PrefixStore = {
    load: vi.fn(async (guildId: string) => data.get(guildId) ?? null),
    save: vi.fn(async (guildId: string, prefix: string | null) => {
      if (prefix === null) data.delete(guildId);
      else data.set(guildId, prefix);
    }),
  };
  return { store, data, calls: { load: store.load as ReturnType<typeof vi.fn>, save: store.save as ReturnType<typeof vi.fn> } };
}

describe("PrefixRegistry", () => {
  it("falls back to the default prefix with no store at all", async () => {
    const registry = new PrefixRegistry();
    expect(registry.persistent).toBe(false);
    expect(await registry.get("g1")).toBe(DEFAULT_COMMAND_PREFIX);
    expect(await registry.candidates("g1")).toEqual([DEFAULT_COMMAND_PREFIX]);
  });

  it("treats a cached 'no custom prefix' as an answer, not a miss", async () => {
    const { store, calls } = memoryStore();
    const registry = new PrefixRegistry({ store });

    expect(registry.peek("g1")).toBeNull(); // cold
    expect(await registry.get("g1")).toBe(DEFAULT_COMMAND_PREFIX);
    expect(registry.peek("g1")).toEqual([DEFAULT_COMMAND_PREFIX]); // warm: null prefix cached
    expect(await registry.candidates("g1")).toEqual([DEFAULT_COMMAND_PREFIX]);
    expect(calls.load).toHaveBeenCalledTimes(1);

    registry.remember("g1", "m!");
    expect(registry.peek("g1")).toEqual(["m!", DEFAULT_COMMAND_PREFIX]);
  });

  it("reads a stored prefix once and serves it from cache", async () => {
    const { store, calls } = memoryStore({ g1: "m!" });
    const registry = new PrefixRegistry({ store });

    expect(await registry.get("g1")).toBe("m!");
    expect(await registry.get("g1")).toBe("m!");
    expect(calls.load).toHaveBeenCalledTimes(1);
    // Longest first so "m!" wins over "!" when matching a message.
    expect(await registry.candidates("g1")).toEqual(["m!", DEFAULT_COMMAND_PREFIX]);
  });

  it("expires the cache after the TTL", async () => {
    const { store, calls } = memoryStore({ g1: "m!" });
    let now = 1_000;
    const registry = new PrefixRegistry({ store, ttlMs: 60, now: () => now });

    expect(await registry.get("g1")).toBe("m!");
    calls.load.mockClear();
    (store.load as ReturnType<typeof vi.fn>).mockResolvedValue("?");

    now += 59;
    expect(await registry.get("g1")).toBe("m!");
    expect(calls.load).not.toHaveBeenCalled();

    now += 2;
    expect(await registry.get("g1")).toBe("?");
    expect(calls.load).toHaveBeenCalledTimes(1);
  });

  it("degrades to the default prefix when the store fails — and backs off", async () => {
    const warn = vi.fn();
    const store: PrefixStore = { load: vi.fn(async () => { throw new Error("503") }), save: vi.fn() };
    let now = 0;
    const registry = new PrefixRegistry({ store, ttlMs: 100, now: () => now, log: { info: vi.fn(), warn } });

    expect(await registry.get("g1")).toBe(DEFAULT_COMMAND_PREFIX);
    expect(warn).toHaveBeenCalledOnce();
    // The miss is cached too: a dead dashboard must not cost a fetch per message.
    expect(await registry.get("g1")).toBe(DEFAULT_COMMAND_PREFIX);
    expect(store.load).toHaveBeenCalledTimes(1);

    now += 101;
    expect(await registry.get("g1")).toBe(DEFAULT_COMMAND_PREFIX);
    expect(store.load).toHaveBeenCalledTimes(2);
  });

  it("validates before writing, and never writes an illegal prefix", async () => {
    const { store, data } = memoryStore();
    const registry = new PrefixRegistry({ store });

    expect(await registry.set("g1", "hey")).toMatchObject({ ok: false });
    expect(await registry.set("g1", "!!!!!")).toMatchObject({ ok: false });
    expect(store.save).not.toHaveBeenCalled();
    expect(data.size).toBe(0);
    expect(await registry.get("g1")).toBe(DEFAULT_COMMAND_PREFIX);
  });

  it("applies a new prefix immediately on the server that set it", async () => {
    const { store, data } = memoryStore();
    const registry = new PrefixRegistry({ store });

    expect(await registry.set("g1", ">>")).toEqual({ ok: true, prefix: ">>" });
    expect(data.get("g1")).toBe(">>");
    expect(await registry.get("g1")).toBe(">>");
    expect(await registry.candidates("g1")).toEqual([">>", DEFAULT_COMMAND_PREFIX]);
    // …and other guilds are untouched.
    expect(await registry.get("g2")).toBe(DEFAULT_COMMAND_PREFIX);
  });

  it("lowercases the stored prefix so matching stays case-insensitive", async () => {
    const { store } = memoryStore();
    const registry = new PrefixRegistry({ store });
    expect(await registry.set("g1", "M!")).toEqual({ ok: true, prefix: "m!" });
    expect(store.save).toHaveBeenCalledWith("g1", "m!");
  });

  it("resets to the default with null", async () => {
    const { store, data } = memoryStore({ g1: "m!" });
    const registry = new PrefixRegistry({ store });
    registry.remember("g1", "m!");

    expect(await registry.set("g1", null)).toEqual({ ok: true, prefix: DEFAULT_COMMAND_PREFIX });
    expect(data.has("g1")).toBe(false);
    expect(await registry.get("g1")).toBe(DEFAULT_COMMAND_PREFIX);
    expect(await registry.candidates("g1")).toEqual([DEFAULT_COMMAND_PREFIX]);
  });

  it("refuses to save without a store and says what to set instead", async () => {
    const registry = new PrefixRegistry();
    const result = await registry.set("g1", "?");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("INTERNAL_API_TOKEN");
      expect(result.message).toContain(DEFAULT_COMMAND_PREFIX);
    }
  });

  it("reports a failing save without leaking the request", async () => {
    const store: PrefixStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => { throw new Error("prefix update failed (500)") }),
    };
    const registry = new PrefixRegistry({ store });
    const result = await registry.set("g1", "?");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Couldn't save that prefix");
  });

  it("ignores a garbage value coming back from the API", async () => {
    const store: PrefixStore = { load: vi.fn(async () => "not a prefix"), save: vi.fn() };
    const registry = new PrefixRegistry({ store });
    expect(await registry.get("g1")).toBe(DEFAULT_COMMAND_PREFIX);
  });
});

describe("internalPrefixStore", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  it("GETs with the bearer token and normalizes the answer", async () => {
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ prefix: "M!" }) });
    const store = internalPrefixStore("https://monarch.example", "secret-token");

    expect(await store.load("g1")).toBe("m!");
    expect(fetchMock).toHaveBeenCalledWith("https://monarch.example/api/internal/guilds/g1/prefix", {
      headers: { Authorization: "Bearer secret-token" },
    });
  });

  it("treats a missing or illegal stored value as 'default'", async () => {
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ prefix: null }) });
    const store = internalPrefixStore("https://monarch.example", "t");
    expect(await store.load("g1")).toBeNull();
  });

  it("throws on a failed lookup so the registry can back off", async () => {
    fetchMock.mockReset().mockResolvedValue({ ok: false, status: 503 });
    const store = internalPrefixStore("https://monarch.example", "t");
    await expect(store.load("g1")).rejects.toThrow(/503/);
  });

  it("PUTs the prefix and surfaces the API's own message", async () => {
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const store = internalPrefixStore("https://monarch.example", "t");
    await store.save("g1", "?");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://monarch.example/api/internal/guilds/g1/prefix",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ prefix: "?" }) }),
    );

    fetchMock.mockReset().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: "A prefix has to end in punctuation" }),
    });
    await expect(store.save("g1", "hey")).rejects.toThrow("A prefix has to end in punctuation");
  });

  it("PUTs null to reset", async () => {
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const store = internalPrefixStore("https://monarch.example", "t");
    await store.save("g1", null);
    expect(fetchMock.mock.calls[0]![1].body).toBe(JSON.stringify({ prefix: null }));
  });
});
