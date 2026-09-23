import { randomUUID } from "node:crypto";
import { createLogger } from "@monarch/shared";
import { classifySource, type SourceQuery, type Track } from "@monarch/music";
import {
  YtdlpError,
  ensureYtdlp,
  ytdlpJson,
  ytdlpPlaylist,
  ytdlpSearch,
  type YtdlpEntry,
} from "./ytdlp.js";

/**
 * Source resolution — turns a `/music play` query into playable tracks.
 *
 * Everything audio-related goes through **yt-dlp**: YouTube videos, playlists
 * and searches, SoundCloud/Bandcamp/Twitch links, and plain HTTP audio. yt-dlp
 * does the extraction once, when the track is queued, and again when it plays
 * (that second pass is what gives us a *live* URL — YouTube's are signed and
 * expire within hours, which is why the bot resolves at play time instead of
 * storing a stream URL in the queue).
 *
 * Spotify has no public audio stream, so track/album/playlist links are
 * resolved to *metadata* through the official Web API (client-credentials
 * tokens) and matched to a YouTube track lazily — when the track actually
 * starts playing. That keeps queuing a 200-song playlist instant.
 *
 * Failure here always throws {@link SourceError}: the command layer turns it
 * into a plain, human-readable reply instead of an error log.
 */

const log = createLogger("bot.music");

export const DEFAULT_MAX_QUEUE = 500;
export const DEFAULT_MAX_PLAYLIST_TRACKS = 250;
/** `ytsearch:` is YouTube search; `ytmsearch:`/`scsearch:` also exist. */
export const DEFAULT_SEARCH_PREFIX = "ytsearch";

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

const SEARCH_PREFIXES = ["ytsearch", "ytmsearch", "scsearch"];

/** Which yt-dlp search `play <words>` uses (MUSIC_SEARCH_PREFIX). */
export function searchPrefix(): string {
  const raw = (process.env.MUSIC_SEARCH_PREFIX ?? "").trim().toLowerCase().replace(/:$/, "");
  return SEARCH_PREFIXES.includes(raw) ? raw : DEFAULT_SEARCH_PREFIX;
}

export interface ResolveResult {
  tracks: Track[];
  /** Human label of what was resolved, e.g. the playlist title. */
  origin: string;
  /** Non-fatal count of what was left out, e.g. "12 unavailable videos". */
  skipped: number;
  kind: SourceQuery["kind"];
}

export class SourceError extends Error {}

// ── downloader diagnostics ─────────────────────────────────────────────

/**
 * The one message every "music can't run" path ends in. It names the missing
 * piece and the way to fix it, because "fetch failed" taught nobody anything.
 */
export function downloaderFailureMessage(detail: string): string {
  return (
    "The music downloader (**yt-dlp**) isn't ready on the bot's machine, so nothing can play right now. " +
    `Downloader says: ${detail.slice(0, 300)} ` +
    "Fix: let the bot download it (it does that automatically on the first `/music play`), " +
    "install it yourself from https://github.com/yt-dlp/yt-dlp#installation and set `YTDLP_PATH`, " +
    "then run `/music status`. See docs/troubleshooting-music.md."
  );
}

/** True when a failure means "the downloader itself is missing/broken". */
export function isDownloaderFailure(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error);
  return /yt-dlp|downloader/i.test(text);
}

// ── entry → Track ──────────────────────────────────────────────────────

function isYoutubeEntry(entry: YtdlpEntry): boolean {
  const key = `${entry.extractor ?? ""} ${entry.ie_key ?? ""}`.toLowerCase();
  if (key.includes("youtube")) return true;
  if (entry.webpage_url?.includes("youtube.com") || entry.webpage_url?.includes("youtu.be")) return true;
  // Flat playlist/search entries carry no extractor key, just an 11-char id
  // and a watch URL.
  return Boolean(entry.id && /^[A-Za-z0-9_-]{11}$/.test(entry.id) && !entry.extractor);
}

