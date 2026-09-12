/**
 * Prefix-command configuration — the rules are shared so the bot
 * (`!prefix set`) and the dashboard's internal API route validate exactly
 * the same thing and can never disagree about what a legal prefix is.
 *
 * Monarch is slash-first: prefix commands are a convenience surface, so the
 * rules stay deliberately tight (short, punctuation-only, no whitespace) to
 * keep them from colliding with normal conversation.
 */

/** Used by every server until it picks its own with `!prefix set <prefix>`. */
export const DEFAULT_COMMAND_PREFIX = "!";

/** Prefixes are matched against every message, so they stay short. */
export const MAX_COMMAND_PREFIX_LENGTH = 4;

/**
 * Characters a prefix may end with — and, on their own, a prefix may be
 * built entirely from these. Deliberately punctuation: `@` would collide
 * with mentions, `/` with slash commands, and a bare letter or word would
 * swallow ordinary conversation ("help me" with prefix "h").
 *
 * Letters *are* allowed in front of that final punctuation, because `m!` and
 * `mo?` are the prefixes people actually ask for — the rule is that a prefix
 * must end in punctuation, so it can never be a plain word.
 */
export const COMMAND_PREFIX_CHARS = "!?.-_+*%&=<>~^:;";

/** Result of validating a candidate prefix. */
export type CommandPrefixResult =
  | { ok: true; prefix: string }
  | { ok: false; message: string };

function show(value: string): string {
  return `\`${value}\``;
}

/**
 * Characters that may never appear in a prefix at all: `@` and `/` belong to
 * mentions and slash commands, quotes and brackets would confuse the
 * argument tokenizer, `#` to a channel mention and backticks to code spans.
 */
const FORBIDDEN_CHARS = `@/\`"'$#[](){}|`;

/**
 * Validate a server's requested command prefix.
 *
 * Rules: 1–{@link MAX_COMMAND_PREFIX_LENGTH} characters, no whitespace, no
 * `@` (mentions) or `/` (slash commands), and it must end in punctuation —
 * so `?`, `m!` and `>>` are fine while `hey` is not. Comparison is
 * case-insensitive at match time, so the stored value is lowercased here.
 */
export function parseCommandPrefix(input: unknown): CommandPrefixResult {
  if (typeof input !== "string") {
    return { ok: false, message: "The prefix must be text." };
  }
  const prefix = input.trim().toLowerCase();
  if (prefix.length === 0) {
    return { ok: false, message: "The prefix can't be empty." };
  }
  if (prefix.length > MAX_COMMAND_PREFIX_LENGTH) {
    return {
      ok: false,
      message: `The prefix can be at most ${MAX_COMMAND_PREFIX_LENGTH} characters (got ${prefix.length}).`,
    };
  }
  if (/\s/.test(prefix)) {
    return { ok: false, message: "The prefix can't contain spaces." };
  }
  const forbidden = [...new Set(prefix.split("").filter((c) => FORBIDDEN_CHARS.includes(c)))];
  if (forbidden.length > 0) {
    return {
      ok: false,
      message: `${show(forbidden.join(""))} can't be used in a prefix — @ and / belong to mentions and slash commands.`,
    };
  }
  const last = prefix[prefix.length - 1]!;
  if (!COMMAND_PREFIX_CHARS.includes(last)) {
    return {
      ok: false,
      message:
        `A prefix has to end in punctuation like ${show("!")} or ${show("?")} — ${show(prefix)} would swallow ordinary words. ` +
        `Try ${show(`${prefix.slice(0, MAX_COMMAND_PREFIX_LENGTH - 1)}!`)} or ${show(COMMAND_PREFIX_CHARS)}.`,
    };
  }
  return { ok: true, prefix };
}

/** True when `value` is a legal prefix (used by zod refinements and tests). */
export function isCommandPrefix(value: unknown): boolean {
  return parseCommandPrefix(value).ok;
}
