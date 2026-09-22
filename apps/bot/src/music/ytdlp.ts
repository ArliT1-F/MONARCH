import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createLogger } from "@monarch/shared";

/**
 * yt-dlp — Monarch's audio source.
 *
 * Every source lives behind one external binary: YouTube (links, playlists,
 * searches), SoundCloud, Bandcamp, Twitch, plain HTTP audio… yt-dlp knows how
 * to extract all of them, and it is the same tool the whole ecosystem uses to
 * keep working when YouTube changes its player. There is no node, no Java, no
 * second service to run: this file finds (or downloads) the binary, asks it
 * for metadata as JSON, and opens a pipe of audio bytes that `audio.ts` turns
 * into a Discord voice stream.
 *
 * Why a binary instead of a JS extractor library: yt-dlp is updated within
 * hours of every YouTube break, and "update the extractor" must not mean
 * "wait for a Monarch release". `YTDLP_PATH` points at your own install; if
 * nothing is on the PATH we download the official static build into
 * `.monarch/bin` on first use (plain HTTPS download from GitHub releases).
 *
 * Everything here is deliberately spawn-level: no shell, explicit argv, and
 * stderr captured so a failure can be explained to a human instead of
 * surfacing as "the bot did nothing".
 */

const log = createLogger("bot.music.ytdlp");

// ── configuration ──────────────────────────────────────────────────────

/** Extra seconds on top of the socket timeout before we call a start a hang. */
const STARTUP_GRACE_MS = 15_000;
/** How long a probe result (is the binary usable?) is trusted. */
const PROBE_TTL_MS = 60_000;
/** `--socket-timeout` for every invocation; yt-dlp retries on top of this. */
const SOCKET_TIMEOUT_S = 15;