function entryIsLive(entry: YtdlpEntry): boolean {
  if (entry.is_live === true) return true;
  const status = (entry.live_status ?? "").toLowerCase();
  return status === "is_live" || status === "is_upcoming";
}

function youtubeThumbnail(id: string | undefined): string | null {
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

/** One yt-dlp entry → a `Track`, or null when it isn't playable. */
export function entryToTrack(
  entry: YtdlpEntry,
  requestedBy: string,
  requestedByName: string,
): Track | null {
  const id = entry.id?.trim();
  const title = entry.title?.trim();
  const url = entry.webpage_url ?? entry.url ?? (id ? `https://www.youtube.com/watch?v=${id}` : "");
  if (!title || !url) return null;

  const youtube = isYoutubeEntry(entry);
  const duration = typeof entry.duration === "number" && entry.duration > 0 ? Math.round(entry.duration * 1000) : null;
  const thumbnail = entry.thumbnail ?? entry.thumbnails?.at(-1)?.url ?? (youtube ? youtubeThumbnail(id) : null);

  return {
    id: randomUUID(),
    title,
    author: (entry.uploader ?? entry.channel ?? "Unknown").trim() || "Unknown",
    videoId: id ?? "",
    sourceKind: youtube ? "youtube" : "other",
    sourceName: youtube ? "youtube" : (entry.extractor ?? entry.ie_key ?? "direct"),
    // What yt-dlp is handed when this track plays. For YouTube that is the
    // watch page (never a signed stream URL — those expire).
    sourceUrl: youtube && id ? `https://www.youtube.com/watch?v=${id}` : url,
    url,
    durationMs: entryIsLive(entry) ? null : duration,
    requestedBy,
    requestedByName,
    thumbnail,
  };
}

/** Drop live streams, which can't be played as a bounded track. */
function playable(entries: (YtdlpEntry | null)[]): YtdlpEntry[] {
  return entries.filter((entry): entry is YtdlpEntry => Boolean(entry) && !entryIsLive(entry!));
}

// ── Spotify Web API (metadata only) ────────────────────────────────────

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

  async album(id: string, cap: number): Promise<{ name: string; tracks: SpotifyTrackMeta[] }> {
    const data = await this.get<{
      name: string;
      total_tracks: number;
      external_urls: { spotify: string };
      images?: { url: string }[];
      tracks: {
        items: { name: string; duration_ms: number; artists: { name: string }[]; external_urls?: { spotify: string } }[];
        next: string | null;
      };
    }>(`/albums/${id}`);
    const thumbnail = data.images?.at(-1)?.url ?? null;
    const items = await this.paged<{
      name: string;
      duration_ms: number;
      artists: { name: string }[];
      external_urls?: { spotify: string };
    }>(data.tracks, cap);
    return {
      name: data.name,
      tracks: items.map((item) => ({
        name: item.name,
        artists: item.artists.map((a) => a.name).join(", "),
        durationMs: item.duration_ms,
        url: item.external_urls?.spotify ?? data.external_urls.spotify,
        thumbnail,
      })),
    };
  }

  async playlist(
    id: string,
    cap: number,
  ): Promise<{ name: string; tracks: SpotifyTrackMeta[]; unavailable: number }> {
    const data = await this.get<{
      name: string;
      tracks: {
        items: PlaylistItemEntry[];
        next: string | null;
      };
    }>(`/playlists/${id}`);
    // A playlist holds more than songs: podcast episodes and local files come
    // back in the same list. They have no `artists`, so treating one as a track
    // used to throw and take the whole import down with it — they are counted
    // as unavailable instead.
    const first = data.tracks.items.map(playlistTrack).filter((t): t is PlaylistItem => t !== null);
    const unavailable = data.tracks.items.length - first.length;
    const items = await this.paged<PlaylistItem>(
      { items: first, next: data.tracks.next },
      cap,
      (entry) => playlistTrack(entry as PlaylistItemEntry),
    );
    return {
      name: data.name,
      unavailable,
      tracks: items.map((item) => ({
        name: item.name,
        artists: (item.artists ?? []).map((a) => a.name).join(", "),
        durationMs: item.duration_ms,
        url: item.external_urls?.spotify ?? (item.id ? `https://open.spotify.com/track/${item.id}` : item.name),
        thumbnail: item.album?.images?.at(-1)?.url ?? null,
      })),
    };
  }

  /** Spotify search → up to `limit` tracks (used by `/music play spotify …`). */
  async searchTracks(query: string, limit: number): Promise<SpotifyTrackMeta[]> {
    const data = await this.get<{
      tracks: {
        items: {
          name: string;
          duration_ms: number;
          external_urls: { spotify: string };
          artists: { name: string }[];
          album?: { images?: { url: string }[] };
        }[];
      };
    }>(`/search?type=track&limit=${Math.min(20, Math.max(1, limit))}&q=${encodeURIComponent(query)}`);
    return data.tracks.items.map((item) => ({
      name: item.name,
      artists: item.artists.map((a) => a.name).join(", "),
      durationMs: item.duration_ms,
      url: item.external_urls.spotify,
      thumbnail: item.album?.images?.at(-1)?.url ?? null,
    }));
  }

  /**
   * Follows Spotify's `next` cursor, collecting up to `cap` items. `unwrap`
   * turns one raw page entry into an item (or null to leave it out) — playlist
   * pages wrap their entries, albums don't.
   */
  private async paged<T>(
    first: { items: unknown[]; next: string | null },
    cap: number,
    unwrap: (raw: unknown) => T | null = (raw) => raw as T,
  ): Promise<T[]> {
    const collect = (raw: unknown[]): T[] => raw.map(unwrap).filter((item): item is T => item !== null);
    const out: T[] = collect(first.items);
    let next = first.next;
    let guard = 0;
    while (next && out.length < cap && guard < 20) {
      guard += 1;
      const res = await fetch(next, { headers: { Authorization: await this.authHeader() } });
      if (!res.ok) throw new SourceError(`Spotify API error (HTTP ${res.status}).`);
      const data = (await res.json()) as { items: unknown[]; next: string | null };
      out.push(...collect(data.items));
      next = data.next;
    }
    return out.slice(0, cap);
  }
}

