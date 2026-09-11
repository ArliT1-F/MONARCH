/**
 * Music engine types.
 *
 * @monarch/music is deliberately pure: it knows nothing about Discord,
 * voice connections or stream extraction. It owns the *rules* — queue
 * ordering, loop modes, skip elections, role policy — so the bot process
 * (apps/bot) can stay a thin adapter around it, exactly like the design
 * engine / dashboard split.
 */

/** Where a track came from. The player uses this to pick a stream strategy. */
export type TrackSourceKind = "youtube" | "spotify";

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
  /** The id the stream layer needs (YouTube video id today). */
  videoId: string;
  sourceKind: TrackSourceKind;
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
   * YouTube video lazily, at play time (so queuing a 200-track playlist is
   * fast — only played tracks hit YouTube).
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
