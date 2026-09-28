/**
 * The jail *cell* configuration — which channel jailed members may talk in,
 * which role marks them, and which roles are staff (and may watch).
 *
 * It lives in the dashboard's store (`GuildSettings.jailChannelId` /
 * `jailRoleId` / `jailStaffRoles`) and is reached through the internal API
 * with `INTERNAL_API_TOKEN` — the bot process deliberately holds no database
 * credentials, exactly like the command prefix (./prefix/registry.ts) and the
 * confession channels (./confession.ts). A cell that forgot itself on every
 * restart would leave role-jailed members with no way back out.
 *
 * Reads are cached per guild with a short TTL so the message relay never
 * waits on the network: while a member is jailed, every message they type
 * asks "is this channel the cell?".
 */

/** The cell, or null when this guild never set one up. */
export interface JailConfig {
  guildId: string;
  /** #jail — where jailed members may read and write. */
  channelId: string;
  /** The managed @jailed role. */
  roleId: string;
  /** Roles (besides the auto-detected moderation roles) allowed to see #jail. */
  staffRoleIds: string[];
}

/** The bot-facing seam over `GET|PUT /api/internal/guilds/:id/jail`. */
export interface JailConfigStore {
  load(guildId: string): Promise<JailConfig | null>;
  save(guildId: string, config: JailConfig | null): Promise<void>;
}

export interface JailConfigRegistryOptions {
  /** Where the cell is persisted; null = setup is unavailable. */
  store?: JailConfigStore | null;
  ttlMs?: number;
  now?: () => number;
  log?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  config: JailConfig | null;
  expiresAt: number;
}

const SNOWFLAKE = /^\d{15,25}$/;

/** Keep only well-formed role ids — a hand-edited row must not arm a deny. */
export function sanitizeStaffRoleIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && SNOWFLAKE.test(id)))];
}

export class JailConfigRegistry {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly store: JailConfigStore | null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly log: JailConfigRegistryOptions["log"];

  constructor(options: JailConfigRegistryOptions = {}) {
    this.store = options.store ?? null;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  /** Can this instance remember a cell at all? */
  get persistent(): boolean {
    return this.store !== null;
  }

  /** The cell right now, or null. Cached; never throws. */
  async get(guildId: string): Promise<JailConfig | null> {
    const hit = this.cache.get(guildId);
    if (hit && hit.expiresAt > this.now()) return hit.config;
    if (!this.store) return null;
    try {
      const config = await this.store.load(guildId);
      this.remember(guildId, config);
      return config;
    } catch (e) {
      // Cache the miss for the TTL: an unreachable dashboard must not turn
      // every jailed message into a failed fetch.
      this.cache.set(guildId, { config: null, expiresAt: this.now() + this.ttlMs });
      this.log?.warn("couldn't load the jail setup — confinement reads as off", {
        guildId,
        error: String(e),
      });
      return null;
    }
  }

  /**
   * The cell *without* any I/O: whatever the cache holds right now. Used on
   * the hot message path, where a cold cache degrades to "no cell" for one
   * message rather than blocking the relay behind a fetch.
   */
  peek(guildId: string): JailConfig | null {
    const hit = this.cache.get(guildId);
    if (!hit || hit.expiresAt <= this.now()) return null;
    return hit.config;
  }

  /** Save (or with `null`, remove) the cell. Stores user-presentable errors. */
  async set(
    guildId: string,
    config: JailConfig | null,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!this.store) {
      return {
        ok: false,
        message:
          "❌ The jail cell is saved through the Monarch dashboard, and this bot can't reach it — " +
          "set `INTERNAL_API_TOKEN` in the dashboard and bot environments. " +
          "The `/jail` relay still works without a cell.",
      };
    }
    try {
      await this.store.save(guildId, config);
    } catch (e) {
      const detail = (e as { message?: unknown } | null)?.message;
      return {
        ok: false,
        message:
          "❌ Couldn't save the jail setup." +
          (typeof detail === "string" && detail.length > 0 && detail.length <= 300
            ? `\n${detail}`
            : "\nTry again in a moment."),
      };
    }
    this.remember(guildId, config);
    return { ok: true };
  }

  /** Seed the cache (after a successful write, or in tests). */
  remember(guildId: string, config: JailConfig | null): void {
    this.cache.set(guildId, { config, expiresAt: this.now() + this.ttlMs });
  }

  clear(): void {
    this.cache.clear();
  }
}

/** The internal-API-backed store the worker uses. */
export function internalJailConfigStore(appUrl: string, token: string): JailConfigStore {
  const url = (guildId: string) => `${appUrl}/api/internal/guilds/${guildId}/jail`;
  const headers = { Authorization: `Bearer ${token}` };
  return {
    async load(guildId) {
      const res = await fetch(url(guildId), { headers });
      if (!res.ok) throw new Error(`jail setup lookup failed (${res.status})`);
      const data = (await res.json()) as {
        channelId?: string | null;
        roleId?: string | null;
        staffRoleIds?: unknown;
      };
      // A half-configured row (channel but no role, or the reverse) reads as
      // "no cell": confinement must never arm with one half missing.
      if (
        typeof data.channelId !== "string" ||
        !SNOWFLAKE.test(data.channelId) ||
        typeof data.roleId !== "string" ||
        !SNOWFLAKE.test(data.roleId)
      ) {
        return null;
      }
      return {
        guildId,
        channelId: data.channelId,
        roleId: data.roleId,
        staffRoleIds: sanitizeStaffRoleIds(data.staffRoleIds),
      };
    },
    async save(guildId, config) {
      const res = await fetch(url(guildId), {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(
          config === null
            ? { channelId: null, roleId: null, staffRoleIds: [] }
            : {
                channelId: config.channelId,
                roleId: config.roleId,
                staffRoleIds: config.staffRoleIds,
              },
        ),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? `jail setup save failed (${res.status})`);
      }
    },
  };
}
