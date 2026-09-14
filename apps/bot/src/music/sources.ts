import { evaluatePlayer } from "./javascript.js";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createLogger } from "@monarch/shared";
import { classifySource, type SourceQuery, type Track } from "@monarch/music";
import type { Innertube, Types, YT } from "youtubei.js";

/**
 * Source resolution — turns a `/music play` query into playable tracks.
 *
 * - YouTube (watch / youtu.be / Shorts / playlists) resolves directly via
 *   the InnerTube API (youtubei.js), which is what also produces the audio
 *   stream at play time.
 * - Spotify has no public audio stream, so track/album/playlist links are
 *   resolved to *metadata* through the official Web API (client-credentials
 *   tokens) and matched to a YouTube video lazily — when the track actually
 *   starts playing. That keeps queuing a 200-song playlist instant.
 * - Anything else is a YouTube search.
 */

const log = createLogger("bot.music");

export const DEFAULT_MAX_QUEUE = 500;
export const DEFAULT_MAX_PLAYLIST_TRACKS = 250;

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function musicLimits() {
  return {
    maxQueue: positiveInt("MUSIC_MAX_QUEUE", DEFAULT_MAX_QUEUE),
    maxPlaylistTracks: positiveInt("MUSIC_MAX_PLAYLIST_TRACKS", DEFAULT_MAX_PLAYLIST_TRACKS),
  };
}

function positiveInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

export interface ResolveResult {
  tracks: Track[];
  /** Human label of what was resolved, e.g. the playlist title. */
  origin: string;
  /** Non-fatal notes, e.g. "12 private videos skipped". */
  skipped: number;
  kind: SourceQuery["kind"];
}

export class SourceError extends Error {}

// ── YouTube (youtubei.js) ────────────────────────────────────────────

let innertubePromise: Promise<Innertube> | null = null;

// ── InnerTube client strategy ────────────────────────────────────────
//
// YouTube's InnerTube API hands different player clients different streams.
// Since the SABR rollout the plain WEB client often returns *URL-less*
// formats only (audio extraction then fails with "no usable audio stream"),
// while the TV / music / mobile clients still hand out plain HTTPS URLs —
// the same fallback chain yt-dlp uses. Audio extraction therefore tries
// several clients in order and takes the first one with a downloadable
// audio format; search and metadata keep the session default (they are
// unaffected by SABR).
//
// Operators can tune this without a code change:
// - YOUTUBE_CLIENTS="TV,ANDROID,WEB" overrides the order (uppercase,
//   comma-separated; any InnerTubeClient name youtubei.js supports);
// - YOUTUBE_COOKIE (alias YT_COOKIE) passes a browser-exported youtube.com
//   cookie to the session — helps with LOGIN_REQUIRED answers and with
//   IPs YouTube rate-limits;
// - YOUTUBE_PO_TOKEN passes a Proof-of-Origin token to clients that demand
//   attestation before releasing stream URLs.

const DEFAULT_YOUTUBE_CLIENTS = [
  "TV",
  "YTMUSIC",
  "ANDROID",
  "IOS",
  "YTMUSIC_ANDROID",
  "MWEB",
  "TV_EMBEDDED",
  "WEB_EMBEDDED",
  "WEB",
] as const;

