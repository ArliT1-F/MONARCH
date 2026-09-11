import type { LoopMode, QueueSnapshot, Track } from "./types.js";

/**
 * Per-guild playback queue — pure state, no I/O.
 *
 * The bot's player adapter advances this queue on every `Idle` event; the
 * engine decides *what* is next (loop modes), the adapter decides *how* to
 * play it (stream extraction, voice connection).
 *
 * Positions shown to users ("#1 … #n") are 1-based and refer to `upcoming`.
 */
export class MusicQueue {
  private current: Track | null = null;
  private items: Track[] = [];
  private loop: LoopMode = "off";
  private paused = false;

  /** Insert a track at the end. Returns its 1-based position in `upcoming`. */
  add(track: Track): number {
    this.items.push(track);
    return this.items.length;
  }

  /** Insert several tracks. Returns how many were queued (after the cap). */
  addMany(tracks: Track[], cap = Number.POSITIVE_INFINITY): number {
    let added = 0;
    for (const track of tracks) {
      if (this.items.length >= cap) break;
      this.items.push(track);
      added += 1;
    }
    return added;
  }

  /**
   * Advance to the next track, honoring loop modes. This is the single way
   * to move playback forward — including the very first play (`add` puts
   * tracks on the queue, `next()` takes the head).
   *
   * - `off`   → pop the head, previous track is gone.
   * - `track` → current track stays current (replay it).
   * - `queue` → current track goes to the back, next up is played.
   *
   * `skipCurrent` discards a failed track regardless of loop mode.
   *
   * Returns the new current track, or `null` when the queue ran dry (the
   * player should go idle).
   */
  next(skipCurrent = false): Track | null {
    if (!skipCurrent && this.loop === "track" && this.current) return this.current;
    if (!skipCurrent && this.loop === "queue" && this.current) this.items.push(this.current);
    this.current = this.items.shift() ?? null;
    return this.current;
  }

  /** The currently playing (or paused) track. */
  nowPlaying(): Track | null {
    return this.current;
  }

  upcoming(): readonly Track[] {
    return this.items;
  }

  /** Remove a queued track by 1-based position. Returns it, or null. */
  remove(position: number): Track | null {
    if (!Number.isInteger(position) || position < 1 || position > this.items.length) return null;
    const [removed] = this.items.splice(position - 1, 1);
    return removed ?? null;
  }

  /** Drop everything that is queued (keeps the current track). Returns count. */
  clear(): number {
    const n = this.items.length;
    this.items = [];
    return n;
  }

  /** Shuffle the upcoming tracks (current track is left alone). */
  shuffle(): number {
    for (let i = this.items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = this.items[i];
      const b = this.items[j];
      if (a && b) {
        this.items[i] = b;
        this.items[j] = a;
      }
    }
    return this.items.length;
  }

  setLoop(mode: LoopMode): void {
    this.loop = mode;
  }

  get loopMode(): LoopMode {
    return this.loop;
  }

  /** Cycles off → track → queue → off. Returns the new mode. */
  cycleLoop(): LoopMode {
    this.loop = this.loop === "off" ? "track" : this.loop === "track" ? "queue" : "off";
    return this.loop;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get size(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0 && this.current === null;
  }

  snapshot(): QueueSnapshot {
    const upcomingDurationMs = this.items.every((t) => typeof t.durationMs === "number")
      ? this.items.reduce((sum, t) => sum + (t.durationMs ?? 0), 0)
      : null;
    return {
      current: this.current,
      upcoming: [...this.items],
      loopMode: this.loop,
      paused: this.paused,
      upcomingDurationMs,
    };
  }
}