type PlaylistItem = {
  id: string;
  name: string;
  duration_ms: number;
  external_urls?: { spotify: string };
  album?: { images?: { url: string }[] };
  artists: { name: string }[];
};

/** One playlist page entry: a wrapped track, or the newer `item` spelling. */
type PlaylistItemEntry = { track?: PlaylistItem | null; item?: PlaylistItem | null } | null;

/** A page entry → a song, or null when it is an episode/local file/removed. */
function playlistTrack(entry: unknown): PlaylistItem | null {
  const raw = (entry ?? null) as PlaylistItemEntry | PlaylistItem | null;
  const item = raw && "track" in raw ? raw.track : raw && "item" in raw ? raw.item : (raw as PlaylistItem | null);
  if (!item || typeof item.name !== "string" || !Array.isArray(item.artists)) return null;
  return item;
}

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

function spotifyTrack(meta: SpotifyTrackMeta, requestedBy: string, requestedByName: string): Track {
  const label = meta.artists ? `${meta.artists} – ${meta.name}` : meta.name;
  return {
    id: randomUUID(),
    title: label,
    author: "Spotify",
    videoId: "", // matched against a yt-dlp search at play time
    sourceKind: "spotify",
    sourceName: "spotify",
    url: meta.url,
    durationMs: meta.durationMs,
    requestedBy,
    requestedByName,
    thumbnail: meta.thumbnail,
    youtubeSearch: label,
  };
}

