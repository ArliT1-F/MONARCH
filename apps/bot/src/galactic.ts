/**
 * Standard Galactic Alphabet (the Commander Keen / Minecraft enchanting
 * table script) transliteration.
 *
 * Discord has no SGA font, so we map each Latin letter to the Unicode glyph
 * that visually matches the SGA character (the same mapping the popular
 * "enchanting table" translators use). Digits, punctuation, whitespace and
 * anything non-Latin are left as they are.
 *
 * Discord markup is preserved so a jailed message can't break formatting or
 * smuggle plain text through: mentions (`<@…>`, `<#…>`, `<@&…>`), custom
 * emoji (`<:name:id>`), URLs and inline/fenced code stay untouched.
 */
const SGA: Record<string, string> = {
  a: "ᔑ",
  b: "ʖ",
  c: "ᓵ",
  d: "↸",
  e: "ᒷ",
  f: "⎓",
  g: "⊣",
  h: "⍑",
  i: "╎",
  j: "⋮",
  k: "ꖌ",
  l: "ꖎ",
  m: "ᒲ",
  n: "リ",
  o: "𝙹",
  p: "!¡",
  q: "ᑑ",
  r: "∷",
  s: "ᓭ",
  t: "ℸ̣",
  u: "⚍",
  v: "⍊",
  w: "∴",
  x: "̇/",
  y: "||",
  z: "⨅",
};

/** Segments that must not be transliterated. Order matters: code first. */
const PRESERVE =
  /(```[\s\S]*?```|`[^`\n]*`|<a?:\w+:\d+>|<[@#][!&]?\d+>|<t:\d+(?::[tTdDfFR])?>|https?:\/\/\S+)/g;

export function toGalactic(text: string): string {
  return text
    .split(PRESERVE)
    .map((part, i) => (i % 2 === 1 ? part : transliterate(part)))
    .join("");
}

function transliterate(text: string): string {
  let out = "";
  for (const ch of text) {
    const glyph = SGA[ch.toLowerCase()];
    out += glyph ?? ch;
  }
  return out;
}

/**
 * Parse a jail duration such as `30s`, `10m`, `2h`, `1d`, `1h30m`.
 * Returns milliseconds, or null when the string is not a duration.
 * Capped at 28 days (Discord's own timeout ceiling) so a typo can't jail
 * someone for a year.
 */
export const MAX_JAIL_MS = 28 * 24 * 60 * 60 * 1000;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

export function parseDuration(input: string): number | null {
  const cleaned = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!cleaned || !/^(\d+[smhdw])+$/.test(cleaned)) return null;
  let total = 0;
  for (const [, n, unit] of cleaned.matchAll(/(\d+)([smhdw])/g)) {
    total += Number(n) * (UNIT_MS[unit!] ?? 0);
  }
  if (total <= 0) return null;
  return Math.min(total, MAX_JAIL_MS);
}

/** `1h 30m` style rendering for confirmations. */
export function formatDuration(ms: number): string {
  const units: Array<[string, number]> = [
    ["d", UNIT_MS.d!],
    ["h", UNIT_MS.h!],
    ["m", UNIT_MS.m!],
    ["s", UNIT_MS.s!],
  ];
  const parts: string[] = [];
  let rest = ms;
  for (const [label, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${label}`);
      rest -= n * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "0s";
}
