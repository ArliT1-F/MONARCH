import { describe, expect, it } from "vitest";
import { MAX_JAIL_MS, formatDuration, parseDuration, toGalactic } from "../src/galactic.js";

describe("toGalactic", () => {
  it("transliterates letters and keeps digits, punctuation and spacing", () => {
    expect(toGalactic("hello")).toBe("⍑ᒷꖎꖎ𝙹");
    expect(toGalactic("Hi 2 u!")).toBe("⍑╎ 2 ⚍!");
    expect(toGalactic("")).toBe("");
  });

  it("is case-insensitive (SGA has no case)", () => {
    expect(toGalactic("ABC")).toBe(toGalactic("abc"));
  });

  it("leaves mentions, custom emoji, timestamps, links and code untouched", () => {
    const mention = "<@123456789012345678>";
    const role = "<@&987654321098765432>";
    const channel = "<#111111111111111111>";
    const emoji = "<:pepe:222222222222222222>";
    const animated = "<a:party:333333333333333333>";
    const ts = "<t:1700000000:R>";
    const url = "https://example.com/some/path?x=1";
    const input = `hey ${mention} ${role} ${channel} ${emoji} ${animated} ${ts} see ${url} and \`code\` ok`;
    const out = toGalactic(input);
    for (const kept of [mention, role, channel, emoji, animated, ts, url, "`code`"]) {
      expect(out).toContain(kept);
    }
    expect(out.startsWith("⍑ᒷ||")).toBe(true);
    expect(out.endsWith("𝙹ꖌ")).toBe(true);
  });

  it("keeps fenced code blocks verbatim", () => {
    const block = "```js\nconst a = 1;\n```";
    expect(toGalactic(`look ${block} done`)).toBe(`ꖎ𝙹𝙹ꖌ ${block} ↸𝙹リᒷ`);
  });

  it("does not touch non-Latin text", () => {
    expect(toGalactic("привет 你好")).toBe("привет 你好");
  });
});

describe("parseDuration", () => {
  it("parses single and compound units", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration(" 1H 30M ")).toBe(5_400_000);
  });

  it("rejects garbage and zero", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("10")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
    expect(parseDuration("5 minutes")).toBeNull();
  });

  it("caps at 28 days", () => {
    expect(parseDuration("99w")).toBe(MAX_JAIL_MS);
  });
});

describe("formatDuration", () => {
  it("renders the two most significant units", () => {
    expect(formatDuration(5_400_000)).toBe("1h 30m");
    expect(formatDuration(90_061_000)).toBe("1d 1h");
    expect(formatDuration(45_000)).toBe("45s");
  });
});