function env(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

export function ytdlpDisabled(): boolean {
  return ["1", "true", "yes", "on"].includes((env("YTDLP_DISABLED") ?? "").toLowerCase());
}

/** Operator's own binary, if they pointed us at one (`YTDLP_PATH`, legacy `MUSIC_YTDLP_PATH`). */
export function ytdlpConfiguredPath(): string | null {
  return env("YTDLP_PATH") ?? env("MUSIC_YTDLP_PATH") ?? null;
}

/** Where a downloaded binary lives. `.monarch/` is gitignored and docker-safe. */
export function ytdlpBinDir(): string {
  return (
    env("MUSIC_YTDLP_BIN_DIR") ??
    env("YTDLP_BIN_DIR") ??
    // `MONARCH_BIN_DIR` moves *both* helper binaries (yt-dlp here, ffmpeg in
    // audio.ts) — one variable for "keep the tools somewhere writable".
    env("MONARCH_BIN_DIR") ??
    path.join(process.cwd(), ".monarch", "bin")
  );
}

export function downloadedYtdlpPath(): string {
  return path.join(ytdlpBinDir(), process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
}

/** Auto-download the official static binary when nothing is on the PATH. */
export function ytdlpAutoDownload(): boolean {
  const raw = (env("YTDLP_AUTO_DOWNLOAD") ?? "").toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

/** Cookies (Netscape `cookies.txt`) — the thing that makes YouTube reliable for bots. */
export function ytdlpCookiesPath(): string | null {
  return env("YTDLP_COOKIES") ?? env("YTDLP_COOKIE_FILE") ?? null;
}

/**
 * Extra CLI flags from `YTDLP_ARGS` (e.g. extractor args for a stubborn
 * source). Split on whitespace, but `"quoted values"` stay one argument —
 * `--extractor-args "youtube:player_client=tv,web"` is a single flag pair, and
 * splitting it blindly used to hand yt-dlp two broken arguments.
 */
export function ytdlpExtraArgs(raw = env("YTDLP_ARGS")): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of raw.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (value) out.push(value);
  }
  return out;
}

/**
 * Flags shared by every invocation.
 *
 * `--no-playlist` keeps a watch URL with a `list=` parameter from turning into
 * a 5000-video import; playlists are expanded explicitly (see sources.ts).
 * `--no-part`/`--quiet` keep stdout clean: the audio pipe and the JSON both
 * come out of stdout, so nothing else may be written there.
 */
export function ytdlpCommonArgs(): string[] {
  const args = [
    "--no-warnings",
    "--quiet",
    "--no-progress",
    "--no-color",
    "--no-playlist",
    "--no-part",
    "--retries",
    "5",
    "--fragment-retries",
    "5",
    "--socket-timeout",
    String(SOCKET_TIMEOUT_S),
    "--extractor-retries",
    "2",
    // YouTube (and several other CDNs) throttle a *connection* rather than an
    // account: one long-lived TCP stream starts out fast and then crawls,
    // which is what makes a track stall or stop a minute in. Asking for the
    // audio in 16 KiB chunks turns that into a series of short range requests
    // — each one is answered at full speed. Verified byte-identical on the
    // stdout path, and harmless on servers that don't support ranges.
    "--http-chunk-size",
    "16384",
  ];
  const cookies = ytdlpCookiesPath();
  if (cookies) args.push("--cookies", cookies);
  const proxy = env("YTDLP_PROXY");
  if (proxy) args.push("--proxy", proxy);
  const cacheDir = env("YTDLP_CACHE_DIR");
  if (cacheDir) args.push("--cache-dir", cacheDir);
  return [...args, ...ytdlpExtraArgs()];
}

// ── binary capabilities ────────────────────────────────────────────────

/** Per-binary capability list; a binary never changes under a running process. */
const capabilityCache = new Map<string, Promise<string[]>>();

/** Forget cached capabilities (tests, and after re-downloading the binary). */
export function resetYtdlpCapabilities(): void {
  capabilityCache.clear();
}

/**
 * Which JS runtime to offer yt-dlp for the challenge solver (`YTDLP_JS_RUNTIME`).
 * `none` disables it; otherwise the value is passed through as
 * `RUNTIME[:PATH]` — e.g. `deno`, or `node:/usr/local/bin/node`.
 *
 * Default: *our own* Node. yt-dlp only enables Deno out of the box, and it
 * needs a JS runtime to solve YouTube's `n`/signature challenge — when the
 * solver can't run, YouTube hands out rate-limited URLs and the track dies
 * mid-song. We are already a Node process, so this costs nothing to enable.
 */
function jsRuntimeArgs(): string[] {
  const override = env("YTDLP_JS_RUNTIME")?.trim();
  if (override?.toLowerCase() === "none") return [];
  if (override) return ["--js-runtimes", override];
  if (!process.execPath) return [];
  return ["--js-runtimes", `node:${process.execPath}`];
}

/**
 * Flags the *installed* binary understands, discovered from its `--help` once
 * per process. Guards against old builds (a packaged `yt-dlp` from a distro
 * repo can be a year old) and against nightlies that rename things.
 */
export async function ytdlpCapabilityArgs(bin: string): Promise<string[]> {
  const cached = capabilityCache.get(bin);
  if (cached) return cached;
  const pending = detectCapabilities(bin);
  capabilityCache.set(bin, pending);
  return pending;
}

async function detectCapabilities(bin: string): Promise<string[]> {
  const help = await run(bin, ["--help"], 20_000);
  if (help.spawnError) return [];
  const text = `${help.stdout}\n${help.stderr}`;
  const args: string[] = [];
  if (text.includes("--js-runtimes")) args.push(...jsRuntimeArgs());
  return args;
}

// ── binary discovery (and first-run download) ──────────────────────────

export type YtdlpSource = "env" | "downloaded" | "path" | "missing";

export interface YtdlpProbe {
  available: boolean;
  /** The command to spawn (`YTDLP_PATH`, the downloaded copy, or `yt-dlp`). */
  bin: string;
  version: string | null;
  source: YtdlpSource;
  /** Human-actionable detail when `available` is false. */
  detail?: string;
}

let cachedProbe: { at: number; value: YtdlpProbe } | null = null;

/** Reset the probe cache (tests, and after a download). */
export function resetYtdlpProbe(): void {
  cachedProbe = null;
}

function run(
  bin: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError: Error | null }> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", spawnError: error as Error });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null, spawnError: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, spawnError });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 4_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, null));
  });
}

async function probeBinary(bin: string): Promise<string | null> {
  const result = await run(bin, ["--version"], 20_000);
  if (result.spawnError) return null;
  if (result.code !== 0) return null;
  const version = result.stdout.trim().split("\n").pop()?.trim();
  return version && version.length > 0 ? version : null;
}

