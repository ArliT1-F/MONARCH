/**
 * Gag durations — `30s`, `10m`, `2h`, `1d`, `1h30m`.
 *
 * Shared by the `/burg` command on both surfaces (slash options and prefix
 * arguments go through the same parser, so `!burg @user 10m` and
 * `/burg @user duration:10m` always agree).
 */

/**
 * The longest a burg can last. Capped at 28 days (Discord's own timeout
 * ceiling) so a typo can't burg someone for a year.
 */
export const MAX_DURATION_MS = 28 * 24 * 60 * 60 * 1000;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Parse a duration such as `30s`, `10m`, `2h`, `1d`, `1h30m`.
 * Returns milliseconds, or null when the string is not a duration.
 */
export function parseDuration(input: string): number | null {
  const cleaned = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!cleaned || !/^(\d+[smhdw])+$/.test(cleaned)) return null;
  let total = 0;
  for (const [, n, unit] of cleaned.matchAll(/(\d+)([smhdw])/g)) {
    total += Number(n) * (UNIT_MS[unit!] ?? 0);
  }
  if (total <= 0) return null;
  return Math.min(total, MAX_DURATION_MS);
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
