/**
 * Music engine types.
 *
 * @monarch/music is deliberately pure: it knows nothing about Discord,
 * voice connections or stream extraction. It owns the *rules* — queue
 * ordering, loop modes, skip elections, role policy — so the bot process
 * (apps/bot) can stay a thin adapter around it, exactly like the design
 * engine / dashboard split.
 */

/**
 * Where a track came from.
 * - `youtube` — resolved by yt-dlp from a YouTube link/search.
 * - `spotify` — metadata from the Spotify Web API, matched to a YouTube track
 *   lazily when it plays.
 * - `other` — anything else yt-dlp supports (SoundCloud, Bandcamp, Twitch,
 *   a direct HTTP audio file…). `sourceName` says which.
 */
export type TrackSourceKind = "youtube" | "spotify" | "other";

/**
 * A single playable item. Created by the bot's source resolver; consumed by
 * the queue engine and rendered into Discord embeds.
 */
export interface Track {
  /** Stable internal id (UUID) — used for removal and identity checks. */
  id: string;
  /** Display title, e.g. the video title or "Artist – Title" for Spotify. */
  title: string;
  /** Channel / uploader / artist display name. */
  author: string;
  /** The source's own id (a YouTube video id, a SoundCloud id…) — used in logs. */
  videoId: string;
  sourceKind: TrackSourceKind;
  /** The node's source name (`youtube`, `soundcloud`, …) for `sourceKind: "other"`. */
  sourceName?: string;
  /**
   * What the downloader is handed when this track plays — normally the watch
   * page (a YouTube URL, a SoundCloud URL…), never a signed stream URL, which
   * would expire while the track sits in the queue. Present for everything
   * resolved up front; Spotify tracks get it lazily, when they actually start
   * playing.
   */
  sourceUrl?: string;
  /** Human-facing URL (watch page / Spotify link). */
  url: string;
  /** null for live streams and unknown lengths. */
  durationMs: number | null;
  /** Discord user id of who queued it. */
  requestedBy: string;
  /** Display name of who queued it (embeds show names, never mentions). */
  requestedByName: string;
  /** Thumbnail URL if the source provides one. */
  thumbnail: string | null;
  /**
   * For Spotify tracks: the "Artist – Title" query used to find a playable
   * YouTube track lazily, at play time (so queuing a 200-track playlist is
   * fast — only played tracks are matched).
   */
  youtubeSearch?: string;
}

export type LoopMode = "off" | "track" | "queue";

export interface QueueSnapshot {
  /** The currently playing (or paused) track, if any. */
  current: Track | null;
  /** Everything queued after the current track, in play order. */
  upcoming: Track[];
  loopMode: LoopMode;
  paused: boolean;
  /** Total duration of `upcoming` (null when any track is live/unknown). */
  upcomingDurationMs: number | null;
}