// ── the resolver facade ────────────────────────────────────────────────

export type MusicSourcePreference = "youtube" | "spotify";

/**
 * Resolve any `/music play` input into a list of tracks.
 * `cap` bounds playlist imports.
 * `preferredSource` forces search to use YouTube or Spotify when the query is
 * a plain search phrase (links are always honored as-is).
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
      const url = source.url ?? `https://www.youtube.com/watch?v=${source.id}`;
      const entry = await downloader(() => ytdlpJson(url));
      if (entryIsLive(entry)) throw new SourceError("That's a live stream — wait for it to end before queueing it.");
      const track = entryToTrack(entry, requestedBy, requestedByName);
      if (!track) throw new SourceError("That video is unavailable (private, removed, or age-restricted).");
      return { kind: source.kind, origin: track.title, tracks: [track], skipped: 0 };
    }

    case "youtube-playlist": {
      const url = source.url ?? `https://www.youtube.com/playlist?list=${source.id}`;
      const { title, tracks, skipped } = await expandPlaylist(url, cap, requestedBy, requestedByName);
      if (tracks.length === 0) throw new SourceError(`The playlist “${title}” has no playable videos.`);
      return { kind: source.kind, origin: title, tracks, skipped };
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

      // The user explicitly asked for Spotify search → hit Spotify's API first,
      // then match to a YouTube track lazily at play time (same as Spotify links).
      if (preferredSource === "spotify") {
        if (!spotifyConfigured()) {
          throw new SourceError(
            "Spotify search needs SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET set on the bot. " +
              "Falling back to YouTube: try `/music play youtube " +
              text +
              "` or just omit the source.",
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

      // A link the classifier didn't recognize (SoundCloud, Bandcamp, a direct
      // audio file…) is handed to yt-dlp first: it plays whatever it supports.
      // Anything it can't load falls back to being a search phrase.
      if (/^https?:\/\//i.test(text)) {
        const direct = await loadDirectly(text, requestedBy, requestedByName, cap);
        if (direct) return direct;
      }

      const track = await searchFor(text, requestedBy, requestedByName);
      if (!track) throw new SourceError(`No track matched “${text}”.`);
      return { kind: "search", origin: track.title, tracks: [track], skipped: 0 };
    }
  }
}

/**
 * Run a downloader call, translating its failures into `SourceError`. The
 * "is yt-dlp even installed?" case gets the setup message; everything else
 * keeps yt-dlp's own explanation (already translated by ytdlp.ts).
 */
async function downloader<T>(run: () => Promise<T>): Promise<T> {
  try {
    const probe = await ensureYtdlp();
    if (!probe.available) throw new SourceError(downloaderFailureMessage(probe.detail ?? "not installed"));
    return await run();
  } catch (error) {
    if (error instanceof SourceError) throw error;
    if (error instanceof YtdlpError) throw new SourceError(error.message);
    log.warn("downloader call failed", { error: String(error).slice(0, 300) });
    throw new SourceError(`The downloader failed: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`);
  }
}

/**
 * yt-dlp's own search (`ytsearch`, `ytmsearch` or `scsearch` — see
 * {@link searchPrefix}) → the first playable, non-live result.
 *
 * The bare phrase goes in: {@link ytdlpSearch} owns the `ytsearchN:` part, so
 * the search key and the phrase are never doubled up (`ytsearch5:ytsearch:…`
 * makes YouTube search for the literal words "ytsearch:…", which is how a
 * Spotify match quietly became "that song isn't on YouTube").
 */
async function searchFor(
  query: string,
  requestedBy = "",
  requestedByName = "",
  limit = 5,
): Promise<Track | null> {
  const entries = await downloader(() => ytdlpSearch(query, limit, searchPrefix()));
  const first = playable(entries)[0];
  return first ? entryToTrack(first, requestedBy, requestedByName) : null;
}