/**
 * Which yt-dlp build this machine should fetch. The default release asset is a
 * self-contained binary (Python is embedded), so a download is enough — no
 * package manager, no system install.
 */
export function downloadAssetFor(platform = process.platform, arch = process.arch): string | null {
  const isMusl = platform === "linux" && existsSync("/etc/alpine-release");
  if (platform === "win32") return arch === "arm64" ? "yt-dlp_arm64.exe" : "yt-dlp.exe";
  if (platform === "darwin") return "yt-dlp_macos";
  if (platform === "linux") {
    if (isMusl) {
      if (arch === "x64") return "yt-dlp_musllinux";
      if (arch === "arm64") return "yt-dlp_musllinux_aarch64";
      return null;
    }
    if (arch === "x64") return "yt-dlp_linux";
    if (arch === "arm64") return "yt-dlp_linux_aarch64";
    if (arch === "arm") return "yt-dlp_linux_armv7l";
    return null;
  }
  return null;
}

/**
 * Download the official yt-dlp binary into {@link ytdlpBinDir}. Returns its
 * path. Throws with an explanation (and the manual install hint) on failure —
 * a network-restricted host must not look like a broken bot.
 */
export async function downloadYtdlp(): Promise<string> {
  const asset = downloadAssetFor();
  if (!asset) {
    throw new Error(`no yt-dlp build for ${process.platform}/${process.arch}`);
  }
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  const dir = ytdlpBinDir();
  mkdirSync(dir, { recursive: true });
  const target = downloadedYtdlpPath();
  const tmp = `${target}.${process.pid}.tmp`;

  log.info("downloading yt-dlp", { url, target });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (HTTP ${response.status}) for ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength < 1_000_000) {
    throw new Error(`Downloaded file looks wrong (${buffer.byteLength} bytes) — refusing to install it`);
  }
  writeFileSync(tmp, buffer);
  if (process.platform !== "win32") chmodSync(tmp, 0o755);
  renameSync(tmp, target);
  resetYtdlpProbe();
  log.info("yt-dlp installed", { target, bytes: buffer.byteLength });
  return target;
}

/**
 * Make sure a usable yt-dlp exists, in this order:
 *   1. `YTDLP_PATH` (an operator's own install — trusted as-is),
 *   2. a previously downloaded copy in `.monarch/bin`,
 *   3. `yt-dlp` on the PATH,
 *   4. download the official binary (unless `YTDLP_AUTO_DOWNLOAD=0`).
 *
 * The result is cached for a minute so every play doesn't re-probe, and the
 * download runs at most once per process (concurrent callers share it).
 */
let downloadInFlight: Promise<string> | null = null;

export async function ensureYtdlp(force = false): Promise<YtdlpProbe> {
  if (!force && cachedProbe && Date.now() - cachedProbe.at < PROBE_TTL_MS) return cachedProbe.value;

  const finish = (probe: YtdlpProbe): YtdlpProbe => {
    cachedProbe = { at: Date.now(), value: probe };
    return probe;
  };

  if (ytdlpDisabled()) {
    return finish({
      available: false,
      bin: "yt-dlp",
      version: null,
      source: "missing",
      detail: "YTDLP_DISABLED is set, so music playback is switched off on this worker.",
    });
  }

  const configured = ytdlpConfiguredPath();
  if (configured) {
    const version = await probeBinary(configured);
    return finish({
      available: version !== null,
      bin: configured,
      version,
      source: version !== null ? "env" : "missing",
      ...(version === null ? { detail: `YTDLP_PATH=${configured} is not a working yt-dlp binary.` } : {}),
    });
  }

  const local = downloadedYtdlpPath();
  if (existsSync(local)) {
    const version = await probeBinary(local);
    if (version !== null) return finish({ available: true, bin: local, version, source: "downloaded" });
  }

  const onPath = await probeBinary("yt-dlp");
  if (onPath !== null) return finish({ available: true, bin: "yt-dlp", version: onPath, source: "path" });

  if (!ytdlpAutoDownload()) {
    return finish({
      available: false,
      bin: "yt-dlp",
      version: null,
      source: "missing",
      detail:
        "yt-dlp is not installed and YTDLP_AUTO_DOWNLOAD=0. Install it (https://github.com/yt-dlp/yt-dlp#installation) " +
        "or set YTDLP_PATH, then restart the bot.",
    });
  }

  try {
    downloadInFlight ??= downloadYtdlp().finally(() => {
      downloadInFlight = null;
    });
    const bin = await downloadInFlight;
    const version = await probeBinary(bin);
    return finish({
      available: version !== null,
      bin,
      version,
      source: version !== null ? "downloaded" : "missing",
      ...(version === null ? { detail: `The downloaded yt-dlp at ${bin} would not run.` } : {}),
    });
  } catch (error) {
    return finish({
      available: false,
      bin: "yt-dlp",
      version: null,
      source: "missing",
      detail:
        `yt-dlp is not installed and downloading it failed (${String(error instanceof Error ? error.message : error).slice(0, 200)}). ` +
        "Install it manually from https://github.com/yt-dlp/yt-dlp#installation or point YTDLP_PATH at it, then restart the bot.",
    });
  }
}

