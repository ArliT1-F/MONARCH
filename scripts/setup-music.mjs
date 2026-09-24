#!/usr/bin/env node
/**
 * Pre-fetch the two binaries the music player wants, so the first `/music play`
 * doesn't have to.
 *
 *   npm run music:setup
 *
 * yt-dlp is the only *required* piece (the bot downloads it on its own too —
 * this just does it ahead of time, which is what a Docker build or a machine
 * with a slow link wants). ffmpeg is optional: with it, volume control works
 * and non-Opus sources (SoundCloud, Bandcamp, radio) play; without it, YouTube's
 * WebM/Opus is passed straight through to Discord.
 *
 * Nothing here is required for the bot to boot. Nothing is installed outside the
 * repo either: everything lands in `.monarch/bin` (gitignored).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const binDir = process.env.MONARCH_BIN_DIR?.trim() || path.join(root, ".monarch", "bin");
const force = process.argv.includes("--force");
const skipFfmpeg = process.argv.includes("--no-ffmpeg");

const ok = (message) => console.log(`  \u001b[32m✓\u001b[0m ${message}`);
const warn = (message) => console.log(`  \u001b[33m!\u001b[0m ${message}`);

/** Run a binary and return its stdout, or null when it isn't usable. */
function tryRun(bin, args) {
  try {
    const result = spawnSync(bin, args, { encoding: "utf8", timeout: 20_000 });
    if (result.error || result.status !== 0) return null;
    return (result.stdout ?? "").trim();
  } catch {
    return null;
  }
}

function platformAsset() {
  const { platform, arch } = process;
  const musl = platform === "linux" && existsSync("/etc/alpine-release");
  if (platform === "win32") return arch === "arm64" ? "yt-dlp_arm64.exe" : "yt-dlp.exe";
  if (platform === "darwin") return "yt-dlp_macos";
  if (platform === "linux") {
    if (musl)
      return arch === "x64"
        ? "yt-dlp_musllinux"
        : arch === "arm64"
          ? "yt-dlp_musllinux_aarch64"
          : null;
    if (arch === "x64") return "yt-dlp_linux";
    if (arch === "arm64") return "yt-dlp_linux_aarch64";
    if (arch === "arm") return "yt-dlp_linux_armv7l";
  }
  return null;
}

async function installYtdlp() {
  const configured = process.env.YTDLP_PATH?.trim();
  if (configured) {
    const version = tryRun(configured, ["--version"]);
    if (version) {
      ok(`yt-dlp ${version} (YTDLP_PATH=${configured})`);
      return true;
    }
    warn(`YTDLP_PATH=${configured} is not a working yt-dlp — ignoring it and looking further`);
  }

  const target = path.join(binDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (!force && existsSync(target)) {
    const version = tryRun(target, ["--version"]);
    if (version) {
      ok(`yt-dlp ${version} (${path.relative(root, target)})`);
      return true;
    }
    warn("the downloaded yt-dlp would not run — fetching it again");
  }

  const onPath = tryRun("yt-dlp", ["--version"]);
  if (onPath && !force) {
    ok(`yt-dlp ${onPath} (already on PATH)`);
    return true;
  }

  const asset = platformAsset();
  if (!asset) {
    warn(`no official yt-dlp build for ${process.platform}/${process.arch} — install it manually`);
    console.log("    https://github.com/yt-dlp/yt-dlp#installation");
    return false;
  }

  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  console.log(`  ↓ downloading ${asset} …`);
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength < 1_000_000)
      throw new Error(`suspicious size (${buffer.byteLength} bytes)`);
    mkdirSync(binDir, { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, buffer);
    if (process.platform !== "win32") chmodSync(tmp, 0o755);
    renameSync(tmp, target);
    const version = tryRun(target, ["--version"]);
    ok(`yt-dlp ${version ?? "(installed)"} (${path.relative(root, target)})`);
    return true;
  } catch (error) {
    rmSync(`${target}.tmp`, { force: true });
    warn(`could not download yt-dlp: ${error instanceof Error ? error.message : String(error)}`);
    console.log(
      `    Download it by hand and set YTDLP_PATH, or put it at ${path.relative(root, target)}.`,
    );
    return false;
  }
}

function reportFfmpeg() {
  if (skipFfmpeg) return;
  const configured = process.env.MUSIC_FFMPEG_PATH?.trim() || process.env.FFMPEG_PATH?.trim();
  const candidates = [
    configured,
    path.join(binDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const version = tryRun(candidate, ["-hide_banner", "-version"]);
    if (version) {
      ok(`ffmpeg found at ${candidate}`);
      return;
    }
  }

  const onPath = tryRun("ffmpeg", ["-hide_banner", "-version"]);
  if (onPath) {
    ok(`ffmpeg ${onPath.split("\n")[0]}`);
    return;
  }

  // The npm package is an optionalDependency, so a normal install has it.
  try {
    const installer = require("@ffmpeg-installer/ffmpeg");
    if (installer?.path && existsSync(installer.path)) {
      ok(`ffmpeg (bundled) — ${installer.path}`);
      return;
    }
  } catch {
    // not installed (or installed with --no-optional)
  }

  warn(
    "no ffmpeg: playback works (Opus passthrough) but volume control and non-Opus sources don't",
  );
  console.log("    install one with:");
  if (process.platform === "darwin") console.log("      brew install ffmpeg");
  else if (process.platform === "win32") console.log("      winget install Gyan.FFmpeg");
  else console.log("      sudo apt install ffmpeg    # or: apk add ffmpeg");
  console.log(
    "    …or `npm install` without --no-optional to get the bundled @ffmpeg-installer/ffmpeg.",
  );
  console.log("    Then set FFMPEG_PATH if it isn't on the PATH.");
}

console.log("\nMonarch · music setup\n");
const ytdlp = await installYtdlp();
reportFfmpeg();
console.log("");
console.log(
  ytdlp
    ? "Music is ready. Try /music play in Discord, then `npm run music:check`."
    : "yt-dlp is still missing — see above.",
);
console.log("");
process.exit(ytdlp ? 0 : 1);