/** Load a playlist URL, capped, reporting how much was left out. */
async function expandPlaylist(
  url: string,
  cap: number,
  requestedBy: string,
  requestedByName: string,
): Promise<{ title: string; tracks: Track[]; skipped: number }> {
  const result = await downloader(() => ytdlpPlaylist(url, cap));
  const title = result.title?.trim() || result.playlist_count?.toString() || "playlist";
  const entries = Array.isArray(result.entries) ? result.entries : [];
  const usable = playable(entries);
  const unavailable = entries.length - usable.length;
  const kept = usable.slice(0, cap);
  const overCap = usable.length - kept.length;
  const tracks = kept
    .map((entry) => entryToTrack(entry, requestedBy, requestedByName))
    .filter((track): track is Track => track !== null);
  return { title, tracks, skipped: unavailable + overCap };
}

/**
 * Try an unrecognized URL as a direct source. Returns null (not an error) when
 * the downloader can't load it, so the caller can fall back to search.
 */
async function loadDirectly(
  url: string,
  requestedBy: string,
  requestedByName: string,
  cap: number,
): Promise<ResolveResult | null> {
  try {
    const flat = await ytdlpJson(url, { flat: true, limit: cap });
    if (flat._type === "playlist" || Array.isArray(flat.entries)) {
      const { title, tracks, skipped } = await expandPlaylist(url, cap, requestedBy, requestedByName);
      if (tracks.length === 0) return null;
      log.info("loaded a playlist through the downloader", { url, title, tracks: tracks.length });
      return { kind: "search", origin: title, tracks, skipped };
    }
    // A single item: the flat probe has the title but not the duration or
    // thumbnail, so ask once more for the full metadata.
    const entry = await ytdlpJson(url);
    const track = entryToTrack(entry, requestedBy, requestedByName);
    if (!track) return null;
    log.info("loaded a non-YouTube URL through the downloader", { url, source: track.sourceName, title: track.title });
    return { kind: "search", origin: track.title, tracks: [track], skipped: 0 };
  } catch (error) {
    log.info("direct URL load failed, falling back to search", { url, error: String(error).slice(0, 200) });
    return null;
  }
}

/**
 * The player-facing piece: make sure a track has something yt-dlp can open.
 * YouTube tracks (and everything else the downloader resolved) arrive with a
 * `sourceUrl`; Spotify tracks are matched to a YouTube search here, lazily —
 * only for the ones that actually play.
 */
export async function ensurePlayable(track: Track): Promise<Track> {
  if (track.sourceUrl) return track;
  if (!track.youtubeSearch) throw new SourceError("I don't know how to play that track.");

  const phrase = track.youtubeSearch.trim();
  const match = await searchFor(phrase, track.requestedBy, track.requestedByName);
  if (!match) {
    // Reached only when the search itself worked and still had nothing usable:
    // every hit was a live stream, a video without audio, or a dead entry. Say
    // that — "couldn't find it on YouTube" reads like the song doesn't exist,
    // and that is what sent people looking for the wrong problem.
    throw new SourceError(
      `**${track.title}** isn't on ${searchLabel()} in a form I can play — I searched for “${phrase}” ` +
        "and every result was a live stream, a video without audio, or a removed upload. " +
        "Play it from YouTube directly if you know the video.",
    );
  }

  track.sourceUrl = match.sourceUrl;
  track.videoId = match.videoId;
  track.sourceName = match.sourceName;
  track.durationMs = track.durationMs ?? match.durationMs;
  track.thumbnail = track.thumbnail ?? match.thumbnail;
  log.info("spotify track matched on YouTube", { track: track.title, videoId: track.videoId, phrase });
  return track;
}

/** Human name of the configured search backend, for error messages. */
export function searchLabel(prefixed = searchPrefix()): string {
  if (prefixed === "ytmsearch") return "YouTube Music";
  if (prefixed === "scsearch") return "SoundCloud";
  return "YouTube";
}
