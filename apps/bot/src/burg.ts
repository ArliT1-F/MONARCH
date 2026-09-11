/**
 * Burg — a cute, temporary message relay.
 *
 * A burg entry is intentionally kept in memory, just like the jail registry:
 * it is a short-lived server gag, not moderation state. A restart clears the
 * entries and the timers. The relay itself lives in index.ts because it needs
 * the live Discord message and webhook objects.
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
 * rewritten. This mirrors the safety boundary used by the Galactic relay.
 */
const PRESERVE =
  /(```[\s\S]*?```|`[^`\n]*`|<a?:\w+:\d+>|<[@#][!&]?\d+>|<t:\d+(?::[tTdDfFR])?>|https?:\/\/\S+)/g;

const SUFFIXES: Record<Exclude<BurgStyle, "random">, readonly string[]> = {
  soft: [" uwu~", " owo~", " >w<", " ^w^"],
  cat: [" nya~", " nya nya~", " (=^.c.^=)", " mrrp~"],
  chaotic: [" uwu~ (\" 3\")", " owo!! >w<", " (≧ω≦)", " nya~ nya~"],
};

const STYLES: readonly Exclude<BurgStyle, "random">[] = ["soft", "cat", "chaotic"];

function pick<T>(items: readonly T[], random: () => number): T {
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)));
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

function decorate(text: string, style: Exclude<BurgStyle, "random">, random: () => number): string {
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
  return `${text}${pick(SUFFIXES[style], random)}`;
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
  // Decorate the first ordinary segment only. This means a message beginning
  // with a mention or URL keeps that object untouched; later text still gets
  // the spelling transform and the cute ending.
  const firstPlainIndex = parts.findIndex((part, index) => index % 2 === 0 && /[A-Za-z]/.test(part));
  if (firstPlainIndex >= 0) converted[firstPlainIndex] = decorate(converted[firstPlainIndex]!, chosenStyle, random);
  return converted.join("");
}

/** Friendly alias for callers that prefer the verb over the feature name. */
export const burgify = toBurg;