export function youtubeClients(): string[] {
  const raw = (process.env.YOUTUBE_CLIENTS ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return raw.length > 0 ? [...new Set(raw)] : [...DEFAULT_YOUTUBE_CLIENTS];
}

function youtubeCookie(): string | undefined {
  return process.env.YOUTUBE_COOKIE?.trim() || process.env.YT_COOKIE?.trim() || undefined;
}

function youtubePoToken(): string | undefined {
  return process.env.YOUTUBE_PO_TOKEN?.trim() || undefined;
}

export function getYoutube(): Promise<Innertube> {
  innertubePromise ??= import("youtubei.js").then(({ Innertube, Platform }) => {
    Platform.shim.eval = evaluatePlayer;
    const cookie = youtubeCookie();
    const po_token = youtubePoToken();
    if (cookie) log.info("using YouTube cookie for InnerTube requests");
    return Innertube.create({
      generate_session_locally: true,
      ...(cookie ? { cookie } : {}),
      ...(po_token ? { po_token } : {}),
    });
  }).catch((error) => {
    innertubePromise = null; // A transient initialization failure must not poison every request.
    throw error;
  });
  return innertubePromise;
}

interface VideoMeta {
  videoId: string;
  title: string;
  author: string;
  durationMs: number | null;
  thumbnail: string | null;
  isLive: boolean;
  url: string;
}

/** Metadata-only lookup for one video (no streaming formats fetched). */
export async function youtubeVideoMeta(videoId: string): Promise<VideoMeta> {
  const yt = await getYoutube();
  const info = await yt.getBasicInfo(videoId);
  const basic = info.basic_info;
  if (!basic.title) throw new SourceError("That video is unavailable (private, removed, or age-restricted).");
  if (basic.is_live) throw new SourceError("Live streams can't be queued — try again once the stream has ended.");
  return {
    videoId: basic.id ?? videoId,
    title: basic.title,
    author: basic.author ?? "Unknown channel",
    durationMs: typeof basic.duration === "number" ? basic.duration * 1000 : null,
    thumbnail: basic.thumbnail?.[0]?.url ?? null,
    isLive: Boolean(basic.is_live),
    url: basic.url_canonical ?? `https://www.youtube.com/watch?v=${videoId}`,
  };
}

function shouldPreferYtdlp(): boolean {
  const raw = process.env.YTDLP_PREFER?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  // Default: prefer yt-dlp when it's available — it handles throttling and
  // SABR far better than a single InnerTube download. Operators can set
  // YTDLP_PREFER=0 to force InnerTube-first if they want.
  return true;
}

/** Best-effort audio stream for a YouTube video. */
export async function youtubeAudioStream(videoId: string): Promise<Readable> {
  // Prefer yt-dlp when available — it's the most robust against throttling
  // (chunked, range requests, retries) and against SABR. This is why the
  // Muharrem Ahmeti track stopped after ~3m: the ANDROID client stream was
  // throttled and closed early with no error, so the player went Idle silently.
  // yt-dlp handles that case.
  if (shouldPreferYtdlp()) {
    const preferred = await ytdlpAudioStream(`https://www.youtube.com/watch?v=${videoId}`, true);
    if (preferred) return preferred;
  }

  const yt = await getYoutube();
  const clients = youtubeClients();
  const po_token = youtubePoToken();
  let loginRequired = false;
  let sawSabrOnly = false;
  let lastDetail = "no InnerTube client returned a stream";
  for (const client of clients) {
    try {
      const info = await yt.getBasicInfo(videoId, {
        client: client as Types.InnerTubeClient,
        ...(po_token ? { po_token } : {}),
      });
      const status = info.playability_status?.status;
      if (status === "LOGIN_REQUIRED") {
        loginRequired = true;
        lastDetail = `${client}: login required`;
        continue;
      }
      if (status === "UNPLAYABLE") {
        lastDetail = `${client}: video unplayable (${info.playability_status?.reason ?? "no reason given"})`;
        continue;
      }
      const streaming = info.streaming_data;
      if (!streaming) {
        lastDetail = `${client}: no streaming data`;
        continue;
      }
      const adaptive = streaming.adaptive_formats ?? [];
      const progressive = streaming.formats ?? [];
      const candidates = [...adaptive, ...progressive];
      if (candidates.length === 0 && streaming.server_abr_streaming_url) sawSabrOnly = true;
      // Only formats the direct-download API can actually use (a plain URL
      // or a cipher it can decipher). Prefer audio-only (itag 140/251/…);
      // fall back to a progressive video+audio file (itag 18/…) — ffmpeg
      // extracts the audio either way.
      const downloadable = (list: typeof candidates) =>
        list.filter((f) => f.has_audio && (f.url || f.signature_cipher || f.cipher));
      const format =
        downloadable(adaptive.filter((f) => !f.has_video)).sort((a, b) => b.bitrate - a.bitrate)[0] ??
        downloadable(candidates).sort((a, b) => b.bitrate - a.bitrate)[0];
      if (!format) {
        // Formats exist but carry no URL — the SABR-only signature.
        if (candidates.length > 0) sawSabrOnly = true;
        lastDetail = `${client}: ${candidates.length} format(s) but no downloadable audio URL`;
        continue;
      }
      const stream = await info.download({ itag: format.itag, type: "audio", quality: "best", format: "any" });
      if (client !== clients[0]) log.info("YouTube audio client fallback worked", { videoId, client });
      const nodeStream = Readable.fromWeb(stream as unknown as import("node:stream/web").ReadableStream);
      // Attach a cheap error forwarder — if the underlying fetch aborts mid-track
      // (throttling), the Node stream would otherwise just end cleanly and the
      // player would think the track finished early with no log.
      nodeStream.on("error", (err) => {
        log.warn("InnerTube download stream error", { videoId, client, error: String(err).slice(0, 300) });
      });
      return nodeStream;
    } catch (error) {
      if (/login.required/i.test(String(error))) loginRequired = true;
      lastDetail = `${client}: ${String(error).slice(0, 160)}`;
      log.warn("YouTube audio client failed", { videoId, client, error: String(error).slice(0, 300) });
    }
  }
  // Last resort / second chance: a system yt-dlp, which tracks YouTube's breakage on its own
  // release cadence (SABR, PO tokens) independently of youtubei.js.
  const fallback = await ytdlpAudioStream(`https://www.youtube.com/watch?v=${videoId}`, false);
  if (fallback) return fallback;
  log.warn("YouTube audio failed on every client", {
    videoId,
    clients: clients.join(","),
    detail: lastDetail,
    sabrOnly: sawSabrOnly,
    loginRequired,
  });
  if (loginRequired) {
    throw new SourceError(
      "YouTube requires login for this video or the bot's hosting IP. " +
        "Set YOUTUBE_COOKIE on the worker (a browser-exported youtube.com cookie) and try again; " +
        "if all tracks fail, the host may be blocked by YouTube.",
    );
  }
  if (sawSabrOnly) {
    throw new SourceError(
      "YouTube only offered SABR streams for this video (no direct audio URL). " +
        "Install yt-dlp on the worker for automatic fallback, or set YOUTUBE_PO_TOKEN / YOUTUBE_COOKIE — " +
        "and try another track meanwhile.",
    );
  }
  throw new SourceError(
    `YouTube did not provide a usable audio stream (${lastDetail}). ` +
      "Installing yt-dlp on the worker enables automatic fallback; " +
      "if this persists, the extractor or hosting access needs attention.",
  );
}

// ── yt-dlp fallback ──────────────────────────────────────────────────
//
// Piped straight into the voice pipeline (`yt-dlp -o -`), so no disk, no
// temp files. Enabled by presence: any yt-dlp binary on the PATH (or at
// YTDLP_PATH) is used; YTDLP_DISABLED=1 turns the fallback off, and
// YTDLP_COOKIES points at a Netscape cookies.txt for login-gated videos.
//
// yt-dlp is *far* more robust than a single InnerTube download:
// - it does chunked/range requests to bypass YouTube's throttling,
// - it retries fragments,
// - it tracks YouTube's SABR / PO-token breakage independently.
//
// That's why we now try it *first* when YTDLP_PREFER=1 (default) — the
// Muharrem Ahmeti premature stop was a classic throttled ANDROID stream
// that ended after ~3m with no error, so the player went Idle silently.

const execFileAsync = promisify(execFile);

function ytdlpBin(): string | null {
  if (process.env.YTDLP_DISABLED === "1") return null;
  return process.env.YTDLP_PATH?.trim() || "yt-dlp";
}

let ytdlpAvailableCache: boolean | null = null;
let ytdlpAvailableCacheAt = 0;
const YTDLP_CACHE_MS = 60_000;

async function ytdlpAvailable(bin: string): Promise<boolean> {
  const now = Date.now();
  if (ytdlpAvailableCache !== null && now - ytdlpAvailableCacheAt < YTDLP_CACHE_MS) {
    return ytdlpAvailableCache;
  }
  try {
    await execFileAsync(bin, ["--version"], { timeout: 8000 });
    ytdlpAvailableCache = true;
    ytdlpAvailableCacheAt = now;
    return true;
  } catch {
    ytdlpAvailableCache = false;
    ytdlpAvailableCacheAt = now;
    return false;
  }
}

function ytdlpArgs(): string[] {
  // Base args — tuned for voice pipeline robustness.
  const base = [
    "--no-playlist",
    "--no-warnings",
    "--no-cache-dir",
    "--no-progress",
    // Bypass throttling with multiple connections + retries.
    "--retries",
    "5",
    "--fragment-retries",
    "10",
    "--concurrent-fragments",
    "4",
    // Prefer opus/webm when available (smaller, better for voice), fallback to anything.
    "-f",
    "bestaudio[ext=webm]/bestaudio/best",
    "-o",
    "-",
  ];
  // Allow operator to inject extra args via YTDLP_ARGS (space-separated).
  const extra = (process.env.YTDLP_ARGS ?? "")
    .split(" ")
    .map((s) => s.trim())
    .filter(Boolean);
  const args = [...base, ...extra];

  const cookies = process.env.YTDLP_COOKIES?.trim();
  if (cookies) args.push("--cookies", cookies);

  // If operator set YOUTUBE_COOKIE for InnerTube, also pass it to yt-dlp
  // when YTDLP_COOKIES isn't set — improves login-gated videos.
  if (!cookies) {
    const ytCookie = process.env.YOUTUBE_COOKIE?.trim() || process.env.YT_COOKIE?.trim();
    // yt-dlp doesn't accept raw cookie string easily, so we only use file.
    // Operators should set YTDLP_COOKIES for cookie-file usage.
    void ytCookie;
  }

  return args;
}

/**
 * Audio via yt-dlp: pipe `yt-dlp -o -` into the caller. Returns null when
 * yt-dlp isn't installed (or is disabled) so the caller can fall back to
 * InnerTube diagnostics.
 *
 * `isPreferred` controls log wording (preferred vs fallback) and whether we
 * log at info vs debug for availability checks.
 */
async function ytdlpAudioStream(url: string, isPreferred = false): Promise<Readable | null> {
  const bin = ytdlpBin();
  if (!bin) return null;
  if (!(await ytdlpAvailable(bin))) {
    if (isPreferred) {
      log.info("yt-dlp preferred but not available on PATH", { bin });
    }
    return null;
  }
  const args = [...ytdlpArgs(), url];
  try {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    let stderrBuf = "";
    child.stderr?.on("data", (d: Buffer) => {
      // Keep last ~2k for diagnostics.
      stderrBuf += d.toString("utf8");
      if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048);
    });

    const spawned = await new Promise<boolean>((resolve) => {
      child.once("spawn", () => resolve(true));
      child.once("error", (err) => {
        log.warn("yt-dlp spawn failed", { bin, error: String(err).slice(0, 300) });
        resolve(false);
      });
    });
    if (!spawned || !child.stdout) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      if (stderrBuf) log.warn("yt-dlp stderr on spawn fail", { url, stderr: stderrBuf.slice(0, 500) });
      return null;
    }

    child.on("error", (err) => {
      log.warn("yt-dlp child error", { url, error: String(err).slice(0, 300) });
    });

    child.on("close", (code, signal) => {
      // Normal close after stream finished is code 0 or null (killed on skip).
      // Non-zero is worth logging — it often means extractor broke.
      if (code !== 0 && code !== null) {
        log.warn("yt-dlp exited non-zero", { url, code, signal, stderr: stderrBuf.slice(0, 800) });
      } else {
        log.info("yt-dlp process closed", { url, code, signal, bytesStderr: stderrBuf.length });
      }
    });

    const out = child.stdout as unknown as Readable;
    // Don't leak a download process when the track is skipped or stopped.
    out.once("close", () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    });
    out.once("error", (err) => {
      log.warn("yt-dlp stdout error", { url, error: String(err).slice(0, 300), stderr: stderrBuf.slice(0, 500) });
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    });

    log.info(isPreferred ? "using yt-dlp preferred for YouTube audio" : "using yt-dlp fallback for YouTube audio", {
      url,
      bin,
    });
    return out;
  } catch (err) {
    log.warn("yt-dlp spawn exception", { url, error: String(err).slice(0, 300) });
    return null;
  }
}