/** Remove a broken download so the next probe can fetch it again. */
export function discardDownloadedYtdlp(): void {
  try {
    rmSync(downloadedYtdlpPath(), { force: true });
    resetYtdlpProbe();
  } catch {
    // best effort
  }
}

/** The binary to spawn, or null when music can't run. Logs the reason once. */
export async function resolveYtdlpOrNull(): Promise<string | null> {
  const probe = await ensureYtdlp();
  if (!probe.available) {
    log.error("yt-dlp is not available", { detail: probe.detail, bin: probe.bin });
    return null;
  }
  return probe.bin;
}

// ── error translation ──────────────────────────────────────────────────

/**
 * Turn yt-dlp's stderr into something a Discord user (or the operator) can act
 * on. yt-dlp is very good at saying *what* went wrong; what it can't know is
 * which of Monarch's env vars fixes it.
 */
export function explainYtdlpFailure(stderr: string): string {
  const text = stderr.trim();
  const lower = text.toLowerCase();

  if (lower.includes("command not found") || lower.includes("enoent")) {
    return (
      "The bot couldn't run **yt-dlp** (not installed and the automatic download failed). " +
      "Install it from https://github.com/yt-dlp/yt-dlp#installation or set `YTDLP_PATH`, then restart the bot."
    );
  }
  if (
    lower.includes("sign in to confirm you're not a bot") ||
    lower.includes("sign in to confirm you’re not a bot") ||
    lower.includes("confirm your age") ||
    lower.includes("login required")
  ) {
    return (
      "YouTube asked the downloader to prove it isn't a bot. Export your browser's `cookies.txt` and point " +
      "`YTDLP_COOKIES` at it (a throwaway account is fine) — that is what makes YouTube reliable for a bot. " +
      "See docs/troubleshooting-music.md."
    );
  }
  if (lower.includes("private video")) return "That video is private, so it can't be played.";
  if (lower.includes("video unavailable") || lower.includes("this video is not available")) {
    return "That video is unavailable (removed, region-locked, or age-restricted without cookies).";
  }
  if (lower.includes("not available in your country") || lower.includes("geo restricted")) {
    return "That video is region-locked for the machine running the bot.";
  }
  if (lower.includes("requested format is not available")) {
    return "The source didn't offer a downloadable audio-only format — try another link, or update yt-dlp.";
  }
  if (lower.includes("is a live stream") || lower.includes("live stream")) {
    return "That's a live stream — wait for it to end before queueing it.";
  }
  if (lower.includes("http error 404") || lower.includes("http error 410")) {
    return "That link doesn't exist on the source any more (the site answered 404) — check the URL and try again.";
  }
  if (lower.includes("http error 403")) {
    return (
      "The source refused the download (403) — that is usually a bot check or a region block. " +
      "Exporting cookies and pointing `YTDLP_COOKIES` at them usually fixes it."
    );
  }
  if (
    lower.includes("unable to download webpage") ||
    lower.includes("urlopen error") ||
    lower.includes("ssl") ||
    lower.includes("timed out") ||
    lower.includes("connection")
  ) {
    return "The downloader couldn't reach the source (network problem or a blocked IP) — try again in a moment.";
  }
  if (lower.includes("is not a valid url") || lower.includes("unsupported url")) {
    return "That link isn't something the downloader supports.";
  }
  const firstLine = text.split("\n").find((line) => line.trim().length > 0)?.replace(/^ERROR:\s*/i, "");
  return firstLine ? `The downloader said: ${firstLine.slice(0, 300)}` : "The downloader failed without saying why.";
}

