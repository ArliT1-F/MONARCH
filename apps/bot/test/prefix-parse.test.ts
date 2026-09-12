import { describe, expect, it } from "vitest";
import {
  COMMAND_CATALOG,
  DEFAULT_COMMAND_PREFIX,
  MONARCH_COMMANDS,
  MUSIC_COMMANDS,
  BURG_COMMANDS,
} from "@monarch/shared";
import {
  MUSIC_PREFIX_ALIASES,
  MONARCH_PREFIX_ALIASES,
  extractPrefixCommand,
  matchCommand,
  parseArgs,
} from "../src/prefix/parse.js";

/**
 * Prefix-command parsing and routing — the pure half of the text surface.
 * These are the rules that decide whether a message is Monarch's business at
 * all, so they are tested directly: quoting, mentions, case, the "don't
 * answer other bots' prefixes" silence rule, and the alias table that has to
 * stay in sync with the shared command catalog.
 */

const BOT_ID = "123456789012345678";
const PREFIXES = [DEFAULT_COMMAND_PREFIX];

const invoke = (content: string, prefixes: readonly string[] = PREFIXES) =>
  extractPrefixCommand(content, prefixes, BOT_ID);

describe("parseArgs", () => {
  it("splits on whitespace", () => {
    expect(parseArgs("play some song")).toEqual(["play", "some", "song"]);
  });

  it("keeps quoted spans together", () => {
    expect(parseArgs('backup "before summer cleanup"')).toEqual(["backup", "before summer cleanup"]);
    expect(parseArgs('burg 123 "10m" "spam in general"')).toEqual(["burg", "123", "10m", "spam in general"]);
  });

  it("treats an unbalanced quote as running to the end", () => {
    expect(parseArgs('play "never gonna give')).toEqual(["play", "never gonna give"]);
  });

  it("rewrites user, channel and role mentions to snowflakes", () => {
    expect(parseArgs("burg <@111111111111111> 10m")).toEqual(["burg", "111111111111111", "10m"]);
    expect(parseArgs("<@!333333333333333> hi")).toEqual(["333333333333333", "hi"]);
    expect(parseArgs("test message <#222222222222222>")).toEqual(["test", "message", "222222222222222"]);
    expect(parseArgs("<@&444444444444444>")).toEqual(["444444444444444"]);
  });

  it("collapses repeated whitespace and trims", () => {
    expect(parseArgs("  skip   now  ")).toEqual(["skip", "now"]);
  });
});

describe("extractPrefixCommand", () => {
  it("recognizes the configured prefix", () => {
    const parsed = invoke("!help");
    expect(parsed).toMatchObject({ prefix: "!", viaMention: false, tokens: ["help"], args: [] });
  });

  it("is case-insensitive about both prefix and command", () => {
    expect(invoke("!HELP")).toMatchObject({ tokens: ["help"] });
    const parsed = invoke("?Play daft punk", ["?"]);
    expect(parsed).toMatchObject({ prefix: "?", tokens: ["play"], args: ["daft", "punk"] });
  });

  it("recognizes an @Monarch mention as a prefix", () => {
    const parsed = invoke(`<@${BOT_ID}> queue 2`);
    expect(parsed).toMatchObject({ viaMention: true, tokens: ["queue"], args: ["2"] });
    expect(invoke(`<@!${BOT_ID}> help`)).toMatchObject({ viaMention: true, tokens: ["help"] });
  });

  it("keeps a two-word command path together", () => {
    expect(invoke("!monarch burged")).toMatchObject({
      tokens: ["monarch", "burged"],
      args: [],
    });
    expect(invoke("!music play around the world")).toMatchObject({
      tokens: ["music", "play"],
      args: ["around", "the", "world"],
    });
  });

  it("stops the command path at the first non-word argument", () => {
    // `!play daft punk …` must keep its whole search phrase.
    expect(invoke("!play https://youtu.be/abc")).toMatchObject({ tokens: ["play"], args: ["https://youtu.be/abc"] });
    expect(invoke("!burg <@111111111111111>")).toMatchObject({ tokens: ["burg"], args: ["111111111111111"] });
    expect(invoke("!volume 80")).toMatchObject({ tokens: ["volume"], args: ["80"] });
  });

  it("prefers the longest matching prefix", () => {
    const parsed = invoke("!!help", ["!!", "!"]);
    expect(parsed).toMatchObject({ prefix: "!!", tokens: ["help"] });
  });

  it("tokenizes punctuation after the prefix instead of guessing", () => {
    // Whether these are commands is matchCommand's job — and it says no.
    expect(invoke("!= 5")).toMatchObject({ tokens: [], args: ["=", "5"] });
    expect(invoke("!!help")).toMatchObject({ prefix: "!", tokens: [], args: ["!help"] });
    expect(invoke("…")).toBeNull(); // "…" is not a configured prefix
  });

  it("keeps alphanumeric prefixes working in front of a word", () => {
    // `m!` must not be rejected just because punctuation ends it.
    expect(invoke("m!prefix reset", ["m!", "!"])).toMatchObject({
      prefix: "m!",
      tokens: ["prefix"],
      args: ["reset"],
    });
    expect(invoke("m!help", ["m!", "!"])).toMatchObject({ prefix: "m!", tokens: ["help"] });
  });

  it("ignores ordinary messages", () => {
    expect(invoke("hello there")).toBeNull();
    expect(invoke("")).toBeNull();
    expect(invoke("help me with this")).toBeNull();
  });

  it("does not treat another bot's mention as ours", () => {
    expect(invoke("<@999999999999999999> help")).toBeNull();
  });

  it("handles leading whitespace and a bare prefix", () => {
    expect(invoke("   !help")).toMatchObject({ tokens: ["help"] });
    expect(invoke("!")).toMatchObject({ tokens: [], args: [] });
    expect(invoke(`<@${BOT_ID}>`)).toMatchObject({ viaMention: true, tokens: [] });
  });
});

