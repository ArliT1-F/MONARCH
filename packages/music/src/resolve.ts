/**
 * Source classification — "what did the user type?"
 *
 * Pure URL/URI parsing for the two supported platforms:
 * - YouTube: watch pages, youtu.be links, Shorts, music.youtube.com and
 *   playlists (`/playlist?list=` or a `list=` parameter).
 * - Spotify: open.spotify.com links (and `spotify:` URIs) for tracks,
 *   albums and playlists.
 *
 * Anything that isn't a link is a search query. YouTube search results are
 * resolved straight to a video; Spotify needs the Web API first (see the
 * bot's source resolver).
 */

export type SourceKind =
  | "youtube-video"
  | "youtube-playlist"
  | "spotify-track"
  | "spotify-album"
  | "spotify-playlist"
  | "search";

export interface SourceQuery {
  kind: SourceKind;
  /** YouTube video id / Spotify id, when applicable. */
  id?: string;
  /** A YouTube playlist found via `list=` on a watch URL — the video plays first. */
  playlistId?: string;
  /** The raw search text for `kind: "search"`. */
  query?: string;
  /** Cleaned-up canonical URL when the input was a link. */
  url?: string;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const SPOTIFY_HOSTS = new Set(["open.spotify.com", "play.spotify.com"]);

/** Recognized Spotify entity types for music (shows/podcasts are refused by the resolver). */
const SPOTIFY_MUSIC_TYPES = new Set(["track", "album", "playlist"]);

const ID = "[A-Za-z0-9_-]{10,}"; // YouTube ids are 11 chars; Spotify base62 is 22 — both match this.

export function classifySource(raw: string): SourceQuery {
  const input = raw.trim();
  if (!input) return { kind: "search", query: "" };

  // spotify:track:4uLU6h… URIs
  const uri = input.match(new RegExp(`^spotify:(track|album|playlist):(${ID})$`, "i"));
  if (uri) {
    const type = uri[1]!.toLowerCase();
    return { kind: `spotify-${type}` as SourceKind, id: uri[2], url: `https://open.spotify.com/${type}/${uri[2]}` };
  }

  let parsed: URL;
  try {
    parsed = new URL(input.startsWith("http") ? input : `https://${input}`);
  } catch {
    return { kind: "search", query: input };
  }

  if (YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) {
    if (parsed.hostname.toLowerCase() === "youtu.be" || parsed.hostname.toLowerCase() === "www.youtu.be") {
      const id = parsed.pathname.slice(1).split("/")[0];
      if (id && new RegExp(`^${ID}$`).test(id)) {
        const playlistId = parsed.searchParams.get("list") ?? undefined;
        return { kind: "youtube-video", id, playlistId, url: `https://www.youtube.com/watch?v=${id}` };
      }
      return { kind: "search", query: input };
    }
    const playlistParam = parsed.searchParams.get("list");
    if (parsed.pathname === "/watch") {
      const videoId = parsed.searchParams.get("v");
      if (videoId && new RegExp(`^${ID}$`).test(videoId)) {
        return {
          kind: "youtube-video",
          id: videoId,
          playlistId: playlistParam ?? undefined,
          url: `https://www.youtube.com/watch?v=${videoId}`,
        };
      }
      return { kind: "search", query: input };
    }
    if (parsed.pathname === "/playlist") {
      if (playlistParam) return { kind: "youtube-playlist", id: playlistParam, url: `https://www.youtube.com/playlist?list=${playlistParam}` };
      return { kind: "search", query: input };
    }
    const short = parsed.pathname.match(new RegExp(`^/(shorts|embed|live|v)/(${ID})`));
    if (short) {
      const id = short[2];
      return { kind: "youtube-video", id, url: `https://www.youtube.com/watch?v=${id}` };
    }
    return { kind: "search", query: input };
  }

  if (SPOTIFY_HOSTS.has(parsed.hostname.toLowerCase())) {
    const parts = parsed.pathname.split("/").filter(Boolean); // e.g. ["track", "<id>"]
    const kind = parts[0]?.toLowerCase();
    const id = parts[1];
    if (kind && id && SPOTIFY_MUSIC_TYPES.has(kind) && new RegExp(`^${ID}$`).test(id)) {
      return { kind: `spotify-${kind}` as SourceKind, id, url: `https://open.spotify.com/${kind}/${id}` };
    }
    // Internationalized paths like /intl-de/track/<id>
    if (parts[0]?.toLowerCase().startsWith("intl-")) {
      const innerKind = parts[1]?.toLowerCase();
      const innerId = parts[2];
      if (innerKind && innerId && SPOTIFY_MUSIC_TYPES.has(innerKind) && new RegExp(`^${ID}$`).test(innerId)) {
        return { kind: `spotify-${innerKind}` as SourceKind, id: innerId, url: `https://open.spotify.com/${innerKind}/${innerId}` };
      }
    }
    return { kind: "search", query: input };
  }

  // Any other link is treated as a search term rather than silently ignored.
  return { kind: "search", query: input };
}