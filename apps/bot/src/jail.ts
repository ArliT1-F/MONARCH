/**
 * Jail — cute confinement.
 *
 * A jail entry says "this member may only talk in #jail, and everything they
 * say comes back adorable". The live half (role membership, channel
 * overwrites, webhook re-posts, deleting messages typed elsewhere) lives in
 * ./jail-manager.ts because it needs the gateway objects; this file owns the
 * entry bookkeeping and the text transformation.
 *
 * Entries are persisted through the dashboard's internal API whenever the
 * worker has `INTERNAL_API_TOKEN` (the same rule as the command prefix and
 * confessions), because a jail has to survive a redeploy — a member whose
 * role is still there but whose entry is gone would be confined forever with
 * nobody left to release them. Without a store the relay still works as a
 * pure in-memory gag, but `/monarch jail setup` refuses to arm confinement:
 * no store, no cell.
 */

export type JailStyle = "random" | "soft" | "cat" | "chaotic" | "pirate" | "shakespeare" | "robot";

/** The channel the cell lives in when Monarch creates it. */
export const JAIL_CHANNEL_NAME = "jail";

/** The managed role that marks a jailed member (and sees nothing else). */
export const JAIL_ROLE_NAME = "jailed";

export interface JailEntry {
  guildId: string;
  userId: string;
  /** Epoch ms; `null` means until the same /jail command is used again. */
  until: number | null;
  jailedBy: string;
  style: JailStyle;
  /** Free-text reason, shown in the confirmation and the staff log. */
  reason: string | null;
  createdAt: number;
}

export type JailInput = Omit<JailEntry, "createdAt" | "style" | "reason"> & {
  style?: JailStyle;
  reason?: string | null;
};

/** One style choice: what it is called, and whether it is a voter perk. */
export interface JailStyleChoice {
  name: string;
  value: JailStyle;
  /** Voter perks stay out of reach until top.gg counts a vote (see ./votes.ts). */
  voter: boolean;
}

export const JAIL_STYLES: readonly JailStyleChoice[] = [
  { name: "Random cute mix", value: "random", voter: false },
  { name: "Soft uwu", value: "soft", voter: false },
  { name: "Cat / nya", value: "cat", voter: false },
  { name: "Chaotic cute", value: "chaotic", voter: false },
  { name: "🏴‍☠️ Pirate (vote)", value: "pirate", voter: true },
  { name: "🎭 Shakespeare (vote)", value: "shakespeare", voter: true },
  { name: "🤖 Robot (vote)", value: "robot", voter: true },
];

/** The styles anyone can pick (the ones `random` draws from). */
export const FREE_JAIL_STYLES: readonly Exclude<JailStyle, "random">[] = ["soft", "cat", "chaotic"];

/** The styles that need a live top.gg vote. */
export const VOTER_JAIL_STYLES: readonly JailStyle[] = ["pirate", "shakespeare", "robot"];

export function isJailStyle(value: string): value is JailStyle {
  return JAIL_STYLES.some((style) => style.value === value);
}

export function isVoterJailStyle(style: JailStyle): boolean {
  return VOTER_JAIL_STYLES.includes(style);
}

/** A label for replies: "soft", "random" or "the pirate style". */
export function styleLabel(style: JailStyle): string {
  return style === "random" ? "a random cute style" : `the **${style}** style`;
}

// ── persistence (the bot-facing seam over the dashboard API) ─────────

/** What the dashboard stores for one jailed member (no Date objects). */
export interface StoredJailEntry {
  guildId: string;
  userId: string;
  /** ISO timestamp, or null for "until toggled off". */
  until: string | null;
  jailedBy: string;
  style: string;
  reason: string | null;
}

/** The bot-facing seam over `GET|PUT|DELETE /api/internal/guilds/:id/jail/entries`. */
export interface JailEntryStore {
  /** Every stored entry for a guild. Throws on transport failure. */
  list(guildId: string): Promise<StoredJailEntry[]>;
  /** Insert or replace one entry. Throws on transport failure. */
  put(entry: StoredJailEntry): Promise<void>;
  /** Drop one entry (release, expiry, or a member who left). */
  remove(guildId: string, userId: string): Promise<void>;
}