describe("matchCommand", () => {
  const match = (content: string, prefixes: readonly string[] = PREFIXES) => {
    const parsed = invoke(content, prefixes);
    expect(parsed, `expected ${content} to parse`).not.toBeNull();
    return matchCommand(parsed!);
  };

  it("routes short aliases to the right surface", () => {
    expect(match("!help")).toMatchObject({ kind: "command", surface: "monarch", sub: "help", args: [] });
    expect(match("!burged")).toMatchObject({
      kind: "command",
      surface: "monarch",
      sub: "burged",
      args: [],
    });
    expect(match("!prefix set ?")).toMatchObject({ surface: "monarch", sub: "prefix", args: ["set", "?"] });
    expect(match("!invite")).toMatchObject({ surface: "monarch", sub: "invite", args: [] });
    expect(match("!add")).toMatchObject({ surface: "monarch", sub: "invite" });
    expect(match("!play daft punk")).toMatchObject({ surface: "music", sub: "play", args: ["daft", "punk"] });
    expect(match("!np")).toMatchObject({ surface: "music", sub: "nowplaying" });
    expect(match("!q 2")).toMatchObject({ surface: "music", sub: "queue", args: ["2"] });
    expect(match("!leave")).toMatchObject({ surface: "music", sub: "stop" });
    expect(match("!burg <@111111111111111> cat")).toMatchObject({
      kind: "command",
      surface: "burg",
      args: ["111111111111111", "cat"],
    });
  });

  it("routes the mirrored slash tree", () => {
    expect(match("!monarch burged")).toMatchObject({ surface: "monarch", sub: "burged" });
    expect(match("!monarch prefix m!")).toMatchObject({ surface: "monarch", sub: "prefix", args: ["m!"] });
    expect(match("!monarch invite")).toMatchObject({ surface: "monarch", sub: "invite" });
    expect(match("!music play around the world")).toMatchObject({
      surface: "music",
      sub: "play",
      args: ["around", "the", "world"],
    });
    expect(match("!music nowplaying")).toMatchObject({ surface: "music", sub: "nowplaying" });
  });

  it("accepts a custom prefix", () => {
    expect(match("?play something", ["?"])).toMatchObject({ surface: "music", sub: "play" });
    expect(match(">>help", [">>"])).toMatchObject({ surface: "monarch", sub: "help" });
  });

  it("silently ignores unknown !words — other bots' prefixes are not ours", () => {
    expect(match("!ban @user")).toEqual({ kind: "ignore" });
    expect(match("!ping")).toEqual({ kind: "ignore" });
    expect(match("!")).toEqual({ kind: "bare", viaMention: false });
    expect(match("!= 5")).toEqual({ kind: "ignore" });
    // Somebody else's longer prefix reads as an unknown word, so: silence.
    expect(match("!!help")).toEqual({ kind: "ignore" });
    expect(match("!-play")).toEqual({ kind: "ignore" });
  });

  it("answers when Monarch is addressed directly", () => {
    expect(match(`<@${BOT_ID}> frobnicate`)).toEqual({ kind: "unknown", token: "frobnicate", viaMention: true });
    expect(match(`<@${BOT_ID}>`)).toEqual({ kind: "bare", viaMention: true });
    expect(match("!monarch")).toEqual({ kind: "unknown", token: "monarch", viaMention: false });
    expect(match("!music")).toEqual({ kind: "unknown", token: "music", viaMention: false });
  });
});

