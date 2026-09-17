import { randomUUID } from "node:crypto";
import { createLogger } from "@monarch/shared";
import { classifySource, type SourceQuery, type Track } from "@monarch/music";
import {
  LavalinkError,
  getLavalink,
  type LavalinkLoadResult,
  type LavalinkTrack,
} from "./lavalink.js";

/**
 * Source resolution — turns a `/music play` query into playable tracks.
 *
 * Everything audio-related goes through the **Lavalink node**: YouTube videos
 * and playlists, plain searches, and any other source the node has enabled
 * (SoundCloud, Bandcamp, direct HTTP audio). `GET /v4/loadtracks` answers with
 * an *encoded* track plus its metadata, and the node resolves the actual audio
 * when playback starts — so queuing a 250-track playlist is one request and no
 * per-track scraping on our side.
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
/** `ytsearch:` is the node's YouTube search; `ytmsearch:`/`scsearch:` also exist. */
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

/** Which node search prefix plain queries use (MUSIC_SEARCH_PREFIX). */
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

// ── Lavalink track loading ─────────────────────────────────────────────

/**
 * One `loadtracks` call, with every transport failure translated into
 * something a person can act on. A dead node must never look like "that song
 * doesn't exist".
 */
async function load(identifier: string): Promise<LavalinkLoadResult> {
  try {
    return await getLavalink().loadTracks(identifier);
  } catch (error) {
    throw new SourceError(backendFailureMessage(error));
  }
}

export function backendFailureMessage(error: unknown): string {
  const detail = error instanceof LavalinkError ? error.message : String(error).slice(0, 200);
  const unreachable =
    error instanceof LavalinkError && (error.status === undefined || error.status >= 500);
  if (unreachable) {
    const host = process.env.LAVALINK_HOST?.trim() || "localhost";
    const port = process.env.LAVALINK_PORT?.trim() || "2333";
    const nodes = process.env.LAVALINK_NODES?.trim() || `ws://${host}:${port}`;
    const isLocal = nodes.includes("localhost") || nodes.includes("127.0.0.1") || host === "localhost" || nodes.includes("lavalink");
    const fix = isLocal
      ? `Start it with: \`docker compose -f docker/docker-compose.yml up -d lavalink\` (from repo root), ` +
        `or \`cd docker && docker compose up -d lavalink\`. ` +
        `Then check \`curl http://localhost:${port}/version\` and \`docker logs monarch-lavalink\`. ` +
        `If 401, LAVALINK_PASSWORD in .env must match docker/lavalink/application.yml. ` +
        `Run \`npm run music:check\` — docs/troubleshooting-music.md has the full checklist.`
      : `The bot is configured for ${nodes} but can't reach it. ` +
        `Make sure the node is up, reachable, and LAVALINK_NODES / LAVALINK_PASSWORD match its application.yml. ` +
        `Run \`npm run music:check\` for diagnosis.`;

    return (
      "The music backend (Lavalink) isn't answering, so nothing can play right now. " +
      `Node says: ${detail} ` +
      fix
    );
  }
  return `The music node couldn't load that: ${detail}`;
}

/** Turn a node `loadType: "error"` answer into a readable failure. */
function loadErrorMessage(data: { message: string | null; cause?: string }): string {
  const message = data.message?.trim();
  const cause = data.cause?.trim();
  const detail = message || cause || "no reason given";
  // Lavalink's own YouTube failures are worth naming: they're the thing an
  // operator can fix on the node (plugin version, IPv6 rotation, cookies).
  if (/isn't what was requested/i.test(detail)) {
    return (
      "YouTube refused this video for the node's IP (\"Video returned by YouTube isn't what was requested\"). " +
      "It's a node-side rate limit, not a bot bug: update the youtube-source plugin, enable IPv6 rotation " +
      "(`lavalink.server.ratelimit.ipBlocks`), or turn on OAuth / a poToken for YouTube. " +
      "All three live in the node's application.yml — the repo's copy is docker/lavalink/application.yml."
    );
  }
  return `The music node couldn't load that: ${detail}`;
}

/** The single track a `track`/`search`/`playlist` answer is about, if any. */
function firstPlayable(result: LavalinkLoadResult): LavalinkTrack | null {
  const list = playableList(result);
  return list.find((track) => !track.info.isStream) ?? null;
}

/** Every usable track in a load answer (live streams excluded). */
function playableList(result: LavalinkLoadResult): LavalinkTrack[] {
  switch (result.loadType) {
    case "track":
      return [result.data];
    case "search":
      return result.data;
    case "playlist":
      return result.data.tracks;
    default:
      return [];
  }
}

function toTrack(lv: LavalinkTrack, requestedBy: string, requestedByName: string): Track {
  const info = lv.info;
  const sourceKind = info.sourceName === "youtube" ? "youtube" : "other";
  return {
    id: randomUUID(),
    title: info.title?.trim() || "Unknown title",
    author: info.author?.trim() || "Unknown",
    videoId: info.identifier ?? "",
    sourceKind,
    sourceName: info.sourceName ?? undefined,
    url: info.uri ?? (info.identifier ? `https://www.youtube.com/watch?v=${info.identifier}` : ""),
    // 0 means "the node doesn't know" (live, or a source without durations).
    durationMs: info.isStream || !info.length ? null : info.length,
    requestedBy,
    requestedByName,
    thumbnail: info.artworkUrl ?? null,
    encoded: lv.encoded,
  };
}

