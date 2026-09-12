import { DEFAULT_COMMAND_PREFIX, parseCommandPrefix } from "@monarch/shared";

/**
 * Per-server command prefixes.
 *
 * The value lives in the dashboard's store (`GuildSettings.commandPrefix`)
 * and is reached through the internal API with `INTERNAL_API_TOKEN`, exactly
 * like backups and exports — the bot process deliberately holds no database
 * credentials (see apps/bot/src/burg.ts for the same reasoning).
 *
 * Reading it on every message would mean one HTTP call per message, so the
 * registry keeps an in-memory cache with a short TTL:
 *
 * - the default prefix (`!`) and an @Monarch mention always work, even with
 *   no token, no dashboard and no cache — you can never lock a server out;
 * - a custom prefix starts working on the server that set it immediately
 *   (the write seeds the cache) and everywhere else within the TTL;
 * - an unreachable dashboard is cached as "unknown" for the same TTL, so a
 *   dead API can't turn every message into a fetch.
 */

/** The bot-facing seam over `GET|PUT /api/internal/guilds/:id/prefix`. */
export interface PrefixStore {
  load(guildId: string): Promise<string | null>;
  save(guildId: string, prefix: string | null): Promise<void>;
}

export interface PrefixRegistryOptions {
  /** Where custom prefixes are persisted; null = default prefix only. */
  store?: PrefixStore | null;
  ttlMs?: number;
  now?: () => number;
  log?: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };
}

const DEFAULT_TTL_MS = 60_000;

/** Longest first, so `!!` wins over `!` when both are configured. */
function dedupeSorted(prefixes: readonly string[]): string[] {
  return [...new Set(prefixes.filter(Boolean))].sort((a, b) => b.length - a.length);
}

interface CacheEntry {
  prefix: string | null;
  expiresAt: number;
}

export class PrefixRegistry {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly store: PrefixStore | null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly log: PrefixRegistryOptions["log"];

  constructor(options: PrefixRegistryOptions = {}) {
    this.store = options.store ?? null;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  /** Can this instance remember a custom prefix at all? */
  get persistent(): boolean {
    return this.store !== null;
  }

  /**
   * The prefix to match for this guild. Never throws: an unreachable store
   * degrades to the default prefix (plus mention), which is the safe answer.
   */
  async get(guildId: string): Promise<string> {
    return (await this.resolve(guildId)) ?? DEFAULT_COMMAND_PREFIX;
  }

  /**
   * The prefixes we can vouch for *without* an API call: whatever is in the
   * cache right now, longest first. Returns null when the cache is cold or
   * stale, which the dispatcher reads as "worth one lookup" — and the default
   * prefix plus mentions are always in the list, so a cold cache can never
   * hide a command that uses them.
   */
  peek(guildId: string): string[] | null {
    const hit = this.cache.get(guildId);
    if (!hit || hit.expiresAt <= this.now()) return null;
    // `hit.prefix === null` is an answer ("no custom prefix here"), not a miss.
    return dedupeSorted(hit.prefix ? [hit.prefix, DEFAULT_COMMAND_PREFIX] : [DEFAULT_COMMAND_PREFIX]);
  }

  /** Every prefix a message could start with, longest first. */
  async candidates(guildId: string): Promise<string[]> {
    const custom = await this.resolve(guildId);
    return dedupeSorted(custom ? [custom, DEFAULT_COMMAND_PREFIX] : [DEFAULT_COMMAND_PREFIX]);
  }

  /**
   * Change (or with `null`, reset) a guild's prefix. Returns a
   * user-presentable error message instead of throwing.
   */
  async set(guildId: string, requested: string | null): Promise<{ ok: true; prefix: string } | { ok: false; message: string }> {
    if (requested === null) {
      try {
        await this.store?.save(guildId, null);
      } catch (e) {
        return { ok: false, message: resetFailure(e) };
      }
      this.remember(guildId, null);
      return { ok: true, prefix: DEFAULT_COMMAND_PREFIX };
    }

    const parsed = parseCommandPrefix(requested);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    if (!this.store) {
      return {
        ok: false,
        message:
          "❌ Custom prefixes are saved through the Monarch dashboard, and this bot can't reach it — " +
          "set `INTERNAL_API_TOKEN` in the dashboard and bot environments. " +
          `Until then \`${DEFAULT_COMMAND_PREFIX}\` and an @Monarch mention keep working.`,
      };
    }
    try {
      await this.store.save(guildId, parsed.prefix);
    } catch (e) {
      return { ok: false, message: saveFailure(e) };
    }
    this.remember(guildId, parsed.prefix);
    this.log?.info("command prefix changed", { guildId, prefix: parsed.prefix });
    return { ok: true, prefix: parsed.prefix };
  }

  /** Seed the cache (used by tests and after a successful write). */
  remember(guildId: string, prefix: string | null): void {
    this.cache.set(guildId, { prefix, expiresAt: this.now() + this.ttlMs });
  }

  clear(): void {
    this.cache.clear();
  }

  private async resolve(guildId: string): Promise<string | null> {
    const hit = this.cache.get(guildId);
    if (hit && hit.expiresAt > this.now()) return hit.prefix;
    if (!this.store) return null;
    try {
      const stored = await this.store.load(guildId);
      // Defensive: a value that isn't a legal prefix (old row, hand-edited
      // database, a store that skipped validation) degrades to the default
      // instead of becoming a match rule for ordinary messages.
      const parsed = stored === null ? null : parseCommandPrefix(stored);
      const prefix = parsed && parsed.ok ? parsed.prefix : null;
      if (stored !== null && prefix === null) {
        this.log?.warn("ignoring an invalid stored prefix — using the default", { guildId, stored });
      }
      this.remember(guildId, prefix);
      return prefix;
    } catch (e) {
      // Cache the miss too — a dead dashboard must not cost a fetch per message.
      this.cache.set(guildId, { prefix: null, expiresAt: this.now() + this.ttlMs });
      this.log?.warn("couldn't load the command prefix — using the default", {
        guildId,
        error: String(e),
      });
      return null;
    }
  }
}

function saveFailure(e: unknown): string {
  const detail = apiMessage(e);
  return `❌ Couldn't save that prefix.${detail ? `\n${detail}` : ""}\nTry again in a moment — \`${DEFAULT_COMMAND_PREFIX}\` still works meanwhile.`;
}

function resetFailure(e: unknown): string {
  const detail = apiMessage(e);
  return `❌ Couldn't reset the prefix.${detail ? `\n${detail}` : ""}`;
}

function apiMessage(e: unknown): string {
  const message = (e as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.length > 0 && message.length <= 300) return message;
  return "";
}

/** The internal-API-backed store the worker uses. */
export function internalPrefixStore(appUrl: string, token: string): PrefixStore {
  const url = (guildId: string) => `${appUrl}/api/internal/guilds/${guildId}/prefix`;
  return {
    async load(guildId) {
      const res = await fetch(url(guildId), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`prefix lookup failed (${res.status})`);
      const data = (await res.json()) as { prefix?: string | null };
      const parsed = parseCommandPrefix(data.prefix ?? "");
      return parsed.ok ? parsed.prefix : null;
    },
    async save(guildId, prefix) {
      const res = await fetch(url(guildId), {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prefix }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string; fix?: string } | null;
        throw new Error(data?.message ?? `prefix update failed (${res.status})`);
      }
    },
  };
}