export const JAIL_ENTRY_STYLE_FALLBACK: JailStyle = "random";

// ── entries ──────────────────────────────────────────────────────────

const key = (guildId: string, userId: string) => `${guildId}:${userId}`;

export interface JailRegistryOptions {
  /** Where entries are persisted; null = the in-memory gag only. */
  store?: JailEntryStore | null;
  /** Called when a timed entry runs out (the manager removes the role). */
  onExpire?: (entry: JailEntry) => void;
  log?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** Entry registry for /jail. Timers are local; the entries are stored remotely. */
export class JailRegistry {
  private readonly entries = new Map<string, JailEntry>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Guilds whose stored entries were already pulled in (one hydrate each). */
  private readonly hydrated = new Set<string>();
  private readonly store: JailEntryStore | null;
  private readonly onExpire?: (entry: JailEntry) => void;
  private readonly log?: JailRegistryOptions["log"];

  constructor(options: JailRegistryOptions = {}) {
    this.store = options.store ?? null;
    this.onExpire = options.onExpire;
    this.log = options.log;
  }

  /** True when entries survive a restart (the confinement needs this). */
  get persistent(): boolean {
    return this.store !== null;
  }

  jail(entry: JailInput): JailEntry {
    const k = key(entry.guildId, entry.userId);
    this.clearTimer(k);
    const full: JailEntry = {
      ...entry,
      reason: entry.reason ?? null,
      style: entry.style ?? JAIL_ENTRY_STYLE_FALLBACK,
      createdAt: Date.now(),
    };
    this.entries.set(k, full);
    this.persist(full);
    if (full.until !== null) {
      const delay = Math.max(0, full.until - Date.now());
      // setTimeout tops out at roughly 24.8 days; chunk longer waits.
      const arm = (remaining: number) => {
        const step = Math.min(remaining, 2_000_000_000);
        const timer = setTimeout(() => {
          if (step < remaining) return arm(remaining - step);
          this.entries.delete(k);
          this.timers.delete(k);
          this.forget(full);
          this.onExpire?.(full);
        }, step);
        timer.unref?.();
        this.timers.set(k, timer);
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
    if (entry) this.forget(entry);
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
      (entry) => entry.guildId === guildId && (entry.until === null || entry.until > now),
    );
  }

  /**
   * Pull this guild's stored entries in once and arm their timers. Entries
   * whose window already passed are dropped from the store and returned to
   * the caller separately (`expired`) so the manager can strip their roles
   * instead of leaving somebody locked in a cell with no timer.
   *
   * Never throws: an unreachable dashboard leaves the guild as it is, and the
   * next call tries again.
   */
  async hydrate(
    guildId: string,
  ): Promise<{ entries: JailEntry[]; expired: StoredJailEntry[] }> {
    if (!this.store) return { entries: [], expired: [] };
    if (this.hydrated.has(guildId)) return { entries: this.list(guildId), expired: [] };
    let stored: StoredJailEntry[];
    try {
      stored = await this.store.list(guildId);
    } catch (e) {
      this.log?.warn("couldn't load jailed members — leaving them as they are", {
        guildId,
        error: String(e),
      });
      // Remember the attempt for this process only; a redeploy retries.
      return { entries: [], expired: [] };
    }
    this.hydrated.add(guildId);
    const expired: StoredJailEntry[] = [];
    for (const row of stored) {
      const until = row.until ? Date.parse(row.until) : null;
      if (until !== null && (!Number.isFinite(until) || until <= Date.now())) {
        expired.push(row);
        continue;
      }
      const k = key(guildId, row.userId);
      if (this.entries.has(k)) continue; // a fresher local entry already exists
      this.jail({
        guildId,
        userId: row.userId,
        until,
        jailedBy: row.jailedBy,
        style: isJailStyle(row.style) ? row.style : JAIL_ENTRY_STYLE_FALLBACK,
        reason: row.reason,
      });
    }
    return { entries: this.list(guildId), expired };
  }

  /** Every entry in memory (used by tests and shutdown bookkeeping). */
  all(): JailEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  /** Mark a guild as "never hydrated" again — e.g. after `jail disable`. */
  forgetHydration(guildId: string): void {
    this.hydrated.delete(guildId);
  }

  /** Release everyone in a guild locally (the manager removes the roles). */
  releaseGuild(guildId: string): JailEntry[] {
    const released = this.list(guildId);
    for (const entry of released) this.release(guildId, entry.userId);
    return released;
  }

  /** Drop every expired entry and hand them back (boot sweep). */
  pruneExpired(): JailEntry[] {
    const now = Date.now();
    const dead: JailEntry[] = [];
    for (const entry of [...this.entries.values()]) {
      if (entry.until !== null && entry.until <= now) dead.push(entry);
    }
    for (const entry of dead) this.release(entry.guildId, entry.userId);
    return dead;
  }

  // ── persistence (best-effort: the live relay must never be blocked) ──

  private persist(entry: JailEntry): void {
    if (!this.store) return;
    const row: StoredJailEntry = {
      guildId: entry.guildId,
      userId: entry.userId,
      until: entry.until === null ? null : new Date(entry.until).toISOString(),
      jailedBy: entry.jailedBy,
      style: entry.style,
      reason: entry.reason,
    };
    void this.store
      .put(row)
      .catch((e) =>
        this.log?.warn("couldn't save a jail entry — the timer still runs locally", {
          guildId: entry.guildId,
          userId: entry.userId,
          error: String(e),
        }),
      );
  }

  private forget(entry: JailEntry): void {
    if (!this.store) return;
    void this.store
      .remove(entry.guildId, entry.userId)
      .catch((e) =>
        this.log?.warn("couldn't clear a jail entry", {
          guildId: entry.guildId,
          userId: entry.userId,
          error: String(e),
        }),
      );
  }

  private clearTimer(k: string) {
    const timer = this.timers.get(k);
    if (timer) clearTimeout(timer);
    this.timers.delete(k);
  }
}

// ── the text itself ──────────────────────────────────────────────────

/**
 * Discord markup and things Discord renders as special objects should not be
 * rewritten: mentions, emoji, timestamps, links and code are copied
 * byte-for-byte so a jailed message can't break formatting or smuggle plain
 * text through.
 */
const PRESERVE =
  /(```[\s\S]*?```|`[^`\n]*`|<a?:\w+:\d+>|<[@#][!&]?\d+>|<t:\d+(?::[tTdDfFR])?>|https?:\/\/\S+)/g;

function pick<T>(items: readonly T[], random: () => number): T {
  const roll = random();
  // Math.random() never misbehaves, but an injected roller might — clamp
  // anything outside [0, 1) instead of indexing out of bounds.
  const safe = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 1 - Number.EPSILON) : 0;
  const index = Math.min(items.length - 1, Math.floor(safe * items.length));
  return items[index]!;
}

function cuteCase(ch: string): string {
  return ch === ch.toUpperCase() ? "W" : "w";
}

/** The predictable uwu spelling changes (soft / cat / chaotic). */
function uwuifyPlain(text: string): string {
  return (
    text
      // Do these before the single-word `you` replacement: "you're" → "ur" → "uw".
      .replace(/\b(?:you['’]?re|youre|your)\b/gi, "ur")
      .replace(/\byou\b/gi, "u")
      .replace(/\bare\b/gi, "aw")
      .replace(/\bfor\b/gi, "fow")
      // love → luv → wuv, which is the familiar cute spelling.
      .replace(/ove/gi, "uv")
      // "there" → "dewe" and "fuck" → "fukk" are intentionally a little
      // more playful than only replacing r/l.
      .replace(/th/gi, "d")
      .replace(/ck/gi, "kk")
      .replace(/[rl]/gi, cuteCase)
  );
}

/** Sailor-ish: ye/yer/be, and a berth for the odd "ahoy". */
function pirateSpeak(text: string): string {
  return text
    .replace(/\byou['’]?re\b/gi, "ye be")
    .replace(/\byour\b/gi, "yer")
    .replace(/\byou\b/gi, "ye")
    .replace(/\bare\b/gi, "be")
    .replace(/\bis\b/gi, "be")
    .replace(/\bmy\b/gi, "me")
    .replace(/\bhello\b/gi, "ahoy")
    .replace(/\bhi\b/gi, "ahoy")
    .replace(/\bfriend\b/gi, "matey");
}

/** Thee/thou, because a jail is a tragedy in five acts. */
function shakespeareSpeak(text: string): string {
  return text
    .replace(/\byou['’]?re\b/gi, "thou art")
    .replace(/\byour\b/gi, "thy")
    .replace(/\byou\b/gi, "thou")
    .replace(/\bare\b/gi, "art")
    .replace(/\bhave\b/gi, "hast")
    .replace(/\bdo\b/gi, "dost")
    .replace(/\bhello\b/gi, "good morrow")
    .replace(/\byes\b/gi, "aye");
}

/** BEEP. Deliberately only leets the vowels people expect. */
function robotSpeak(text: string): string {
  return text
    .replace(/\byou\b/gi, "y0u")
    .replace(/\bthe\b/gi, "th3")
    .replace(/\bare\b/gi, "4re")
    .replace(/\bto\b/gi, "t0")
    .replace(/\bfor\b/gi, "f0r");
}

interface StyleEngine {
  rewrite: (text: string) => string;
  suffixes: readonly string[];
  /** How often the first word stutters ("h-hello"). */
  stutterChance: number;
  /** How often a short word grows an extra letter ("howw"). */
  repeatChance: number;
}

const ENGINES: Record<Exclude<JailStyle, "random">, StyleEngine> = {
  soft: {
    rewrite: uwuifyPlain,
    suffixes: [" uwu~", " owo~", " >w<", " ^w^"],
    stutterChance: 0.14,
    repeatChance: 0.18,
  },
  cat: {
    rewrite: uwuifyPlain,
    suffixes: [" nya~", " nya nya~", " (=^.c.^=)", "mastaw~", "purr~"],
    stutterChance: 0.2,
    repeatChance: 0.18,
  },
  chaotic: {
    rewrite: uwuifyPlain,
    suffixes: [' uwu~ (" 3")', " owo!! >w<", " (≧ω≦)", " nya~ nya~"],
    stutterChance: 0.42,
    repeatChance: 0.45,
  },
  pirate: {
    rewrite: pirateSpeak,
    suffixes: [" arr!", " yarr!", " matey!", " avast!"],
    stutterChance: 0.1,
    repeatChance: 0.12,
  },
  shakespeare: {
    rewrite: shakespeareSpeak,
    suffixes: [" forsooth!", " verily!", " — good morrow!", " thou knave!"],
    stutterChance: 0.08,
    repeatChance: 0.1,
  },
  robot: {
    rewrite: robotSpeak,
    suffixes: [" BEEP BOOP.", " [01001110]", " *whirrr*", " EXTERMINATE?"],
    stutterChance: 0.05,
    repeatChance: 0.08,
  },
};

function stutterFirstWord(text: string): string {
  return text.replace(
    /^(\s*)([A-Za-z])([A-Za-z]*)/,
    (_match, space: string, first: string, rest: string) => {
      return `${space}${first}-${first}${rest}`;
    },
  );
}

/**
 * The in-text flourishes (stutter, repetition, chaotic extras) — everything
 * except the closing suffix, which is appended separately so it always lands
 * at the end of the message rather than in the middle of it.
 */
function flourish(text: string, style: Exclude<JailStyle, "random">, random: () => number): string {
  const engine = ENGINES[style];
  if (random() < engine.stutterChance) text = stutterFirstWord(text);

  // A tiny amount of repetition makes otherwise short messages feel varied:
  // "how" can become "howw", while short spellings such as "aw" and "uw"
  // remain readable rather than turning into "aww" and "uww" every time.
  if (random() < engine.repeatChance) {
    text = text.replace(/\b(how|wow|meow)\b/gi, (word) => `${word}w`);
  }

  // Chaotic mode gets one extra silly flourish occasionally. It is deliberately
  // opt-in/random so the default never turns every word into keyboard soup.
  if (style === "chaotic" && random() < 0.28) {
    text = text.replace(
      /\b([A-Za-z]*)(f)\b/gi,
      (_match, prefix: string, last: string) => `${prefix}${last}${last}`,
    );
  }
  return text;
}

/**
 * Convert a message into the chosen jail style.
 *
 * `random` is injectable so the transformation can be tested without flaky
 * assertions; production calls simply use Math.random. Mentions, emoji,
 * timestamps, links and inline/fenced code are copied byte-for-byte.
 */
export function toJailSpeak(
  text: string,
  style: JailStyle = "random",
  random: () => number = Math.random,
): string {
  const parts = text.split(PRESERVE);
  let hasPlainLetters = false;
  const converted = parts.map((part, index) => {
    if (index % 2 === 1) return part;
    if (/[A-Za-z]/.test(part)) hasPlainLetters = true;
    return part;
  });

  const chosenStyle: Exclude<JailStyle, "random"> =
    style !== "random" ? style : pick(FREE_JAIL_STYLES, random);

  if (!hasPlainLetters) return converted.join("");

  for (const [index, part] of parts.entries()) {
    // `index % 2 === 1` is protected syntax (mentions, links, code…).
    if (index % 2 === 1) continue;
    converted[index] = ENGINES[chosenStyle].rewrite(part);
  }

  // Flourish the first ordinary segment (so the stutter lands on the first
  // word) and close the *last* one with the style's suffix. Pinning both to
  // the first segment used to drop the ending mid-message whenever a mention
  // or URL split the text ("hewwo uwu~ <@123> how awe u?").
  const plainIndexes = parts
    .map((part, index) => ({ part, index }))
    .filter(({ part, index }) => index % 2 === 0 && /[A-Za-z]/.test(part))
    .map(({ index }) => index);
  const firstPlainIndex = plainIndexes[0] ?? -1;
  const lastPlainIndex = plainIndexes[plainIndexes.length - 1] ?? -1;
  if (firstPlainIndex >= 0) {
    converted[firstPlainIndex] = flourish(converted[firstPlainIndex]!, chosenStyle, random);
  }
  if (lastPlainIndex >= 0) {
    converted[lastPlainIndex] = `${converted[lastPlainIndex]}${pick(
      ENGINES[chosenStyle].suffixes,
      random,
    )}`;
  }
  return converted.join("");
}

/** Friendly alias for callers that prefer the verb over the feature name. */
export const jailSpeak = toJailSpeak;

/** The internal-API-backed entry store the worker uses. */
export function internalJailEntryStore(appUrl: string, token: string): JailEntryStore {
  const url = (guildId: string) => `${appUrl}/api/internal/guilds/${guildId}/jail/entries`;
  const headers = { Authorization: `Bearer ${token}` };
  return {
    async list(guildId) {
      const res = await fetch(url(guildId), { headers });
      if (!res.ok) throw new Error(`jail lookup failed (${res.status})`);
      const data = (await res.json()) as { entries?: StoredJailEntry[] };
      return Array.isArray(data.entries) ? data.entries : [];
    },
    async put(entry) {
      const res = await fetch(url(entry.guildId), {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          userId: entry.userId,
          until: entry.until,
          jailedBy: entry.jailedBy,
          style: entry.style,
          reason: entry.reason,
        }),
      });
      if (!res.ok) throw new Error(`jail save failed (${res.status})`);
    },
    async remove(guildId, userId) {
      const res = await fetch(`${url(guildId)}?userId=${encodeURIComponent(userId)}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok && res.status !== 404) throw new Error(`jail delete failed (${res.status})`);
    },
  };
}