/** YouTube search → first reasonable video result. */
export async function youtubeSearch(query: string): Promise<VideoMeta | null> {
  const yt = await getYoutube();
  const results: YT.Search = await yt.search(query, { type: "video" });
  const { YTNodes } = await import("youtubei.js");
  for (const node of results.results ?? []) {
    if (!node.is(YTNodes.Video)) continue;
    const video = node as unknown as {
      video_id: string;
      title: { text: string };
      author: { name: string };
      duration: { seconds: number };
      is_live?: boolean;
      thumbnails: { url: string }[];
    };
    if (!video.video_id || video.is_live) continue;
    return {
      videoId: video.video_id,
      title: video.title?.text ?? "Unknown title",
      author: video.author?.name ?? "Unknown channel",
      durationMs: video.duration?.seconds ? video.duration.seconds * 1000 : null,
      thumbnail: video.thumbnails?.at(-1)?.url ?? null,
      isLive: Boolean(video.is_live),
      url: `https://www.youtube.com/watch?v=${video.video_id}`,
    };
  }
  return null;
}

/** All (capped) videos of a YouTube playlist. */
export async function youtubePlaylist(
  playlistId: string,
  cap: number,
): Promise<{ title: string; videos: VideoMeta[]; skipped: number }> {
  const yt = await getYoutube();
  const playlist = await yt.getPlaylist(playlistId);
  const title = playlist.info.title ?? "YouTube playlist";

  const { YTNodes } = await import("youtubei.js");
  const videos: VideoMeta[] = [];
  let skipped = 0;

  for await (const node of iterPlaylistItems(playlist)) {
    if (videos.length >= cap) break;
    // Duck-typed on purpose: youtubei.js renames parser classes between
    // majors; PlaylistVideo's stable surface is id/title/author/duration.
    const item = node as {
      id?: unknown;
      is_playable?: unknown;
      title?: { text?: string };
      author?: { name?: string };
      duration?: { seconds?: number };
      is_live?: unknown;
      thumbnails?: { url: string }[];
    };
    if (typeof item.id !== "string" || item.is_playable === false) {
      skipped += 1;
      continue;
    }
    videos.push({
      videoId: item.id,
      title: item.title?.text ?? "Unknown title",
      author: item.author?.name ?? "Unknown channel",
      durationMs: item.duration?.seconds ? item.duration.seconds * 1000 : null,
      thumbnail: item.thumbnails?.at(-1)?.url ?? null,
      isLive: Boolean(item.is_live),
      url: `https://www.youtube.com/watch?v=${item.id}`,
    });
  }
  return { title, videos, skipped };
}