/** Last few stderr lines, for logs (never shown raw to users). */
export function stderrTail(stderr: string, lines = 3): string {
  return stderr
    .trim()
    .split("\n")
    .slice(-lines)
    .join(" | ")
    .slice(0, 500);
}

// ── JSON metadata ──────────────────────────────────────────────────────

/** One entry as `-J --flat-playlist` prints it (only the fields we rely on). */
export interface YtdlpEntry {
  id?: string;
  title?: string;
  /** Seconds. Absent/null for live streams and unknown lengths. */
  duration?: number | null;
  uploader?: string;
  channel?: string;
  webpage_url?: string;
  url?: string;
  thumbnail?: string;
  thumbnails?: { url?: string }[];
  is_live?: boolean;
  live_status?: string | null;
  ie_key?: string;
  extractor?: string;
  /** Set on playlist/search containers. */
  _type?: string;
  entries?: (YtdlpEntry | null)[] | null;
  playlist_count?: number;
  description?: string;
  availability?: string | null;
  view_count?: number | null;
}

export class YtdlpError extends Error {
  constructor(
    message: string,
    readonly stderr = "",
  ) {
    super(message);
    this.name = "YtdlpError";
  }
}

/**
 * Run `yt-dlp -J` and parse the answer. `flat` uses the fast path (no per-item
 * extraction), which is what playlists and searches want; single videos use
 * the full extraction so we get the duration, thumbnail and live status.
 */
export async function ytdlpJson(
  target: string,
  options: { flat?: boolean; limit?: number; extraArgs?: string[] } = {},
): Promise<YtdlpEntry> {
  const bin = await resolveYtdlpOrNull();
  if (!bin) {
    throw new YtdlpError(
      "The music downloader (yt-dlp) isn't installed on the bot's machine, so nothing can play right now. " +
        "Install it (or set `YTDLP_PATH`), then restart the bot — see docs/troubleshooting-music.md.",
    );
  }

  const args = [...ytdlpCommonArgs(), ...(await ytdlpCapabilityArgs(bin)), "-J"];
  if (options.flat) args.push("--flat-playlist");
  if (options.limit && options.limit > 0) args.push("-I", `1:${options.limit}`);
  args.push(...(options.extraArgs ?? []), "--", target);

  const result = await run(bin, args, 120_000);
  if (result.spawnError) {
    // The binary vanished between the probe and now (a broken download, a
    // package manager mid-upgrade…). Forget the cached probe so the next call
    // can re-download or re-resolve.
    resetYtdlpProbe();
    throw new YtdlpError(explainYtdlpFailure(String(result.spawnError)), result.stderr);
  }

  const payload = result.stdout.trim();
  if (result.code !== 0 || payload.length === 0) {
    // Keep a non-zero exit's stderr for the log; the user-facing message is the
    // translated one.
    log.warn("yt-dlp metadata run failed", {
      target: target.slice(0, 120),
      code: result.code,
      stderr: stderrTail(result.stderr),
    });
    throw new YtdlpError(explainYtdlpFailure(result.stderr || String(result.spawnError ?? "no output")), result.stderr);
  }

  try {
    // `-J` prints exactly one JSON document; a trailing newline is normal.
    return JSON.parse(payload.split("\n").filter(Boolean).pop()!) as YtdlpEntry;
  } catch {
    throw new YtdlpError("The downloader returned something that wasn't valid JSON — its version may be too old.", result.stderr);
  }
}

/** `ytsearchN:query` — the entries yt-dlp's own YouTube search returned. */
export async function ytdlpSearch(query: string, limit = 5): Promise<YtdlpEntry[]> {
  const count = Math.min(20, Math.max(1, limit));
  const result = await ytdlpJson(`ytsearch${count}:${query}`, { flat: true, limit: count });
  return (result.entries ?? []).filter((entry): entry is YtdlpEntry => Boolean(entry));
}

/** Expand a playlist URL (capped, so a 5000-video list can't stall the bot). */
export async function ytdlpPlaylist(url: string, limit: number): Promise<YtdlpEntry> {
  return ytdlpJson(url, { flat: true, limit });
}

