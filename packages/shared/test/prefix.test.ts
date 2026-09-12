import { describe, expect, it } from "vitest";
import {
  COMMAND_PREFIX_CHARS,
  DEFAULT_COMMAND_PREFIX,
  MAX_COMMAND_PREFIX_LENGTH,
  isCommandPrefix,
  parseCommandPrefix,
} from "../src/prefix.js";

/**
 * The prefix rules are shared by the bot (`!prefix set …`) and the
 * dashboard's internal route, so they're tested once, here: whatever both
 * sides accept must be safe to match against every message.
 */
describe("parseCommandPrefix", () => {
  it("accepts short punctuation prefixes and normalizes case", () => {
    expect(parseCommandPrefix("!")).toEqual({ ok: true, prefix: "!" });
    expect(parseCommandPrefix(" ? ")).toEqual({ ok: true, prefix: "?" });
    expect(parseCommandPrefix("m!")).toEqual({ ok: true, prefix: "m!" });
    expect(parseCommandPrefix(">>")).toEqual({ ok: true, prefix: ">>" });
  });

  it("keeps the default prefix legal", () => {
    expect(parseCommandPrefix(DEFAULT_COMMAND_PREFIX)).toEqual({ ok: true, prefix: DEFAULT_COMMAND_PREFIX });
    expect(isCommandPrefix(DEFAULT_COMMAND_PREFIX)).toBe(true);
  });

  it("rejects anything longer than the limit", () => {
    const tooLong = "!".repeat(MAX_COMMAND_PREFIX_LENGTH + 1);
    const result = parseCommandPrefix(tooLong);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(String(MAX_COMMAND_PREFIX_LENGTH));
  });

  it("rejects empty, whitespace, bare words, mentions and slash", () => {
    for (const bad of ["", "   ", null, undefined, 42, "hey", "a", "@", "/", "@Monarch", "! b", "m !"]) {
      expect(isCommandPrefix(bad), `${String(bad)} should be rejected`).toBe(false);
    }
  });

  it("allows letters only in front of a punctuation ending", () => {
    expect(parseCommandPrefix("m!")).toEqual({ ok: true, prefix: "m!" });
    expect(parseCommandPrefix("mo?")).toEqual({ ok: true, prefix: "mo?" });
    expect(isCommandPrefix("hey")).toBe(false); // a bare word would swallow conversation
    expect(isCommandPrefix("h")).toBe(false);
  });

  it("names the offending characters so the reply is actionable", () => {
    const forbidden = parseCommandPrefix("!@");
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.message).toContain("`@`");

    const wordy = parseCommandPrefix("!x");
    expect(wordy.ok).toBe(false);
    if (!wordy.ok) {
      expect(wordy.message).toContain("`!x`");
      expect(wordy.message).toContain(COMMAND_PREFIX_CHARS);
    }
  });

  it("rejects the characters that would collide with Discord syntax", () => {
    for (const bad of ["@", "/", "@m", "m/", "\"m", "`", "#", "'", '"', "$", "[", "]", "(", "|"]) {
      expect(isCommandPrefix(bad), `${bad} should be rejected`).toBe(false);
    }
  });

  it("accepts every documented prefix character on its own", () => {
    // The allowed set is punctuation-only by construction: no letter, digit,
    // space, mention or slash can ever be a whole prefix.
    for (const char of COMMAND_PREFIX_CHARS) {
      expect(/[a-z0-9\s@/]/i.test(char)).toBe(false);
      expect(isCommandPrefix(char), `${char} should be allowed`).toBe(true);
    }
  });
});