/** Walks a youtubei.js playlist feed through its continuations. */
interface PlaylistPage {
  items: unknown[];
  has_continuation: boolean;
  getContinuation(): Promise<PlaylistPage>;
}

async function* iterPlaylistItems(playlist: PlaylistPage): AsyncGenerator<unknown> {
  let page: PlaylistPage | null = playlist;
  let guard = 0;
  while (page && guard < 25) {
    guard += 1;
    for (const item of page.items) yield item;
    if (!page.has_continuation) break;
    page = await page.getContinuation().catch(() => null);
  }
}

// ── Spotify Web API ──────────────────────────────────────────────────

interface SpotifyTrackMeta {
  name: string;
  artists: string;
  durationMs: number;
  url: string;
  thumbnail: string | null;
}

export function spotifyConfigured(): boolean {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

class SpotifyClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  private async authHeader(): Promise<string> {
    if (!this.token || Date.now() >= this.token.expiresAt) {
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        },
        body: "grant_type=client_credentials",
      });
      if (!res.ok) throw new SourceError(`Spotify authentication failed (HTTP ${res.status}).`);
      const data = (await res.json()) as { access_token: string; expires_in: number };
      this.token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    }
    return `Bearer ${this.token.value}`;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: await this.authHeader() },
    });
    if (res.status === 404) throw new SourceError("That Spotify link doesn't exist (or was removed).");
    if (res.status === 401) throw new SourceError("Spotify rejected the bot's credentials — check SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET.");
    if (!res.ok) throw new SourceError(`Spotify API error (HTTP ${res.status}).`);
    return (await res.json()) as T;
  }

  async track(id: string): Promise<SpotifyTrackMeta> {
    const data = await this.get<{
      name: string;
      duration_ms: number;
      external_urls: { spotify: string };
      album?: { images?: { url: string }[] };
      artists: { name: string }[];
    }>(`/tracks/${id}`);
    return {
      name: data.name,
      artists: data.artists.map((a) => a.name).join(", "),
      durationMs: data.duration_ms,
      url: data.external_urls.spotify,
      thumbnail: data.album?.images?.at(-1)?.url ?? null,
    };
  }

  /** Search Spotify tracks — used when user forces `source: spotify` for a plain search. */
  async searchTracks(query: string, limit = 5): Promise<SpotifyTrackMeta[]> {
    const q = encodeURIComponent(query);
    const data = await this.get<{
      tracks: {
        items: {
          name: string;
          duration_ms: number;
          external_urls: { spotify: string };
          album?: { images?: { url: string }[] };
          artists: { name: string }[];
        }[];
      };
    }>(`/search?q=${q}&type=track&limit=${Math.min(Math.max(limit, 1), 10)}&market=US`);
    return data.tracks.items.map((t) => ({
      name: t.name,
      artists: t.artists.map((a) => a.name).join(", "),
      durationMs: t.duration_ms,
      url: t.external_urls.spotify,
      thumbnail: t.album?.images?.at(-1)?.url ?? null,
    }));
  }

  /** Album tracks, paged (50/page). */
  async album(id: string, cap: number): Promise<{ name: string; tracks: SpotifyTrackMeta[] }> {
    const meta = await this.get<{
      name: string;
      images?: { url: string }[];
      tracks: { items: SpotifyAlbumItem[]; next: string | null };
    }>(`/albums/${id}`);
    const items = await this.paged<SpotifyAlbumItem>(`/albums/${id}/tracks`, meta.tracks, cap);
    return { name: meta.name, tracks: items.map((t) => this.toMeta(t, meta.images?.at(-1)?.url ?? null)) };
  }

  /** Playlist tracks, paged (100/page). */
  async playlist(id: string, cap: number): Promise<{ name: string; tracks: SpotifyTrackMeta[]; unavailable: number }> {
    const meta = await this.get<{
      name: string;
      images?: { url: string }[];
      tracks: { items: { track: SpotifyAlbumItem | null }[]; next: string | null };
    }>(`/playlists/${id}`);
    // Flatten wrapped playlist items so the pager sees tracks directly.
    const firstPage = {
      items: meta.tracks.items.map((i) => i.track),
      next: meta.tracks.next,
    };
    const items = await this.paged<SpotifyAlbumItem | null>(`/playlists/${id}/tracks`, firstPage, cap);
    let unavailable = 0;
    const tracks: SpotifyTrackMeta[] = [];
    for (const track of items) {
      // null = the track is unavailable in the market / was removed.
      if (!track) {
        unavailable += 1;
        continue;
      }
      tracks.push(this.toMeta(track, meta.images?.at(-1)?.url ?? null));
    }
    return { name: meta.name ?? "Spotify playlist", tracks, unavailable };
  }

  private toMeta(
    item: { name: string; duration_ms: number; external_urls: { spotify: string }; artists: { name: string }[] },
    thumbnail: string | null,
  ): SpotifyTrackMeta {
    return {
      name: item.name,
      artists: item.artists.map((a) => a.name).join(", "),
      durationMs: item.duration_ms,
      url: item.external_urls.spotify,
      thumbnail,
    };
  }

  /** Follows Spotify's `next` cursor, collecting up to `cap` items. */
  private async paged<T>(
    basePath: string,
    first: { items: T[]; next: string | null },
    cap: number,
  ): Promise<T[]> {
    const out: T[] = [...first.items];
    let next = first.next;
    let guard = 0;
    while (next && out.length < cap && guard < 20) {
      guard += 1;
      const res = await fetch(next, { headers: { Authorization: await this.authHeader() } });
      if (!res.ok) throw new SourceError(`Spotify API error (HTTP ${res.status}).`);
      const data = (await res.json()) as { items: T[]; next: string | null };
      out.push(...data.items);
      next = data.next;
    }
    return out.slice(0, cap);
  }
}

