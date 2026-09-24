import { CONFESSION_COOLDOWN_MS } from "@monarch/shared";

/**
 * The confession cooldown — one window per Discord user, **global across every
 * server**: confessing in server A is what makes you wait in server B too.
 *
 * The window itself lives in the dashboard's store (`ConfessionCooldown` table
 * / `confession-cooldowns.json`) and is reached through
 * `/api/internal/users/:id/confession-cooldown` with INTERNAL_API_TOKEN — the
 * bot keeps no database credentials of its own, same rule as the confession
 * channels (./confession.ts) and the command prefix (./prefix/registry.ts).
 * That is also why a restart or a redeploy does **not** hand everybody a fresh
 * confession: the clock is stored, not remembered.
 *
 * Two calls per confession, not one:
 *
 * - {@link ConfessionCooldowns.blockedUntil} answers the **Confess button**, so
 *   it can say "you can confess again in 5 hours" instead of opening a form
 *   whose submission would be refused a moment later. It is advisory and may be
 *   optimistic — being wrong costs one extra round trip on submit.
 * - {@link ConfessionCooldowns.claim} is the authoritative check, run on the
 *   **modal submit** right before posting. The dashboard decides it with a
 *   compare-and-set, so a double-click (or confessing in two servers at once)
 *   still produces exactly one post.
 * - {@link ConfessionCooldowns.release} hands a claimed window back when the
 *   post itself failed: a deleted channel or a lost permission must not lock
 *   somebody out of confessing for six hours.
 *
 * Degradation is deliberately **fail-open**: an unreachable dashboard lets the
 * confession through and says so in the log. The cooldown is anti-spam polish,
 * and when the dashboard is down the confession channels themselves already
 * read as "off" from the same API — failing closed here would only add a
 * second, more confusing reason for the same outage.
 */

/** The bot-facing seam over `GET|POST|DELETE /api/internal/users/:id/confession-cooldown`. */
export interface ConfessionCooldownStore {
  /** Epoch ms when they may confess again, or null. Throws on transport failure. */
  status(userId: string): Promise<number | null>;
  /** Reserve the window. "Still cooling down" is a result, not an error. */
  claim(userId: string): Promise<{ claimed: boolean; nextAllowedAt: number }>;
  /** Give the window back after a failed post. Throws on transport failure. */
  release(userId: string): Promise<void>;
}

/** The answer the confess flow acts on. */
export type ConfessionCooldownDecision =
  /**
   * The window is theirs — post the confession. `nextAllowedAt` is null when
   * nothing could be recorded (no store configured, or the dashboard is down),
   * which the reply wording reads as "don't promise a countdown".
   */
  | { allowed: true; nextAllowedAt: number | null }
  /** Still cooling down — `nextAllowedAt` is when they may confess again. */
  | { allowed: false; nextAllowedAt: number };

export interface ConfessionCooldownsOptions {
  /** Where windows are persisted; null = the cooldown isn't enforced. */
  store?: ConfessionCooldownStore | null;
  /**
   * Window lenght used for replies and as a fallback when the API answers
   * without a timestamp. The stored window belongs to the dashboard, and both
   * sides read the same shared constant.
   */
  cooldownMs?: number;
  now?: () => number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** Sweep the cache once it holds this many windows (they all expire anyway). */
const PRUNE_ABOVE = 500;

export class ConfessionCooldowns {
  /** userId → `nextAllowedAt` (epoch ms). Only live windows are ever stored. */
  private readonly cache = new Map<string, number>();
  private readonly store: ConfessionCooldownStore | null;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly log: ConfessionCooldownsOptions["log"];

