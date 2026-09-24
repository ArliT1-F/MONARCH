import {
  MusicQueue,
  SkipElector,
  canForceSkip,
  formatDuration,
  progressBar,
  DEFAULT_DJ_ROLE_NAMES,
  DEFAULT_STAFF_ROLE_NAMES,
  type ForceSkipReason,
  type Track,
} from "@monarch/music";
import { createLogger } from "@monarch/shared";
import type {
  APIEmbed,
  Client,
  Guild,
  GuildMember,
  VoiceBasedChannel,
  VoiceState,
} from "discord.js";
import {
  AudioError,
  DiscordAudioBackend,
  type AudioBackend,
  type TrackEndReason,
} from "./audio.js";
import { SourceError, ensurePlayable, isDownloaderFailure, musicLimits } from "./sources.js";
import { YtdlpError } from "./ytdlp.js";
import type { DebugReporter } from "../debug.js";

/**
 * The voice layer: one audio session per guild, driven by the pure
 * `MusicQueue` from @monarch/music.
 *
 * Audio runs *in this process* — yt-dlp fetches the bytes, ffmpeg (when
 * present) turns them into PCM so volume works, and @discordjs/voice owns the
 * UDP socket to Discord. There is no Lavalink node, no Java and no second
 * service to babysit: `npm install` plus the bot token is the whole setup.
 *
 * The queue rules, skip votes and role policy stay in @monarch/music; this
 * file is the adapter that turns them into Discord voice, and {@link AudioBackend}
 * is the seam that keeps that adapter testable without a voice socket.
 */
const log = createLogger("bot.music");

const EMPTY_CHANNEL_LEAVE_MS = 60_000; // alone in voice → leave after this
const IDLE_LEAVE_MS = 5 * 60_000; // nothing playing → leave after this
const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * If a track ends more than this far before its known length, say so. With a
 * local downloader this is rare — when it does happen the cause is almost
 * always on the source side (a throttle, a blocked IP, an expired extractor),
 * and the announcement points there instead of silently skipping ahead.
 */
const PREMATURE_EARLY_MS = 15_000;

/** Announcements the manager posts to the guild's music text channel. */
export type Announce = (guildId: string, embed: APIEmbed, content?: string) => void;

export interface MusicManagerConfig {
  djRoleNames: readonly string[];
  staffRoleNames: readonly string[];
}