type SpotifyAlbumItem = {
  name: string;
  duration_ms: number;
  external_urls: { spotify: string };
  artists: { name: string }[];
};

let spotifyClient: SpotifyClient | null = null;
export function getSpotify(): SpotifyClient {
  if (!spotifyConfigured()) {
    throw new SourceError(
      "Spotify isn't configured on this bot. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET (free at developer.spotify.com/dashboard) to enable Spotify links.",
    );
  }
  spotifyClient ??= new SpotifyClient(process.env.SPOTIFY_CLIENT_ID!, process.env.SPOTIFY_CLIENT_SECRET!);
  return spotifyClient;
}

// ── The resolver facade ──────────────────────────────────────────────

export type MusicSourcePreference = "youtube" | "spotify";

function makeTrack(meta: VideoMeta, requestedBy: string, requestedByName: string): Track {
  return {
    id: randomUUID(),
    title: meta.title,
    author: meta.author,
    videoId: meta.videoId,
    sourceKind: "youtube",
    url: meta.url,
    durationMs: meta.durationMs,
    requestedBy,
    requestedByName,
    thumbnail: meta.thumbnail,
  };
}

function spotifyTrack(
  meta: SpotifyTrackMeta,
  requestedBy: string,
  requestedByName: string,
): Track {
  const label = meta.artists ? `${meta.artists} – ${meta.name}` : meta.name;
  return {
    id: randomUUID(),
    title: label,
    author: "Spotify",
    videoId: "", // resolved against YouTube at play time
    sourceKind: "spotify",
    url: meta.url,
    durationMs: meta.durationMs,
    requestedBy,
    requestedByName,
    thumbnail: meta.thumbnail,
    youtubeSearch: label,
  };
}