function spotifyTrack(meta: SpotifyTrackMeta, requestedBy: string, requestedByName: string): Track {
  const label = meta.artists ? `${meta.artists} – ${meta.name}` : meta.name;
  return {
    id: randomUUID(),
    title: label,
    author: "Spotify",
    videoId: "", // matched against the node's YouTube search at play time
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

  /** Search Spotify tracks — used when the user forces `source: spotify` for a plain search. */
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

// ── The resolver facade ────────────────────────────────────────────────

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
      const result = await load(url);
      if (result.loadType === "error") throw new SourceError(loadErrorMessage(result.data));
      const track = firstPlayable(result);
      if (!track) {
        if (playableList(result).length > 0) throw new SourceError("That's a live stream — queue it again once it has ended.");
        throw new SourceError("That video is unavailable (private, removed, age-restricted, or blocked for the node's IP).");
      }
      const made = toTrack(track, requestedBy, requestedByName);
      return { kind: source.kind, origin: made.title, tracks: [made], skipped: 0 };
    }

    case "youtube-playlist": {
      const url = source.url ?? `https://www.youtube.com/playlist?list=${source.id}`;
      const { title, tracks, skipped } = await loadPlaylist(url, cap, requestedBy, requestedByName);
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

      // A link the classifier didn't recognize (SoundCloud, Bandcamp, a direct
      // audio file…) is worth handing to the node first: it plays whatever
      // sources its application.yml enables. Anything it can't load falls back
      // to being a search phrase, exactly like before.
      if (/^https?:\/\//i.test(text)) {
        const direct = await loadDirectly(text, requestedBy, requestedByName, cap);
        if (direct) return direct;
      }

      const track = await searchOne(text);
      if (!track) throw new SourceError(`No track matched “${text}”.`);
      const made = toTrack(track, requestedBy, requestedByName);
      return { kind: "search", origin: made.title, tracks: [made], skipped: 0 };
    }
  }
}

/** The node's own search → first non-live result. */
async function searchOne(query: string): Promise<LavalinkTrack | null> {
  const result = await load(`${searchPrefix()}:${query}`);
  if (result.loadType === "error") throw new SourceError(loadErrorMessage(result.data));
  return firstPlayable(result);
}

/** Load a playlist URL, capped, reporting how much was left out. */
async function loadPlaylist(
  url: string,
  cap: number,
  requestedBy: string,
  requestedByName: string,
): Promise<{ title: string; tracks: Track[]; skipped: number }> {
  const result = await load(url);
  if (result.loadType === "error") throw new SourceError(loadErrorMessage(result.data));
  if (result.loadType === "empty") return { title: "playlist", tracks: [], skipped: 0 };

  // A playlist URL can answer as a single track (a mix, or a node that only
  // resolved the watch link) — honor whatever came back.
  if (result.loadType !== "playlist") {
    const track = firstPlayable(result);
    return {
      title: track?.info.title ?? "playlist",
      tracks: track ? [toTrack(track, requestedBy, requestedByName)] : [],
      skipped: 0,
    };
  }

  const title = result.data.info.name?.trim() || "playlist";
  const playable = result.data.tracks.filter((track) => !track.info.isStream);
  const unavailable = result.data.tracks.length - playable.length;
  const kept = playable.slice(0, cap);
  const overCap = playable.length - kept.length;
  return {
    title,
    tracks: kept.map((track) => toTrack(track, requestedBy, requestedByName)),
    skipped: unavailable + overCap,
  };
}

/**
 * Try an unrecognized URL as a direct source. Returns null (not an error) when
 * the node can't load it, so the caller can fall back to treating it as text.
 */
async function loadDirectly(
  url: string,
  requestedBy: string,
  requestedByName: string,
  cap: number,
): Promise<ResolveResult | null> {
  let result: LavalinkLoadResult;
  try {
    result = await getLavalink().loadTracks(url);
  } catch (error) {
    log.info("direct URL load failed, falling back to search", { url, error: String(error).slice(0, 200) });
    return null;
  }
  if (result.loadType === "empty") return null;
  if (result.loadType === "error") {
    log.info("node refused the direct URL, falling back to search", { url, message: result.data.message });
    return null;
  }
  if (result.loadType === "playlist") {
    const { title, tracks, skipped } = await loadPlaylist(url, cap, requestedBy, requestedByName);
    if (tracks.length === 0) return null;
    return { kind: "search", origin: title, tracks, skipped };
  }
  const track = firstPlayable(result);
  if (!track) return null;
  const made = toTrack(track, requestedBy, requestedByName);
  log.info("loaded a non-YouTube URL through the node", { url, source: made.sourceName, title: made.title });
  return { kind: "search", origin: made.title, tracks: [made], skipped: 0 };
}

/**
 * The player-facing piece: make sure a track has something the node can play.
 * YouTube tracks arrive pre-encoded from `resolveQuery`; Spotify tracks are
 * matched to YouTube here, lazily, only for the ones that actually play.
 */
export async function ensurePlayable(track: Track): Promise<Track> {
  if (track.encoded) return track;
  if (!track.youtubeSearch) throw new SourceError("I don't know how to play that track.");

  const match = await searchOne(track.youtubeSearch);
  if (!match) throw new SourceError(`Couldn't find a playable YouTube match for “${track.title}”.`);

  track.encoded = match.encoded;
  track.videoId = match.info.identifier ?? "";
  track.durationMs = track.durationMs ?? (match.info.isStream || !match.info.length ? null : match.info.length);
  track.thumbnail = track.thumbnail ?? match.info.artworkUrl ?? null;
  log.info("spotify track matched on the node", { track: track.title, videoId: track.videoId });
  return track;
}
