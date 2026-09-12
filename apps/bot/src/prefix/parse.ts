/**
 * Prefix-command parsing and routing — pure functions, no Discord objects,
 * so the whole text-command surface is unit-testable without a gateway.
 *
 * Two things live here:
 *
 * 1. {@link extractPrefixCommand} — "does this message start with the bot's
 *    prefix (or an @Monarch mention), and what's left after it?" Tokenizing
 *    keeps `"double quoted"` arguments together and rewrites
 *    `<@123>` / `<#123>` mentions to bare snowflakes so handlers get ids.
 * 2. {@link matchCommand} — "which command is that?" It knows the full
 *    mirror of the slash tree (`!monarch jail`, `!music play`) plus the
 *    short aliases (`!jail`, `!play`). The alias table is checked against
 *    the shared command catalog by a test, so `prefixAliases` in
 *    `@monarch/shared` can't drift from what the bot actually answers to.
 */

/** A parsed prefix invocation, before routing. */
export interface PrefixInvocation {
  /** The prefix text that matched (a mention keeps its raw `<@…>` form). */
  readonly prefix: string;
  /** True when the command was addressed with an @Monarch mention. */
  readonly viaMention: boolean;
  /** Everything after the prefix, with mentions rewritten to ids. */
  readonly content: string;
  /** Command words, lowercased — `["music", "play"]`. */
  readonly tokens: string[];
  /** Arguments after the command words, original casing preserved. */
  readonly args: string[];
}

/** What a message routed to. */
export type PrefixMatch =
  | { kind: "command"; surface: "monarch"; sub: string; args: string[]; viaMention: boolean }
  | { kind: "command"; surface: "burg"; args: string[]; viaMention: boolean }
  | { kind: "command"; surface: "music"; sub: string; args: string[]; viaMention: boolean }
  /**
   * The prefix (or a bare mention) with nothing after it. Only mentions get
   * an answer — a lone `!` in a busy channel must stay silent.
   */
  | { kind: "bare"; viaMention: boolean }
  /** Addressed to Monarch but not a command we know. */
  | { kind: "unknown"; token: string; viaMention: boolean }
  /** Not a Monarch message at all — ignore it silently. */
  | { kind: "ignore" };

/** `music` subcommand → short aliases, mirrored from `MUSIC_COMMANDS`. */
export const MUSIC_PREFIX_ALIASES: Readonly<Record<string, readonly string[]>> = {
  play: ["play", "p"],
  pause: ["pause"],
  resume: ["resume"],
  skip: ["skip", "voteskip"],
  queue: ["queue", "q"],
  nowplaying: ["nowplaying", "np"],
  volume: ["volume", "vol"],
  loop: ["loop"],
  shuffle: ["shuffle"],
  remove: ["remove"],
  clear: ["clear"],
  stop: ["stop", "leave"],
};

/** `monarch` subcommand → short aliases, mirrored from `MONARCH_COMMANDS`. */
export const MONARCH_PREFIX_ALIASES: Readonly<Record<string, readonly string[]>> = {
  help: ["help", "commands"],
  dashboard: ["dashboard"],
  invite: ["invite", "add"],
  status: ["status"],
  prefix: ["prefix"],
  backup: ["backup"],
  export: ["export"],
  embed: ["embed"],
  test: ["test"],
  jail: ["jail"],
  unjail: ["unjail"],
  jailed: ["jailed"],
};

/** Roots that mean "the next word is a subcommand". */
const GROUP_ROOTS = new Set(["monarch", "music"]);

/** Every short alias, used to tell command words from arguments. */
const ALIAS_WORDS = new Set<string>([
  "burg",
  ...Object.values(MONARCH_PREFIX_ALIASES).flat(),
  ...Object.values(MUSIC_PREFIX_ALIASES).flat(),
]);

/**
 * How many leading words are the command path — everything after them is
 * arguments. Decided by the known-command tables, not by "looks like a word",
 * so `!play daft punk around the world` keeps its whole search phrase while
 * `!monarch jail @user 10m` still reads as a two-word command.
 */
function commandWordCount(tokens: readonly string[]): number {
  const [head, second] = tokens as [string | undefined, string | undefined];
  if (!head) return 0;
  if (GROUP_ROOTS.has(head)) return second ? 2 : 1;
  return ALIAS_WORDS.has(head) ? 1 : 0;
}

/** `<@123>`, `<@!123>`, `<#123>`, `<@&123>` → `123`. */
const MENTION_TO_ID = /<@!?(\d{15,25})>|<#(\d{15,25})>|<@&(\d{15,25})>/g;

/**
 * Split command text into tokens: whitespace-separated, `"double quoted"`
 * spans kept together, mentions reduced to their snowflake. Unbalanced
 * quotes just run to the end of the line (people type on phones).
 */
