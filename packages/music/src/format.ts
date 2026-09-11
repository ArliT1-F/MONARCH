/**
 * Display formatting shared by the bot's embeds and tests.
 */

/** `181000` → `3:01`, `3725000` → `1:02:05`, null/live → `live`. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "live";
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = String(minutes).padStart(hours ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Clamp a requested volume to Monarch's 0–150 range. Returns null if unparsable. */
export function parseVolume(input: string | number): number | null {
  if (typeof input === "string" && input.trim() === "") return null;
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isInteger(n)) return null;
  return Math.min(150, Math.max(0, n));
}

/** 0–150 (user units) → 0–1.5 (AudioPlayer gain). */
export function volumeToGain(percent: number): number {
  return Math.min(1.5, Math.max(0, percent / 100));
}

/** A simple `▬▬🔘▬▬` progress bar for the now-playing embed. */
export function progressBar(positionMs: number, durationMs: number, width = 18): string {
  if (durationMs <= 0) return "";
  const ratio = Math.min(1, Math.max(0, positionMs / durationMs));
  const filled = Math.round(ratio * width);
  const bar = "▬".repeat(Math.max(0, filled - 1)) + "🔘" + "▬".repeat(Math.max(0, width - filled));
  return bar;
}