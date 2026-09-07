/**
 * Jail registry — who is jailed, in which guild, until when.
 *
 * Kept in memory on purpose: a jail is a short-lived moderation gag, and the
 * bot is a single long-running gateway process. Entries expire on their
 * own; a restart releases everyone (moderators can re-jail). Persisting
 * this would mean giving the bot database credentials, which is a bigger
 * change than the feature warrants — see docs/architecture.md.
 */
export interface JailEntry {
  guildId: string;
  userId: string;
  /** Epoch ms; `null` = until released manually. */
  until: number | null;
  jailedBy: string;
  createdAt: number;
}

const key = (guildId: string, userId: string) => `${guildId}:${userId}`;

export class JailRegistry {
  private readonly entries = new Map<string, JailEntry>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly onExpire?: (entry: JailEntry) => void) {}

  jail(entry: Omit<JailEntry, "createdAt">): JailEntry {
    const k = key(entry.guildId, entry.userId);
    this.clearTimer(k);
    const full: JailEntry = { ...entry, createdAt: Date.now() };
    this.entries.set(k, full);
    if (full.until !== null) {
      const delay = Math.max(0, full.until - Date.now());
      // setTimeout tops out at ~24.8 days; chunk longer waits.
      const arm = (remaining: number) => {
        const step = Math.min(remaining, 2_000_000_000);
        const t = setTimeout(() => {
          if (step < remaining) return arm(remaining - step);
          this.entries.delete(k);
          this.timers.delete(k);
          this.onExpire?.(full);
        }, step);
        t.unref?.();
        this.timers.set(k, t);
      };
      arm(delay);
    }
    return full;
  }

  release(guildId: string, userId: string): JailEntry | null {
    const k = key(guildId, userId);
    const entry = this.entries.get(k) ?? null;
    this.entries.delete(k);
    this.clearTimer(k);
    return entry;
  }

  get(guildId: string, userId: string): JailEntry | null {
    const entry = this.entries.get(key(guildId, userId));
    if (!entry) return null;
    if (entry.until !== null && entry.until <= Date.now()) {
      this.release(guildId, userId);
      return null;
    }
    return entry;
  }

  isJailed(guildId: string, userId: string): boolean {
    return this.get(guildId, userId) !== null;
  }

  list(guildId: string): JailEntry[] {
    const now = Date.now();
    return [...this.entries.values()].filter(
      (e) => e.guildId === guildId && (e.until === null || e.until > now),
    );
  }

  get size(): number {
    return this.entries.size;
  }

  private clearTimer(k: string) {
    const t = this.timers.get(k);
    if (t) clearTimeout(t);
    this.timers.delete(k);
  }
}