/**
 * Resolve any `/music play` input into a list of tracks.
 * `cap` bounds playlist imports.
 * `preferredSource` forces search to use YouTube or Spotify when the query
 * is a plain search phrase (links are always honored as-is).
 */
export async function resolveQuery(
  query: string,
  requestedBy: string,
  requestedByName: string,
  cap: number,
  preferredSource: MusicSourcePreference = "youtube",
): Promise<ResolveResult> {
  const source = classifySource(query);

  switch (source.kind) {
    case "youtube-video": {
      const video = await youtubeVideoMeta(source.id!);
      return { kind: source.kind, origin: video.title, tracks: [makeTrack(video, requestedBy, requestedByName)], skipped: 0 };
    }
    case "youtube-playlist": {
      const { title, videos, skipped } = await youtubePlaylist(source.id!, cap);
      if (videos.length === 0) throw new SourceError(`The playlist “${title}” has no playable videos.`);
      return {
        kind: source.kind,
        origin: title,
        tracks: videos.map((v) => makeTrack(v, requestedBy, requestedByName)),
        skipped,
      };
    }
    case "spotify-track": {
      const meta = await getSpotify().track(source.id!);
      return { kind: source.kind, origin: meta.name, tracks: [spotifyTrack(meta, requestedBy, requestedByName)], skipped: 0 };
    }
    case "spotify-album": {
      const { name, tracks } = await getSpotify().album(source.id!, cap);
      if (tracks.length === 0) throw new SourceError(`The album “${name}” has no playable tracks.`);
      return { kind: source.kind, origin: name, tracks: tracks.map((t) => spotifyTrack(t, requestedBy, requestedByName)), skipped: 0 };
    }
    case "spotify-playlist": {
      const { name, tracks, unavailable } = await getSpotify().playlist(source.id!, cap);
      if (tracks.length === 0) throw new SourceError(`The playlist “${name}” has no playable tracks.`);
      return {
        kind: source.kind,
        origin: name,
        tracks: tracks.map((t) => spotifyTrack(t, requestedBy, requestedByName)),
        skipped: unavailable,
      };
    }
    default: {
      const text = source.query?.trim();
      if (!text) throw new SourceError("Tell me what to play — a YouTube/Spotify link or a search phrase.");

      // User explicitly asked for Spotify search → hit Spotify API first,
      // then lazily resolve to YouTube at play time (same as Spotify links).
      if (preferredSource === "spotify") {
        if (!spotifyConfigured()) {
          throw new SourceError(
            "Spotify search needs SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET set on the bot. " +
              "Falling back to YouTube: try `/music play youtube ${text}` or just omit the source.",
          );
        }
        const spotifyMeta = await getSpotify().searchTracks(text, 1);
        if (spotifyMeta.length === 0) {
          throw new SourceError(`No Spotify track matched “${text}”. Try YouTube search instead.`);
        }
        const first = spotifyMeta[0]!;
        log.info("spotify search resolved", { query: text, result: `${first.artists} – ${first.name}` });
        return {
          kind: "spotify-track",
          origin: first.name,
          tracks: [spotifyTrack(first, requestedBy, requestedByName)],
          skipped: 0,
        };
      }

      // Default / youtube preference → YouTube search.
      const video = await youtubeSearch(text);
      if (!video) throw new SourceError(`No YouTube video matched “${text}”.`);
      return { kind: "search", origin: video.title, tracks: [makeTrack(video, requestedBy, requestedByName)], skipped: 0 };
    }
  }
}

/**
 * The player-facing piece: an audio stream for a track. Spotify tracks get
 * matched to YouTube here (lazily — only for tracks that actually play).
 */
export async function audioStreamFor(track: Track): Promise<Readable> {
  const videoId = await ensureVideoId(track);
  return youtubeAudioStream(videoId);
}

export async function ensureVideoId(track: Track): Promise<string> {
  if (track.videoId) return track.videoId;
  if (!track.youtubeSearch) throw new SourceError("I don't know how to stream that track.");
  const video = await youtubeSearch(track.youtubeSearch);
  if (!video) throw new SourceError(`Couldn't find a playable YouTube match for “${track.title}”.`);
  track.videoId = video.videoId;
  track.url = video.url;
  return video.videoId;
}