  constructor(options: ConfessionCooldownsOptions = {}) {
    this.store = options.store ?? null;
    this.cooldownMs = options.cooldownMs ?? CONFESSION_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  /** Is the cooldown recorded anywhere that survives a restart? */
  get persistent(): boolean {
    return this.store !== null;
  }

  /** How long one confession locks that person out (for wording replies). */
  get windowMs(): number {
    return this.cooldownMs;
  }

  /**
   * When this user may confess again (epoch ms), or null when they may now.
   *
   * A learned window needs no TTL and no re-check: `nextAllowedAt` is absolute
   * and time only moves forward, so once it is in the past the answer is
   * "free" forever. Never throws — an unreachable store reads as "free" (the
   * submit-time claim is the check that matters).
   */
  async blockedUntil(userId: string): Promise<number | null> {
    const cached = this.cache.get(userId);
    if (cached !== undefined) {
      if (cached > this.now()) return cached;
      this.cache.delete(userId);
      return null;
    }
    if (!this.store) return null;
    try {
      const until = await this.store.status(userId);
      if (until !== null && until > this.now()) {
        this.remember(userId, until);
        return until;
      }
      return null;
    } catch (e) {
      this.log?.warn("confession cooldown lookup failed — letting them try", {
        userId,
        error: String(e),
      });
      return null;
    }
  }

  /**
   * Reserve the next window, atomically, right before the confession is
   * posted. `allowed: false` carries the running window's end so the reply can
   * be a countdown rather than a shrug.
   */
  async claim(userId: string): Promise<ConfessionCooldownDecision> {
    if (!this.store) return { allowed: true, nextAllowedAt: null };
    try {
      const result = await this.store.claim(userId);
      this.remember(userId, result.nextAllowedAt);
      return result.claimed
        ? { allowed: true, nextAllowedAt: result.nextAllowedAt }
        : { allowed: false, nextAllowedAt: result.nextAllowedAt };
    } catch (e) {
      // Fail open, loudly: the confession is the product, the cooldown is the
      // guard rail, and a dead dashboard shouldn't eat anybody's secret.
      this.log?.warn("confession cooldown unavailable — posting without recording a window", {
        userId,
        error: String(e),
      });
      return { allowed: true, nextAllowedAt: null };
    }
  }

  /** Give a claimed window back after a failed post. Best effort, never throws. */
  async release(userId: string): Promise<void> {
    this.cache.delete(userId);
    if (!this.store) return;
    try {
      await this.store.release(userId);
      this.log?.info("confession cooldown released after a failed post", { userId });
    } catch (e) {
      this.log?.warn("couldn't release the confession cooldown — they may have to wait it out", {
        userId,
        error: String(e),
      });
    }
  }

  /** Seed the cache (used by tests and after a claim). */
  remember(userId: string, nextAllowedAt: number): void {
    if (nextAllowedAt <= this.now()) {
      this.cache.delete(userId);
      return;
    }
    this.cache.set(userId, nextAllowedAt);
    if (this.cache.size > PRUNE_ABOVE) this.prune();
  }

  /** Forget everything (used by tests). */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [userId, until] of this.cache) {
      if (until <= now) this.cache.delete(userId);
    }
  }
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function apiMessage(data: unknown): string {
  const message = (data as { error?: { message?: unknown } } | null)?.error?.message;
  if (typeof message === "string" && message.length > 0 && message.length <= 300) return message;
  return "";
}

/** The internal-API-backed store the worker uses. */
export function internalConfessionCooldownStore(
  appUrl: string,
  token: string,
): ConfessionCooldownStore {
  const url = (userId: string) => `${appUrl}/api/internal/users/${userId}/confession-cooldown`;
  const headers = { Authorization: `Bearer ${token}` };
  return {
    async status(userId) {
      const res = await fetch(url(userId), { headers });
      if (!res.ok) throw new Error(`confession cooldown lookup failed (${res.status})`);
      const data = (await res.json()) as { nextAllowedAt?: string | null };
      return timestamp(data.nextAllowedAt);
    },
    async claim(userId) {
      const res = await fetch(url(userId), { method: "POST", headers });
      const data = (await res.json().catch(() => null)) as {
        claimed?: boolean;
        nextAllowedAt?: string | null;
      } | null;
      if (!res.ok) {
        throw new Error(apiMessage(data) || `confession cooldown claim failed (${res.status})`);
      }
      // The route answers 200 with `claimed: false` while a window is running.
      // Anything else that isn't an explicit `false` counts as claimed (fail
      // open), and a missing timestamp falls back to a full window from now so
      // the reply can still name a time.
      return {
        claimed: data?.claimed !== false,
        nextAllowedAt: timestamp(data?.nextAllowedAt) ?? Date.now() + CONFESSION_COOLDOWN_MS,
      };
    },
    async release(userId) {
      const res = await fetch(url(userId), { method: "DELETE", headers });
      if (!res.ok) throw new Error(`confession cooldown release failed (${res.status})`);
    },
  };
}