export function musicManagerConfigFromEnv(): MusicManagerConfig {
  const list = (name: string, fallback: readonly string[]): string[] => {
    const raw = (process.env[name] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return raw.length > 0 ? raw : [...fallback];
  };
  return {
    djRoleNames: list("MUSIC_DJ_ROLE_NAMES", DEFAULT_DJ_ROLE_NAMES),
    staffRoleNames: list("MUSIC_STAFF_ROLE_NAMES", DEFAULT_STAFF_ROLE_NAMES),
  };
}

interface GuildPlayback {
  queue: MusicQueue;
  elector: SkipElector;
  voiceChannelId: string | null;
  textChannelId: string | null;
  volume: number; // 0–150
  playing: boolean;
  paused: boolean;
  skipping: boolean;
  stopping: boolean;
  advancing: boolean;
  failStreak: number;
  leaveTimer: NodeJS.Timeout | null;
}

export class MusicManager {
  private readonly sessions = new Map<string, GuildPlayback>();

  constructor(
    private readonly client: Client,
    private readonly announce: Announce,
    private readonly config: MusicManagerConfig = musicManagerConfigFromEnv(),
    private readonly backend: AudioBackend = new DiscordAudioBackend(),
    /**
     * Owner-only switch (`/monarch debug on`). Absent in tests and when the
     * feature is off, which is the safe default: failures stay one tidy line.
     */
    private readonly debug?: DebugReporter,
  ) {
    this.wireBackend();
  }

  /**
   * Post raw failure detail when the owner turned debugging on. Callers hand
   * over the original error (or the backend's own words) untouched — the switch
   * decides whether a soul sees it.
   */
  reportDebug(guildId: string, error: unknown): void {
    if (!this.debug?.enabled()) return;
    const text = rawFailureDetail(error);
    if (text) this.debug.post(guildId, text);
  }

  // ── session plumbing ──────────────────────────────────────────────

  private session(guildId: string): GuildPlayback {
    const existing = this.sessions.get(guildId);
    if (existing) return existing;

    const s: GuildPlayback = {
      queue: new MusicQueue(),
      elector: new SkipElector(),
      voiceChannelId: null,
      textChannelId: null,
      volume: 100,
      playing: false,
      paused: false,
      skipping: false,
      stopping: false,
      advancing: false,
      failStreak: 0,
      leaveTimer: null,
    };
    this.sessions.set(guildId, s);
    return s;
  }

  /** Route the audio backend's events into this manager. Wired once, in the constructor. */
  private wireBackend(): void {
    this.backend.on("trackEnd", ({ guildId, trackId, reason, elapsedMs, error, raw }) => {
      const s = this.sessions.get(guildId);
      if (!s) return; // torn down; a late event is not our business
      const current = s.queue.nowPlaying();
      // Ignore the tail of a track we already moved on from (a failure event
      // arriving after the next track started, for example).
      if (current && trackId && trackId !== current.id) {
        log.info("ignoring a stale track end", {
          guildId,
          reason,
          stale: trackId,
          current: current.id,
        });
        return;
      }
      s.playing = false;
      log.info("track ended", {
        guildId,
        reason,
        track: current?.title ?? null,
        elapsedMs: Math.round(elapsedMs),
        ...(reason === "finished" ? {} : { error: error ?? null }),
      });
      void this.onTrackEnd(guildId, s, reason, elapsedMs, error, raw);
    });

    this.backend.on("voiceClosed", ({ guildId, reason }) => {
      const s = this.sessions.get(guildId);
      log.warn("voice connection lost", { guildId, reason, wasActive: Boolean(s) });
      if (!s || s.stopping) return;
      this.announce(guildId, {
        color: 0xed4245,
        title: "🔌 Voice connection lost",
        description: `${reason} — run \`/music play\` to start again.`,
      });
      this.teardown(guildId, false);
    });
  }

  private cancelLeaveTimer(s: GuildPlayback): void {
    if (s.leaveTimer) {
      clearTimeout(s.leaveTimer);
      s.leaveTimer = null;
    }
  }

  /** True when this is the last track (nothing queued behind it). */
  private isLastTrack(s: GuildPlayback): boolean {
    return s.queue.size === 0;
  }

  private announceFailure(guildId: string, reason: string, raw?: string): void {
    this.announce(guildId, {
      color: 0xed4245,
      title: "⚠️ Track failed",
      description: reason,
    });
    // `/monarch debug on` — the same failure, in the downloader's own words.
    if (raw) this.reportDebug(guildId, raw);
  }

  // ── track endings ──────────────────────────────────────────────────

  /**
   * One place decides what a track ending means: `finished` and `failed` move
   * the queue on, `stopped` is ours (a skip or a teardown).
   */
  private async onTrackEnd(
    guildId: string,
    s: GuildPlayback,
    reason: TrackEndReason,
    elapsedMs: number,
    error?: string,
    raw?: string,
  ): Promise<void> {
    const wasSkipping = s.skipping;
    s.skipping = false;

    if (reason === "stopped") {
      if (!wasSkipping) return; // teardown already owns this
      // A skip drops the track it stopped — only that one, whatever the loop
      // mode says. `dropCurrent` is what keeps "skip" from ever replaying the
      // song it was asked to leave.
      await this.playNext(guildId, "skipped", true);
      return;
    }

    const finishedTrack = s.queue.nowPlaying();
    const expected = finishedTrack?.durationMs ?? null;

    if (reason === "failed") {
      s.failStreak += 1;
      this.announceFailure(
        guildId,
        error ?? `**${finishedTrack?.title ?? "That track"}** couldn't be played — skipping ahead.`,
        raw,
      );
      if (s.failStreak >= MAX_CONSECUTIVE_FAILURES) {
        await this.giveUp(guildId);
        return;
      }
      // A track that failed is dropped regardless of the loop mode.
      await this.playNext(guildId, "load-failed", true);
      return;
    }

    // `finished`.
    const elapsed = Math.round(elapsedMs);
    const wasPremature =
      expected !== null && elapsed > 0 && elapsed + PREMATURE_EARLY_MS < expected;
    if (finishedTrack) {
      if (wasPremature) {
        log.warn("track ended prematurely", {
          guildId,
          track: finishedTrack.title,
          videoId: finishedTrack.videoId,
          elapsedMs: elapsed,
          expectedMs: expected,
          elapsed: formatDuration(elapsed),
          expected: formatDuration(expected),
        });
        this.announce(guildId, {
          color: 0xed4245,
          title: "⚠️ Track cut short",
          description:
            `**${finishedTrack.title}** stopped at \`${formatDuration(elapsed)}\` but should be \`${formatDuration(expected)}\`.\n` +
            "The stream ended early on the source's side — usually YouTube throttling or blocking the bot's IP. " +
            "A `cookies.txt` for YouTube (`YTDLP_COOKIES`), an up-to-date yt-dlp, or a different host fixes it " +
            "(see `docs/troubleshooting-music.md`). Skipping ahead.",
        });
      } else {
        log.info("track finished", {
          guildId,
          track: finishedTrack.title,
          videoId: finishedTrack.videoId,
          elapsedMs: elapsed,
          expectedMs: expected,
          skipped: wasSkipping,
        });
      }
    } else {
      log.info("track ended with no current track", { guildId, reason, why: "finished" });
    }

    await this.playNext(guildId, wasSkipping ? "skipped" : "finished", wasSkipping);
  }

  private async giveUp(guildId: string): Promise<void> {
    this.announce(guildId, {
      color: 0xed4245,
      title: "⏹ Giving up",
      description: `${MAX_CONSECUTIVE_FAILURES} tracks in a row failed. Use \`/music play\` to start again.`,
    });
    this.teardown(guildId, false);
  }

  // ── playback ───────────────────────────────────────────────────────

  /**
   * Pull the next track and hand it to the audio backend. `why` only feeds the
   * logs. When the queue runs dry the bot stays connected for a few minutes
   * (IDLE_LEAVE_MS) in case someone queues more, then leaves.
   */
  private async playNext(guildId: string, why: string, dropCurrent = false): Promise<void> {
    const s = this.session(guildId);
    if (s.advancing || s.stopping) return;
    s.advancing = true;
    try {
      // `skipFailed` (and the caller's `dropCurrent`) discard the track that
      // was current: a failed one, or the one a user just skipped. Loop modes
      // never resurrect a track that was explicitly left behind.
      let skipFailed = dropCurrent;
      while (!s.stopping) {
        const track = s.queue.next(skipFailed);
        s.elector.reset(guildId);
        if (!track) {
          s.playing = false;
          s.paused = false;
          s.queue.setPaused(false);
          this.scheduleIdleLeave(guildId, s);
          log.info("queue drained", { guildId, why });
          return;
        }
        this.cancelLeaveTimer(s);

        try {
          // Spotify tracks are matched to a YouTube track here — lazily, so
          // queuing a 200-track playlist stayed instant.
          await ensurePlayable(track);
          if (s.stopping || this.sessions.get(guildId) !== s) return;
          await this.ensureVoice(guildId, s);
          if (s.stopping || this.sessions.get(guildId) !== s) return;
          if (s.skipping) {
            // A skip landed while this track was being resolved (a Spotify
            // match, a slow voice join). Drop this one track and move on — a
            // skip should never be swallowed, and never take more than the
            // track it was aimed at.
            log.info("skip landed while a track was being prepared", {
              guildId,
              track: track.title,
            });
            s.skipping = false;
            skipFailed = true;
            continue;
          }

          await this.backend.play(guildId, track);
        } catch (e) {
          if (s.stopping || this.sessions.get(guildId) !== s) return;
          s.failStreak += 1;
          log.warn("track could not be played", {
            guildId,
            track: track.title,
            error: String(e).slice(0, 300),
          });
          const message =
            e instanceof SourceError || e instanceof AudioError
              ? e.message
              : isDownloaderFailure(e)
                ? String(e instanceof Error ? e.message : e)
                : `**${track.title}** couldn't be played.`;
          this.announceFailure(guildId, message, rawFailureDetail(e));
          if (s.failStreak >= MAX_CONSECUTIVE_FAILURES) {
            await this.giveUp(guildId);
            return;
          }
          // Keep the advancement lock, but never loop an unavailable track.
          skipFailed = true;
          continue;
        }

        s.failStreak = 0;
        s.playing = true;
        s.paused = false;
        s.queue.setPaused(false);
        log.info("now playing", {
          guildId,
          track: track.title,
          videoId: track.videoId,
          source: track.sourceName ?? track.sourceKind,
          durationMs: track.durationMs,
          duration: track.durationMs ? formatDuration(track.durationMs) : "unknown",
          spotify: track.sourceKind === "spotify",
          last: this.isLastTrack(s),
          why,
        });
        this.announce(guildId, nowPlayingEmbed(track, s, this.isLastTrack(s)));
        return;
      }
    } finally {
      s.advancing = false;
    }
  }

  private scheduleIdleLeave(guildId: string, s: GuildPlayback): void {
    this.cancelLeaveTimer(s);
    if (!s.voiceChannelId) return;
    s.leaveTimer = setTimeout(() => {
      const current = this.sessions.get(guildId);
      if (!current || current.playing || current.queue.nowPlaying()) return;
      this.announce(guildId, {
        color: 0x99aab5,
        title: "👋 Left the voice channel",
        description: "Nothing was played for a while. See you next show!",
      });
      this.teardown(guildId, false);
    }, IDLE_LEAVE_MS);
    s.leaveTimer.unref?.();
  }

  /** Stop everything, close the voice connection and clear the queue. */
  teardown(guildId: string, announceLeft = true): void {
    const s = this.sessions.get(guildId);
    if (!s) return;
    s.stopping = true;
    this.cancelLeaveTimer(s);
    s.queue.clear();
    s.elector.reset(guildId);
    s.playing = false;
    s.paused = false;
    // Leave synchronously (Discord must see the disconnect promptly) …
    this.backend.leave(guildId);
    this.sessions.delete(guildId);
    // … and let shutdown() know there is nothing left to wait on.
    if (announceLeft) {
      this.announce(guildId, {
        color: 0x99aab5,
        title: "👋 Left the voice channel",
        description: "Playback stopped and the queue was cleared.",
      });
    }
  }

  /**
   * Worker shutdown: every guild stops and the voice sockets close before the
   * process exits. The SIGTERM handler awaits this (with a cap) so a redeploy
   * doesn't leave the bot "in" a voice channel.
   */
  async shutdown(): Promise<void> {
    for (const guildId of [...this.sessions.keys()]) this.teardown(guildId, false);
    await this.backend.shutdown();
  }

  // ── voice connection ──────────────────────────────────────────────

  private guild(guildId: string): Guild | null {
    return this.client.guilds?.cache.get(guildId) ?? null;
  }

  private channel(guildId: string): VoiceBasedChannel | null {
    const channelId = this.sessions.get(guildId)?.voiceChannelId;
    if (!channelId) return null;
    const channel = this.client.channels?.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return null;
    return channel;
  }

  /** Join (or stay in) the member's voice channel. */
  async connect(guildId: string, channel: VoiceBasedChannel): Promise<void> {
    const s = this.session(guildId);
    this.cancelLeaveTimer(s);
    if (this.connectedChannelId(guildId) === channel.id && this.backend.isConnected(guildId))
      return;

    s.voiceChannelId = channel.id;
    try {
      await this.backend.join(guildId, channel);
    } catch (error) {
      // The command layer shows SourceError text to the user verbatim.
      throw error instanceof AudioError ? new SourceError(error.message) : error;
    }
  }

  /**
   * Make sure voice is up before a track starts. Called on every track start,
   * so a dropped connection is rebuilt instead of silently swallowing audio.
   */
  private async ensureVoice(guildId: string, s: GuildPlayback): Promise<void> {
    if (this.backend.isConnected(guildId)) return;
    if (!s.voiceChannelId)
      throw new SourceError("I'm not in a voice channel — join one and run the command again.");
    const channel = this.channel(guildId);
    if (!channel)
      throw new SourceError("I lost sight of that voice channel — join one and try again.");
    try {
      await this.backend.join(guildId, channel);
    } catch (error) {
      throw error instanceof AudioError ? new SourceError(error.message) : error;
    }
  }

  // ── public state ──────────────────────────────────────────────────

  /** The voice channel the bot is (or is about to be) in for this guild. */
  connectedChannelId(guildId: string): string | null {
    return (
      this.backend.connectedChannelId(guildId) ?? this.sessions.get(guildId)?.voiceChannelId ?? null
    );
  }

  /** Is anything playing or queued here? */
  isPlayingSomewhere(guildId: string): boolean {
    const s = this.sessions.get(guildId);
    return Boolean(s && (s.playing || s.queue.nowPlaying() || !s.queue.isEmpty));
  }

  setAnnouncementChannel(guildId: string, channelId: string): void {
    this.session(guildId).textChannelId = channelId;
  }

  /** Where now-playing / vote announcements go for this guild. */
  announcementChannelId(guildId: string): string | null {
    return this.sessions.get(guildId)?.textChannelId ?? null;
  }

  /** One line about the audio pipeline — for logs and `/music status`. */
  audioDescription(): string {
    return this.backend.describe();
  }

  /** Can this bot change volume while a track plays? */
  get supportsVolume(): boolean {
    return this.backend.supportsVolume;
  }

  // ── playback controls ─────────────────────────────────────────────

  async enqueue(guildId: string, tracks: Track[]): Promise<{ added: number; dropped: number }> {
    const s = this.session(guildId);
    const { maxQueue } = musicLimits();
    const room = Math.max(0, maxQueue - s.queue.size - (s.queue.nowPlaying() ? 0 : 1));
    const added = s.queue.addMany(tracks, s.queue.size + room);
    const dropped = tracks.length - added;
    return { added, dropped };
  }

  /** Start playback if idle (after enqueue). Returns true when started. */
  async startIfIdle(guildId: string): Promise<boolean> {
    const s = this.session(guildId);
    if (s.playing || s.paused || s.queue.nowPlaying() || s.advancing) return false;
    await this.playNext(guildId, "enqueue");
    return true;
  }

  pause(guildId: string): boolean {
    const s = this.sessions.get(guildId);
    if (!s || !s.playing || s.paused) return false;
    if (!this.backend.pause(guildId, true)) return false;
    s.paused = true;
    s.playing = false;
    s.queue.setPaused(true);
    return true;
  }

  resume(guildId: string): boolean {
    const s = this.sessions.get(guildId);
    if (!s || !s.paused) return false;
    if (!this.backend.pause(guildId, false)) return false;
    s.paused = false;
    s.playing = true;
    s.queue.setPaused(false);
    return true;
  }

  isPaused(guildId: string): boolean {
    return this.sessions.get(guildId)?.paused ?? false;
  }

  /**
   * Force-skip. The vote flow lives in the command handler.
   *
   * Exactly one track is dropped, whether the track is playing, paused, or
   * still being prepared:
   *
   * - **playing/paused** → the backend stops it and answers with a `stopped`
   *   end event, which advances the queue;
   * - **being prepared** (resolving a Spotify match, joining voice) → the
   *   in-flight `playNext` owns the queue here, so the skip waits for it and
   *   `playNext` drops that one track once it is resolved — previously the
   *   skip was swallowed and the track played anyway;
   * - **nothing live** → advance directly.
   */
  skip(guildId: string): boolean {
    const s = this.sessions.get(guildId);
    if (!s || !s.queue.nowPlaying()) return false;
    s.elector.reset(guildId);
    s.skipping = true;
    const playing = s.playing || s.paused;
    this.backend.stop(guildId);
    if (playing) return true;
    if (s.advancing) {
      // A track is on its way in; the skip is handed to it (see the check
      // after `ensureVoice` in playNext).
      return true;
    }
    s.skipping = false;
    void this.playNext(guildId, "skip-no-player", true);
    return true;
  }

  /** Records the volume. Returns false when the pipeline cant apply it. */
  setVolume(guildId: string, percent: number): boolean {
    const s = this.session(guildId);
    s.volume = percent;
    this.backend.setVolume(guildId, percent);
    return this.backend.supportsVolume;
  }

  getVolume(guildId: string): number {
    return this.sessions.get(guildId)?.volume ?? 100;
  }

  queue(guildId: string): MusicQueue {
    return this.session(guildId).queue;
  }

  /** How far into the current track we are (the backend owns the clock). */
  positionMs(guildId: string): number {
    return this.backend.positionMs(guildId);
  }

  // ── skip votes ────────────────────────────────────────────────────

  /** Human member ids currently in the bot's voice channel. */
  listenerIds(guildId: string): string[] {
    const s = this.sessions.get(guildId);
    if (!s?.voiceChannelId) return [];
    const channel = this.client.channels?.cache.get(s.voiceChannelId);
    if (!channel || !channel.isVoiceBased()) return [];
    return [...channel.members.values()].filter((m) => !m.user.bot).map((m) => m.id);
  }

  /** Vote counts needed for /music nowplaying displays. */
  skipStatus(guildId: string): { votes: number; required: number } {
    const s = this.sessions.get(guildId);
    if (!s) return { votes: 0, required: 0 };
    const { voters, required } = s.elector.state(guildId, this.listenerIds(guildId));
    return { votes: voters.length, required };
  }

  /** Can this member force-skip (DJ / staff / requester)? */
  canForceSkip(
    member: GuildMember,
    currentTrack: Track | null,
  ): { allowed: boolean; reason?: ForceSkipReason } {
    return canForceSkip({
      roleNames: member.roles.cache.map((r) => r.name),
      permissions: member.permissions.bitfield.valueOf(),
      isCurrentRequester: Boolean(currentTrack && currentTrack.requestedBy === member.id),
      config: {
        djRoleNames: this.config.djRoleNames,
        staffRoleNames: this.config.staffRoleNames,
      },
    });
  }

  /** Record a skip vote. Returns the election state after the vote. */
  castSkipVote(guildId: string, userId: string) {
    const s = this.session(guildId);
    return s.elector.vote(guildId, userId, this.listenerIds(guildId));
  }

  // ── gateway events (wired from index.ts) ──────────────────────────

  /**
   * Voice states drive two things: the empty-room timer, and noticing that
   * Discord moved the bot somewhere (the connection follows on its own; this
   * keeps our bookkeeping, and `/music play`'s "join me there" check, honest).
   */
  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    if (!guildId) return;
    const s = this.sessions.get(guildId);
    if (!s?.voiceChannelId) return;

    const botId = this.client.user?.id;

    // The bot itself moved or was disconnected.
    if (newState.id === botId) {
      if (!newState.channelId) {
        // Leaving is what we asked for during a teardown; anything else means
        // a human (or Discord) disconnected us.
        if (!s.stopping) {
          log.info("the bot was disconnected from voice", { guildId });
          this.teardown(guildId, false);
        }
        return;
      }
      if (newState.channelId !== s.voiceChannelId) {
        log.info("the bot was moved to another voice channel", {
          guildId,
          from: s.voiceChannelId,
          to: newState.channelId,
        });
        s.voiceChannelId = newState.channelId;
      }
      return;
    }

    // Someone joined/left the bot's channel — watch for an empty room.
    const involved =
      oldState.channelId === s.voiceChannelId || newState.channelId === s.voiceChannelId;
    if (!involved) return;

    const listeners = this.listenerIds(guildId);
    if (listeners.length === 0) {
      if (s.leaveTimer) return; // already scheduled
      this.announce(guildId, {
        color: 0x99aab5,
        title: "🌙 Everyone left",
        description: `Nobody's listening — I'll leave in ${EMPTY_CHANNEL_LEAVE_MS / 1000}s unless someone comes back.`,
      });
      s.leaveTimer = setTimeout(() => this.teardown(guildId, false), EMPTY_CHANNEL_LEAVE_MS);
      s.leaveTimer.unref?.();
    } else if (s.leaveTimer) {
      this.cancelLeaveTimer(s);
    }
  }
}