export function parseArgs(input: string): string[] {
  const text = input.replace(MENTION_TO_ID, (_m, user?: string, channel?: string, role?: string) =>
    user ?? channel ?? role ?? "",
  );
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let hasToken = false;

  const flush = () => {
    if (hasToken) tokens.push(current);
    current = "";
    hasToken = false;
  };

  for (const char of text) {
    if (char === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
    hasToken = true;
  }
  flush();
  return tokens;
}

/**
 * Does this message start with one of the guild's prefixes (or mention the
 * bot first)? Returns null when it isn't a Monarch message — the caller then
 * carries on with whatever else it does for messages (the jail/burg relays).
 *
 * `prefixes` must already be sorted longest-first so a server that configured
 * `!!` gets `!!help` read as `!!` + `help`, not `!` + `!help`.
 */
export function extractPrefixCommand(
  content: string,
  prefixes: readonly string[],
  botUserId: string | null,
): PrefixInvocation | null {
  const text = content.trimStart();
  if (text.length === 0) return null;

  // 1) "@Monarch help" — the prefix nobody has to configure or remember.
  if (botUserId) {
    const mention = new RegExp(`^<@!?${botUserId}>\\s*`);
    const match = mention.exec(text);
    if (match) {
      const rest = text.slice(match[0].length);
      return build(rest, match[0].trim(), true);
    }
  }

  // 2) Text prefixes, longest first, case-insensitive.
  for (const prefix of prefixes) {
    if (prefix.length === 0) continue;
    if (text.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) continue;
    // Whatever follows the prefix is tokenized as-is. Monarch never has to
    // guess whether `!!help` or `!=` was meant for it: an unrecognized first
    // word is ignored silently (see matchCommand), so other bots' prefixes and
    // ordinary punctuation are left alone by construction.
    return build(text.slice(prefix.length), prefix, false);
  }

  return null;
}

function build(rest: string, prefix: string, viaMention: boolean): PrefixInvocation {
  const words = parseArgs(rest);
  const lowered = words.map((word) => word.toLowerCase());
  const commandCount = commandWordCount(lowered);
  return {
    prefix,
    viaMention,
    content: rest.trim(),
    tokens: lowered.slice(0, commandCount),
    // Arguments keep their original casing: search phrases and backup names
    // are typed by humans.
    args: words.slice(commandCount),
  };
}

/**
 * Route a parsed invocation to a command.
 *
 * Unknown `!words` are ignored on purpose (`{ kind: "ignore" }`): plenty of
 * servers run other bots on `!`, and Monarch must not answer their prefixes.
 * Anything addressed with a mention, or under the `monarch` / `music` roots,
 * is unambiguously ours, so a typo there gets a helpful reply instead.
 */
export function matchCommand(invocation: PrefixInvocation): PrefixMatch {
  const { tokens, args, viaMention } = invocation;

  // No command path: either nothing was typed after the prefix ("bare"), or
  // the first word simply isn't a command we know.
  if (tokens.length === 0) {
    const word = /^([^\s"]+)/u.exec(invocation.content.trim())?.[1];
    if (!word) return { kind: "bare", viaMention };
    return viaMention ? { kind: "unknown", token: word.toLowerCase(), viaMention } : { kind: "ignore" };
  }

  const [head, second] = tokens as [string, string | undefined];

  if (head === "burg") return { kind: "command", surface: "burg", args: second ? [second, ...args] : args, viaMention };

  if (GROUP_ROOTS.has(head!)) {
    if (!second) return { kind: "unknown", token: head!, viaMention };
    const rest = args;
    return head === "music"
      ? { kind: "command", surface: "music", sub: second, args: rest, viaMention }
      : { kind: "command", surface: "monarch", sub: second, args: rest, viaMention };
  }

  // Short aliases. `prefix` and `burg` are their own words; everything else
  // maps onto a monarch or music subcommand.
  for (const [sub, aliases] of Object.entries(MONARCH_PREFIX_ALIASES)) {
    if (aliases.includes(head!)) {
      return { kind: "command", surface: "monarch", sub, args: second ? [second, ...args] : args, viaMention };
    }
  }
  for (const [sub, aliases] of Object.entries(MUSIC_PREFIX_ALIASES)) {
    if (aliases.includes(head!)) {
      return { kind: "command", surface: "music", sub, args: second ? [second, ...args] : args, viaMention };
    }
  }

  // A known group root always gets an answer; anything else that reached
  // here is an unrecognized word (kept for safety — commandWordCount usually
  // classifies those above).
  return viaMention || GROUP_ROOTS.has(head!)
    ? { kind: "unknown", token: head!, viaMention }
    : { kind: "ignore" };
}
