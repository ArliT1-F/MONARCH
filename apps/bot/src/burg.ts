/**
 * Burg — a cute, temporary message relay.
 *
 * A burg entry is intentionally kept in memory: it is a short-lived server
 * gag, not moderation state. A restart clears the entries and the timers.
 * The relay itself lives in index.ts because it needs the live Discord
 * message and webhook objects.
 */

export type BurgStyle = "random" | "soft" | "cat" | "chaotic";

export interface BurgEntry {
  guildId: string;
  userId: string;
  /** Epoch ms; `null` means until the same /burg command is used again. */
  until: number | null;
  burgedBy: string;
  style: BurgStyle;
  createdAt: number;
}

export type BurgInput = Omit<BurgEntry, "createdAt" | "style"> & { style?: BurgStyle };

export const BURG_STYLES = [
  { name: "Random cute mix", value: "random" },
  { name: "Soft uwu", value: "soft" },
  { name: "Cat / nya", value: "cat" },
  { name: "Chaotic cute", value: "chaotic" },
] as const;

const key = (guildId: string, userId: string) => `${guildId}:${userId}`;

/** In-memory timed registry for /burg entries. */
export class BurgRegistry {
  private readonly entries = new Map<string, BurgEntry>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly onExpire?: (entry: BurgEntry) => void) {}

  burg(entry: BurgInput): BurgEntry {
    const k = key(entry.guildId, entry.userId);
    this.clearTimer(k);
    const full: BurgEntry = { ...entry, style: entry.style ?? "random", createdAt: Date.now() };
    this.entries.set(k, full);
    if (full.until !== null) {
      const delay = Math.max(0, full.until - Date.now());
      // setTimeout tops out at roughly 24.8 days; chunk longer waits.
      const arm = (remaining: number) => {
        const step = Math.min(remaining, 2_000_000_000);
        const timer = setTimeout(() => {
          if (step < remaining) return arm(remaining - step);
          this.entries.delete(k);
          this.timers.delete(k);
          this.onExpire?.(full);
        }, step);
        timer.unref?.();
        this.timers.set(k, timer);
      };
      arm(delay);
    }
    return full;
  }

  release(guildId: string, userId: string): BurgEntry | null {
    const k = key(guildId, userId);
    const entry = this.entries.get(k) ?? null;
    this.entries.delete(k);
    this.clearTimer(k);
    return entry;
  }

  get(guildId: string, userId: string): BurgEntry | null {
    const entry = this.entries.get(key(guildId, userId));
    if (!entry) return null;
    if (entry.until !== null && entry.until <= Date.now()) {
      this.release(guildId, userId);
      return null;
    }
    return entry;
  }

  isBurg(guildId: string, userId: string): boolean {
    return this.get(guildId, userId) !== null;
  }

  /** Aliases that read naturally at different call sites. */
  isBurged(guildId: string, userId: string): boolean {
    return this.isBurg(guildId, userId);
  }

  isBurgified(guildId: string, userId: string): boolean {
    return this.isBurg(guildId, userId);
  }

  list(guildId: string): BurgEntry[] {
    const now = Date.now();
    return [...this.entries.values()].filter(
      (entry) => entry.guildId === guildId && (entry.until === null || entry.until > now),
    );
  }

  get size(): number {
    return this.entries.size;
  }

  private clearTimer(k: string) {
    const timer = this.timers.get(k);
    if (timer) clearTimeout(timer);
    this.timers.delete(k);
  }
}

/**
 * Discord markup and things Discord renders as special objects should not be
 * rewritten: mentions, emoji, timestamps, links and code are copied
 * byte-for-byte so a burg'd message can't break formatting or smuggle plain
 * text through.
 */
const PRESERVE =
  /(```[\s\S]*?```|`[^`\n]*`|<a?:\w+:\d+>|<[@#][!&]?\d+>|<t:\d+(?::[tTdDfFR])?>|https?:\/\/\S+)/g;

const SUFFIXES: Record<Exclude<BurgStyle, "random">, readonly string[]> = {
  soft: [" uwu~", " owo~", " >w<", " ^w^"],
  cat: [" nya~", " nya nya~", " (=^.c.^=)", "mastaw~", "purr~"],
  chaotic: [" uwu~ (\" 3\")", " owo!! >w<", " (≧ω≦)", " nya~ nya~"],
};

const STYLES: readonly Exclude<BurgStyle, "random">[] = ["soft", "cat", "chaotic"];

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

/** The predictable spelling changes shared by every burg style. */
function uwuifyPlain(text: string): string {
  return text
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
    .replace(/[rl]/gi, cuteCase);
}

function stutterFirstWord(text: string): string {
  return text.replace(/^(\s*)([A-Za-z])([A-Za-z]*)/, (_match, space: string, first: string, rest: string) => {
    return `${space}${first}-${first}${rest}`;
  });
}

/**
 * The in-text flourishes (stutter, repetition, chaotic extras) — everything
 * except the closing suffix, which is appended separately so it always lands
 * at the end of the message rather than in the middle of it.
 */
function flourish(text: string, style: Exclude<BurgStyle, "random">, random: () => number): string {
  const stutterChance = style === "chaotic" ? 0.42 : style === "cat" ? 0.2 : 0.14;
  if (random() < stutterChance) text = stutterFirstWord(text);

  // A tiny amount of repetition makes otherwise short messages feel varied:
  // "how" can become "howw", while short spellings such as "aw" and "uw"
  // remain readable rather than turning into "aww" and "uww" every time.
  const repeatChance = style === "chaotic" ? 0.45 : 0.18;
  if (random() < repeatChance) text = text.replace(/\b(how|wow|meow)\b/gi, (word) => `${word}w`);

  // Chaotic mode gets one extra silly flourish occasionally. It is deliberately
  // opt-in/random so the default never turns every word into keyboard soup.
  if (style === "chaotic" && random() < 0.28) {
    text = text.replace(/\b([A-Za-z]*)(f)\b/gi, (_match, prefix: string, last: string) => `${prefix}${last}${last}`);
  }
  return text;
}

/**
 * Convert a message into readable uwu/owo text.
 *
 * `random` is injectable so the transformation can be tested without flaky
 * assertions; production calls simply use Math.random. Mentions, emoji,
 * timestamps, links and inline/fenced code are copied byte-for-byte.
 */
export function toBurg(
  text: string,
  style: BurgStyle = "random",
  random: () => number = Math.random,
): string {
  const parts = text.split(PRESERVE);
  let hasPlainLetters = false;
  const converted = parts.map((part, index) => {
    if (index % 2 === 1) return part;
    if (/[A-Za-z]/.test(part)) hasPlainLetters = true;
    return uwuifyPlain(part);
  });

  if (!hasPlainLetters) return converted.join("");

  const chosenStyle =
    style === "soft" || style === "cat" || style === "chaotic" ? style : pick(STYLES, random);
  // Flourish the first ordinary segment (so the stutter lands on the first
  // word) and close the *last* one with the cute suffix. Pinning both to the
  // first segment used to drop the ending mid-message whenever a mention or
  // URL split the text ("hewwo uwu~ <@123> how awe u?").
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
    converted[lastPlainIndex] = `${converted[lastPlainIndex]}${pick(SUFFIXES[chosenStyle], random)}`;
  }
  return converted.join("");
}

/** Friendly alias for callers that prefer the verb over the feature name. */
export const burgify = toBurg;