/**
 * The failure exactly as the downloader (or the runtime) reported it, for
 * `/monarch debug on`. Never shown without that switch.
 */
function rawFailureDetail(error: unknown): string {
  if (error instanceof YtdlpError) {
    return [error.message, error.stderr.trim()].filter(Boolean).join("\n\n");
  }
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error ?? "");
}

// ── embed builders ───────────────────────────────────────────────────

const MUSIC_COLOR = 0xf5c542; // Monarch gold

/** What the "Source" row of the now-playing embed says. */
export function sourceLabel(track: Track): string {
  if (track.sourceKind === "spotify") return "Spotify → YouTube";
  if (track.sourceKind === "youtube") return "YouTube";
  const name = track.sourceName ?? "a direct link";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function nowPlayingEmbed(track: Track, s: GuildPlayback, isLast: boolean): APIEmbed {
  const duration = track.durationMs === null ? "live" : formatDuration(track.durationMs);
  return {
    color: MUSIC_COLOR,
    title: "▶️ Now playing",
    description: `**[${track.title}](${track.url})**\n${track.author} · \`${duration}\` · requested by **${track.requestedByName}**${track.sourceKind === "spotify" ? " · _via Spotify_" : ""}`,
    thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
    footer: {
      text: [
        s.queue.loopMode !== "off" ? `loop: ${s.queue.loopMode}` : null,
        isLast ? "last track in queue" : `${s.queue.size} queued`,
      ]
        .filter(Boolean)
        .join(" · "),
    },
  };
}

export function queueEmbed(
  guild: { name: string },
  snapshot: ReturnType<MusicQueue["snapshot"]>,
  positionMs: number,
  page: number,
  loopMode: string,
  volume: number,
): APIEmbed {
  const perPage = 10;
  const pages = Math.max(1, Math.ceil(snapshot.upcoming.length / perPage));
  const current = Math.min(Math.max(1, page), pages);
  const slice = snapshot.upcoming.slice((current - 1) * perPage, current * perPage);

  const lines = slice.map((t, i) => {
    const pos = (current - 1) * perPage + i + 1;
    return `\`${String(pos).padStart(2, " ")}. \` **[${t.title}](${t.url})** — ${t.requestedByName} · \`${formatDuration(t.durationMs)}\``;
  });

  const nowLine = snapshot.current
    ? `**[${snapshot.current.title}](${snapshot.current.url})** · \`${progressBar(positionMs, snapshot.current.durationMs ?? 0)} \`${positionLabel(positionMs, snapshot.current.durationMs)} · ${snapshot.paused ? "⏸ paused" : "▶️ playing"}`
    : "Nothing playing.";

  const total =
    snapshot.upcomingDurationMs === null ? null : formatDuration(snapshot.upcomingDurationMs);
  return {
    color: MUSIC_COLOR,
    title: `🎵 Queue — ${guild.name}`,
    description: `${nowLine}${snapshot.loopMode !== "off" ? ` · 🔁 ${snapshot.loopMode}` : ""}`,
    fields: [
      {
        name: `Up next — ${snapshot.upcoming.length} track${snapshot.upcoming.length === 1 ? "" : "s"}${total ? ` · ${total}` : ""} · vol ${volume}%`,
        value:
          lines.length > 0
            ? lines.join("\n").slice(0, 1024)
            : "_The queue is empty — add something with `/music play`._",
      },
    ],
    footer:
      pages > 1
        ? { text: `Page ${current}/${pages} — browse with /music queue <page>` }
        : undefined,
  };
}

function positionLabel(positionMs: number, durationMs: number | null): string {
  const at = formatDuration(Math.min(positionMs, durationMs ?? 0) || 0);
  return durationMs === null ? `${at}` : `${at} / ${formatDuration(durationMs)}`;
}

export function nowPlayingDetailed(
  track: Track,
  paused: boolean,
  positionMs: number,
  loopMode: string,
  volume: number,
  skip: { votes: number; required: number },
): APIEmbed {
  const bar = track.durationMs === null ? "" : ` ${progressBar(positionMs, track.durationMs)}`;
  return {
    color: MUSIC_COLOR,
    title: paused ? "⏸ Now playing (paused)" : "▶️ Now playing",
    description: `**[${track.title}](${track.url})**${bar}`,
    fields: [
      { name: "Channel", value: track.author, inline: true },
      { name: "Time", value: positionLabel(positionMs, track.durationMs), inline: true },
      { name: "Source", value: sourceLabel(track), inline: true },
      { name: "Requested by", value: track.requestedByName, inline: true },
      { name: "Loop", value: loopMode, inline: true },
      { name: "Volume", value: `${volume}%`, inline: true },
      {
        name: "Skip votes",
        value:
          skip.required > 0
            ? `${skip.votes}/${skip.required} — DJ, staff and the requester skip instantly`
            : "—",
        inline: false,
      },
    ],
    thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
  };
}
