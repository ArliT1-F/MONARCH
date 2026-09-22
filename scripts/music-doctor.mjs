#!/usr/bin/env node
/**
 * Music doctor — "why won't it play?"
 *
 *   npm run music:check          # checks the toolchain
 *   npm run music:check -- --probe   # …and asks YouTube for a track
 *
 * The bot's music path is: yt-dlp (audio) → [ffmpeg] → Opus → Discord's voice
 * servers. Each of those is checked here, in the order a failure would show up,
 * and every failure prints the fix. Nothing is downloaded or changed.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = process.env.MONARCH_BIN_DIR?.trim() || path.join(root, ".monarch", "bin");
const probe = process.argv.includes("--probe");
const require = createRequire(path.join(root, "package.json"));

const ok = (m) => console.log(`  \u001b[32m✓\u001b[0m ${m}`);
const bad = (m) => console.log(`  \u001b[31m✗\u001b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);

function run(bin, args, timeout = 30_000) {
  try {
    const result = spawnSync(bin, args, { encoding: "utf8", timeout });
    return { ok: !result.error && result.status === 0, code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    return { ok: false, code: null, stdout: "", stderr: String(error) };
  }
}

console.log("\nMonarch · music check\n");

// ── 1. yt-dlp ────────────────────────────────────────────────────────────────
let ytdlpBin = null;
const candidates = [
  process.env.YTDLP_PATH?.trim(),
  path.join(binDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"),
  "yt-dlp",
].filter(Boolean);

for (const candidate of candidates) {
  const result = run(candidate, ["--version"], 20_000);
  if (result.ok && result.stdout.trim()) {
    ytdlpBin = candidate;
    const version = result.stdout.trim().split("\n").pop();
    ok(`yt-dlp ${version} — ${candidate}`);
    const age = version.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
    if (age) {
      const released = new Date(`${age[1]}-${age[2]}-${age[3]}T00:00:00Z`).getTime();
      const days = Math.floor((Date.now() - released) / 86_400_000);
      if (days > 90) {
        info(`this build is ${days} days old — YouTube changes often: \`yt-dlp -U\` (or re-run npm run music:setup)`);
      }
    }
    break;
  }
}
if (!ytdlpBin) {
  bad("yt-dlp is not installed");
  info("fix it with one of:");
  info("  npm run music:setup                 # downloads the official binary into .monarch/bin");
  info("  pipx install yt-dlp                 # or: pip install -U yt-dlp");
  info("  …then set YTDLP_PATH=/path/to/yt-dlp if it is not on the PATH");
  info("(the bot also downloads it automatically on the first /music play)");
}

// ── 2. ffmpeg ────────────────────────────────────────────────────────────────
let ffmpegBin = null;
const ffmpegCandidates = [
  process.env.MUSIC_FFMPEG_PATH?.trim(),
  process.env.FFMPEG_PATH?.trim(),
  path.join(binDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
  "ffmpeg",
].filter(Boolean);

for (const candidate of ffmpegCandidates) {
  const result = run(candidate, ["-hide_banner", "-version"], 20_000);
  if (result.ok) {
    ffmpegBin = candidate;
    ok(`ffmpeg — ${candidate}`);
    break;
  }
}
if (!ffmpegBin) {
  try {
    const installer = require("@ffmpeg-installer/ffmpeg");
    if (installer?.path && existsSync(installer.path)) {
      ffmpegBin = installer.path;
      ok(`ffmpeg (bundled) — ${installer.path}`);
    }
  } catch {
    // not installed
  }
}
if (!ffmpegBin) {
  bad("no ffmpeg found");
  info("playback still works for YouTube (WebM/Opus passthrough), but /music volume and");
  info("non-Opus sources (SoundCloud, Bandcamp, radio streams) need it. Install one:");
  if (process.platform === "darwin") info("  brew install ffmpeg");
  else if (process.platform === "win32") info("  winget install Gyan.FFmpeg");
  else info("  sudo apt install ffmpeg    # or: apk add ffmpeg");
}

// ── 3. the voice stack ───────────────────────────────────────────────────────
try {
  const voice = await import("@discordjs/voice");
  const report = voice.generateDependencyReport();
  const field = (name) => new RegExp(`^- ${name.replace(/[/@.\-]/g, "\\$&")}: (.+)$`, "m").exec(report)?.[1]?.trim() ?? null;
  const opus = field("opusscript");
  const native = field("@discordjs/opus");
  const dave = field("@snazzah/davey");
  const aes = field("native crypto support for aes-256-gcm");

  if (native && native !== "not found") ok(`Opus encoder: @discordjs/opus ${native} (native, fastest)`);
  else if (opus && opus !== "not found") ok(`Opus encoder: opusscript ${opus} (pure JS — fine, but native is faster)`);
  else {
    bad("no Opus encoder: PCM playback (and therefore volume) is unavailable");
    info("fix: npm install opusscript      # no compiler needed");
  }

  if (dave && dave !== "not found") ok(`DAVE / end-to-end encryption: @snazzah/davey ${dave}`);
  else {
    bad("@snazzah/davey is missing — Discord requires it for voice in most servers");
    info("fix: npm install @snazzah/davey");
  }

  if (aes && aes !== "yes") bad("no native aes-256-gcm — reinstall Node, or voice encryption will fail");
  else ok("voice encryption: native aes-256-gcm");
} catch (error) {
  bad(`could not load @discordjs/voice (${error instanceof Error ? error.message : String(error)})`);
  info("fix: npm install");
}

// ── 4. the pipeline this machine will use ────────────────────────────────────
if (ytdlpBin) {
  const mode = ffmpegBin ? "yt-dlp → ffmpeg → Opus (volume ✓, all sources)" : "yt-dlp → Opus passthrough (no volume)";
  ok(`pipeline: ${mode}`);
}

// ── 5. can it actually reach YouTube? ────────────────────────────────────────
if (probe && ytdlpBin) {
  console.log("\n  Probing YouTube with `yt-dlp -J 'ytsearch1:monarch'` …");
  const result = run(ytdlpBin, ["--no-warnings", "--no-playlist", "-J", "ytsearch1:monarch", "--flat-playlist"], 90_000);
  if (result.ok) {
    try {
      const data = JSON.parse(result.stdout.trim().split("\n").pop());
      const first = data?.entries?.[0];
      if (first?.title) ok(`YouTube answered: "${first.title}"`);
      else bad("YouTube answered with no result — check the search, or the machine's region");
    } catch {
      bad("yt-dlp returned something that wasn't JSON — the build may be corrupt, reinstall it");
    }
  } else {
    bad("yt-dlp could not reach YouTube");
    const stderr = (result.stderr ?? "").trim().split("\n").slice(-4).join("\n    ");
    if (stderr) info(stderr);
    if (/sign in to confirm|not a bot|confirm your age/i.test(result.stderr)) {
      info("YouTube wants cookies. Export a cookies.txt from a browser and set YTDLP_COOKIES=/path/cookies.txt");
    } else if (/SSL|tls|connection|timed out/i.test(result.stderr)) {
      info("This looks like a network/DNS/TLS problem (firewall, VPN, or a blocked IP) — not a broken bot.");
    }
  }
} else if (probe) {
  bad("cannot probe YouTube without yt-dlp");
}

console.log("\n  Voice needs outbound UDP to Discord. Containers on hosts without UDP");
console.log("  egress (e.g. Render) can run every other feature but not voice.\n");
console.log("  Docs: docs/troubleshooting-music.md\n");