// ── audio streaming ────────────────────────────────────────────────────

/**
 * The format selector. Opus-in-WebM is preferred because it is the one format
 * Discord can be fed *without* re-encoding (`audio.ts` probes the pipe and
 * passes Opus through when ffmpeg is missing) — and it is what YouTube offers
 * for every video. `bestaudio` is the fallback so SoundCloud/Bandcamp/radio
 * still work wherever ffmpeg is available. Override with `YTDLP_FORMAT` if a
 * site needs something different.
 */
export const YTDLP_FORMAT = "bestaudio[acodec=opus][ext=webm]/bestaudio[acodec=opus]/bestaudio";

/** The selector to hand yt-dlp: `YTDLP_FORMAT`, or the Opus-first default. */
export function ytdlpFormat(): string {
  return env("YTDLP_FORMAT") ?? YTDLP_FORMAT;
}

export interface AudioPipe {
  /** The audio bytes (whatever container the selector picked). */
  stream: Readable;
  /** Kill the downloader and everything downstream of it. */
  kill(): void;
  /** True when the process is still running. */
  alive(): boolean;
  /** Filled in once the process exits: `{ code, stderr }`. */
  result(): { code: number | null; stderr: string; signaled: boolean };
  /** Resolves when yt-dlp exits (never rejects). */
  exited: Promise<{ code: number | null; stderr: string; signaled: boolean }>;
}

/**
 * Start streaming a track. The returned stream emits `error` if yt-dlp dies
 * before producing any audio (a bad URL, a blocked bot check…), which is what
 * lets the player skip to the next track instead of sitting in silence.
 */
export async function openAudioPipe(target: string): Promise<AudioPipe> {
  const bin = await resolveYtdlpOrNull();
  if (!bin) {
    throw new YtdlpError(
      "The music downloader (yt-dlp) isn't installed on the bot's machine, so nothing can play right now. " +
        "Install it (or set `YTDLP_PATH`), then restart the bot — see docs/troubleshooting-music.md.",
    );
  }

  const args = [
    ...ytdlpCommonArgs(),
    ...(await ytdlpCapabilityArgs(bin)),
    "-f",
    ytdlpFormat(),
    "-o",
    "-",
    "--",
    target,
  ];
  log.debug?.("starting yt-dlp audio pipe", { target: target.slice(0, 120) });

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, args, { windowsHide: true });
  } catch (error) {
    resetYtdlpProbe();
    throw new YtdlpError(explainYtdlpFailure(String(error)));
  }

  let stderr = "";
  let code: number | null = null;
  let signaled = false;
  let exited = false;

  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 8_000) stderr += chunk.toString("utf8");
  });

  const exitPromise = new Promise<{ code: number | null; stderr: string; signaled: boolean }>((resolve) => {
    child.on("close", (exitCode, signal) => {
      exited = true;
      code = exitCode;
      signaled = Boolean(signal);
      resolve({ code, stderr, signaled });
    });
    child.on("error", (error) => {
      stderr += `\n${String(error)}`;
      exited = true;
      signaled = true;
      resolve({ code: null, stderr, signaled });
    });
  });

  // A source that never starts must not hang a guild forever: the silence
  // timer kills the pipe, which surfaces as a normal failed-track skip.
  const startupTimer = setTimeout(() => {
    if (exited || child.stdout.readableLength > 0) return;
    log.warn("yt-dlp produced no audio in time — giving up", {
      target: target.slice(0, 120),
      stderr: stderrTail(stderr),
    });
    child.kill("SIGKILL");
  }, STARTUP_GRACE_MS + SOCKET_TIMEOUT_S * 1000);
  startupTimer.unref?.();

  // `--quiet` already keeps yt-dlp off stdout, but a fatal error arrives as a
  // non-zero exit *and* an empty pipe: turn that into a stream error so the
  // caller's error path (not a silent hang) runs.
  child.stdout.on("end", () => clearTimeout(startupTimer));

  return {
    stream: child.stdout,
    kill() {
      clearTimeout(startupTimer);
      if (!exited) child.kill("SIGKILL");
    },
    alive: () => !exited,
    result: () => ({ code, stderr, signaled }),
    exited: exitPromise.finally(() => clearTimeout(startupTimer)),
  };
}
