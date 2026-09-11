import { createRequire } from "node:module";
import { createLogger } from "@monarch/shared";

/**
 * Playback needs ffmpeg on the PATH (or pointed at by MUSIC_FFMPEG_PATH /
 * FFMPEG_PATH). prism-media (used by @discordjs/voice) resolves ffmpeg as
 * `process.env.FFMPEG_PATH ?? "ffmpeg"` — the Docker image ships the real
 * binary, and in dev environments without a system ffmpeg we fall back to
 * the @ffmpeg-installer/ffmpeg npm package, which bundles a static build.
 */
const log = createLogger("bot.music");
const require = createRequire(import.meta.url);

export function resolveFfmpeg(): string | null {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

  try {
    // Optional dependency: absent in some installs, that's fine.
    const installer = require("@ffmpeg-installer/ffmpeg") as { path: string };
    if (installer.path) {
      process.env.FFMPEG_PATH = installer.path;
      log.info("using bundled ffmpeg", { path: installer.path });
      return installer.path;
    }
  } catch {
    // fall through to system ffmpeg
  }

  // Last resort: assume a system ffmpeg is on the PATH (Docker image, most
  // dev machines). prism-media will use it by default.
  return "ffmpeg";
}