describe("alias table ⇄ shared command catalog", () => {
  /** `usage` "/monarch burged" → "burged". */
  const subOf = (usage: string) => usage.split(" ")[1]!;

  it("documents prefix usage for every command", () => {
    for (const doc of COMMAND_CATALOG) {
      expect(doc.prefixUsage, `${doc.name} is missing prefixUsage`).toBeTruthy();
      expect(doc.prefixUsage!.startsWith(DEFAULT_COMMAND_PREFIX), doc.name).toBe(true);
      expect((doc.prefixAliases ?? []).length, `${doc.name} has no alias`).toBeGreaterThan(0);
    }
  });

  it("writes prefix usage with the default prefix and matching arguments", () => {
    for (const doc of COMMAND_CATALOG) {
      const prefixForm = doc.prefixUsage!;
      // "!monarch burged" ⇄ "/monarch burged"
      const slashTail = doc.usage.slice(1);
      const prefixTail = prefixForm.slice(DEFAULT_COMMAND_PREFIX.length);
      expect(prefixTail.startsWith(slashTail.split(" ")[0]!)).toBe(true);
      const optionCount = (text: string) => (text.match(/[[<]/g) ?? []).length;
      expect(optionCount(prefixForm), `${doc.name}: option count differs`).toBe(optionCount(doc.usage));
    }
  });

  it("routes every cataloged monarch alias", () => {
    for (const doc of MONARCH_COMMANDS) {
      const sub = subOf(doc.usage);
      const aliases = MONARCH_PREFIX_ALIASES[sub] ?? [];
      expect(aliases.length, `${doc.name} has no alias entry`).toBeGreaterThan(0);
      expect([...aliases].sort()).toEqual([...(doc.prefixAliases ?? [])].sort());
      for (const alias of aliases) {
        const parsed = extractPrefixCommand(`!${alias}`, PREFIXES, BOT_ID)!;
        expect(matchCommand(parsed)).toMatchObject({ kind: "command", surface: "monarch", sub });
      }
    }
  });

  it("routes every cataloged music alias", () => {
    for (const doc of MUSIC_COMMANDS) {
      const sub = subOf(doc.usage);
      const aliases = MUSIC_PREFIX_ALIASES[sub] ?? [];
      expect(aliases.length, `${doc.name} has no alias entry`).toBeGreaterThan(0);
      expect([...aliases].sort()).toEqual([...(doc.prefixAliases ?? [])].sort());
      for (const alias of aliases) {
        const parsed = extractPrefixCommand(`!${alias}`, PREFIXES, BOT_ID)!;
        expect(matchCommand(parsed)).toMatchObject({ kind: "command", surface: "music", sub });
      }
    }
  });

  it("routes /burg under its own name", () => {
    const doc = BURG_COMMANDS[0]!;
    expect(doc.prefixAliases).toEqual(["burg"]);
    const parsed = extractPrefixCommand("!burg <@111111111111111>", PREFIXES, BOT_ID)!;
    expect(matchCommand(parsed)).toMatchObject({ kind: "command", surface: "burg" });
  });

  it("has no alias collisions across surfaces", () => {
    const monarch = Object.values(MONARCH_PREFIX_ALIASES).flat();
    const music = Object.values(MUSIC_PREFIX_ALIASES).flat();
    const all = [...monarch, ...music, "burg"];
    expect(new Set(all).size).toBe(all.length);
  });
});
