import {
  MusicQueue,
  SkipElector,
  canForceSkip,
  formatDuration,
  lavalinkVolume,
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
  LavalinkError,
  getLavalink,
  type LavalinkManager,
  type LavalinkNode,
  type TrackEndReason,
} from "./lavalink.js";
import { SourceError, backendFailureMessage, ensurePlayable, musicLimits } from "./sources.js";

/**
 * The voice layer: one Lavalink player per guild, driven by the pure
 * `MusicQueue` from @monarch/music.
 *
 * This process never touches audio. It joins the voice channel on Discord's
 * gateway (op 4), hands the resulting voice credentials to a Lavalink node,
 * and then tells that node what to play. The node owns the UDP socket, the
 * source extraction and the decoding — which is why a song no longer stops
 * early when *this* process hiccups, and why the worker needs no ffmpeg, no
 * Opus encoder and no outbound UDP of its own.
 *
 * The queue rules, skip votes and role policy stay in @monarch/music; this
 * file is the adapter between them and the node's REST/WebSocket protocol.
 */
const log = createLogger("bot.music");

const EMPTY_CHANNEL_LEAVE_MS = 60_000; // alone in voice → leave after this
const IDLE_LEAVE_MS = 5 * 60_000; // nothing playing → leave after this
const MAX_CONSECUTIVE_FAILURES = 3;
/** How long Discord gets to hand out voice credentials after we join. */
const VOICE_HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * If a track ends more than this far before its known length, say so. With a
 * node doing the streaming this should not happen — when it does, the cause is
 * on the node (a throttled source, an old youtube-source plugin), and the
 * announcement points there instead of silently skipping ahead.
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
    const raw = (process.env[name] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return raw.length > 0 ? raw : [...fallback];
  };
  return {
    djRoleNames: list("MUSIC_DJ_ROLE_NAMES", DEFAULT_DJ_ROLE_NAMES),
    staffRoleNames: list("MUSIC_STAFF_ROLE_NAMES", DEFAULT_STAFF_ROLE_NAMES),
  };
}

/** A gateway packet we forward to the node (VOICE_*_UPDATE). */
export interface RawVoicePacket {
  t?: string | null;
  d?: {
    guild_id?: string;
    channel_id?: string | null;
    user_id?: string;
    session_id?: string;
    token?: string;
    endpoint?: string | null;
  } | null;
}

interface GuildPlayback {
  queue: MusicQueue;
  elector: SkipElector;
  /** The node this guild plays through (kept stable for the whole session). */
  node: LavalinkNode | null;
  voiceChannelId: string | null;
  textChannelId: string | null;
  volume: number; // 0–150
  /** Discord voice handshake, collected from the gateway and sent to the node. */
  voiceSessionId: string | null;
  voiceServer: { token: string; endpoint: string } | null;
  /** Signature of the voice payload already on the node, so we don't re-send. */
  voiceSent: string | null;
  voiceWaiters: Array<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
  /** Playback clock, seeded from the node's `playerUpdate` frames. */
  lastPosition: { position: number; time: number } | null;
  playing: boolean;
  paused: boolean;
  skipping: boolean;
  stopping: boolean;
  /** true while we intentionally re-join to follow a channel move or a node restart. */
  following: boolean;
  advancing: boolean;
  failStreak: number;
  leaveTimer: NodeJS.Timeout | null;
}

export class MusicManager {
  private readonly sessions = new Map<string, GuildPlayback>();
  /** Player deletions still in flight; `shutdown()` waits for these. */
  private readonly pendingDestroys = new Set<Promise<void>>();

  constructor(
    private readonly client: Client,
    private readonly announce: Announce,
    private readonly config: MusicManagerConfig = musicManagerConfigFromEnv(),
    private readonly lavalink: LavalinkManager = getLavalink(),
  ) {
    this.wireLavalink();
  }

  // ── session plumbing ──────────────────────────────────────────────

  private session(guildId: string): GuildPlayback {
    const existing = this.sessions.get(guildId);
    if (existing) return existing;

    const s: GuildPlayback = {
      queue: new MusicQueue(),
      elector: new SkipElector(),
      node: null,
      voiceChannelId: null,
      textChannelId: null,
      volume: 100,
      voiceSessionId: null,
      voiceServer: null,
      voiceSent: null,
      voiceWaiters: [],
      lastPosition: null,
      playing: false,
      paused: false,
      skipping: false,
      stopping: false,
      following: false,
      advancing: false,
      failStreak: 0,
      leaveTimer: null,
    };
    this.sessions.set(guildId, s);
    return s;
  }

  /** Route the node's events into this manager. Wired once, in the constructor. */
  private wireLavalink(): void {
    this.lavalink.on("trackStart", ({ guildId, track }) => {
      const s = this.sessions.get(guildId);
      if (!s) return;
      s.playing = true;
      s.paused = false;
      s.lastPosition = { position: track.info.position ?? 0, time: Date.now() };
      log.info("track started on the node", {
        guildId,
        track: track.info.title,
        identifier: track.info.identifier,
        source: track.info.sourceName,
        durationMs: track.info.length,
      });
    });

    this.lavalink.on("trackEnd", ({ guildId, track, reason, node }) => {
      const s = this.sessions.get(guildId);
      if (!s) return; // torn down; a late event is not our business
      s.playing = false;
      const current = s.queue.nowPlaying();
      const userId = (track?.userData as { id?: string } | undefined)?.id;
      // Ignore the tail of a track we already moved on from (a `loadFailed`
      // arriving after the next one started, for example).
      if (current && userId && userId !== current.id) {
        log.info("ignoring a stale track end", { guildId, reason, stale: userId, current: current.id });
        return;
      }
      log.info("track ended", { guildId, node: node.name, reason, track: track?.info?.title ?? current?.title ?? null });
      void this.onTrackEnd(guildId, s, reason);
    });

    this.lavalink.on("trackException", ({ guildId, track, exception }) => {
      const s = this.sessions.get(guildId);
      if (!s) return;
      log.warn("track exception on the node", {
        guildId,
        track: track?.info?.title ?? s.queue.nowPlaying()?.title,
        severity: exception?.severity,
        message: exception?.message?.slice(0, 300),
        cause: exception?.cause?.slice(0, 300),
      });
      // The node follows an exception with TrackEndEvent(loadFailed), which is
      // where the queue advances — announcing here, advancing there, keeps it
      // to exactly one skip.
      const message = exception?.message?.trim();
      this.announceFailure(
        guildId,
        message && message.length > 0
          ? `**${track?.info?.title ?? s.queue.nowPlaying()?.title ?? "That track"}** couldn't be played: ${message}`
          : "That track couldn't be played (the node reported an error).",
      );
    });

    this.lavalink.on("trackStuck", ({ guildId, track, thresholdMs }) => {
      const s = this.sessions.get(guildId);
      if (!s) return;
      log.warn("track stuck on the node", { guildId, track: track?.info?.title ?? null, thresholdMs });
      // Stuck means no frames are going out: the node ends the track too, but
      // don't leave a silent voice channel waiting on that — advance now.
      this.announceFailure(guildId, "Playback stalled (the node stopped sending audio) — skipping ahead.");
      s.skipping = true;
      void this.playNext(guildId, "stuck");
    });

    this.lavalink.on("playerUpdate", ({ guildId, state }) => {
      const s = this.sessions.get(guildId);
      if (!s) return;
      s.lastPosition = { position: state.position, time: state.time || Date.now() };
      if (state.connected === false && s.playing) {
        log.warn("node reports the voice connection is down", { guildId, position: state.position });
      }
    });

    this.lavalink.on("voiceSocketClosed", ({ guildId, code, reason, byRemote }) => {
      const s = this.sessions.get(guildId);
      log.warn("node lost the Discord voice socket", { guildId, code, reason, byRemote });
      if (!s || s.stopping || s.following) return;
      // Mid-rebuild (a channel move, a node restart) the old voice socket is
      // *supposed* to die: `voiceSent` is null until the new handshake lands.
      if (!s.voiceSent) return;
      if (code === 4014 && byRemote) {
        // Disconnected by a human, or the channel went away.
        log.info("the node was disconnected from voice", { guildId, code, reason });
        this.teardown(guildId, false);
        return;
      }
      if (code === 4006 || code === 4007 || code === 4009) {
        // Session invalid / expired handshake: join again and resume where we were.
        void this.rehandshake(guildId, `voice socket closed (${code})`);
      }
    });

    this.lavalink.on("nodeDisconnect", ({ node }) => {
      log.warn("lavalink node disconnected", { node: node.name, guilds: node.assignedGuilds.size });
    });

    this.lavalink.on("nodeReconnect", ({ node, resumed }) => {
      log.info("lavalink node reconnected", { node: node.name, resumed, guilds: node.assignedGuilds.size });
      if (resumed) return; // the node kept our players; nothing to rebuild
      // A fresh session means every player on it is gone: rebuild them, or the
      // guilds on that node sit in a silent voice channel forever.
      for (const guildId of [...this.sessions.keys()]) {
        const s = this.sessions.get(guildId);
        if (!s || s.stopping || s.node?.name !== node.name) continue;
        void this.recover(guildId, node);
      }
    });

    this.lavalink.on("nodeError", ({ node, error }) => {
      log.warn("lavalink node error", { node: node.name, error: String(error).slice(0, 300) });
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

  private announceFailure(guildId: string, reason: string): void {
    this.announce(guildId, {
      color: 0xed4245,
      title: "⚠️ Track failed",
      description: reason,
    });
  }

  // ── track endings ──────────────────────────────────────────────────

  /**
   * One place decides what a track ending means. Lavalink's `reason` is the
   * whole story: `finished` and `loadFailed` move the queue on, `stopped` is
   * ours (a skip or a teardown), `replaced`/`cleanup` are bookkeeping.
   */
  private async onTrackEnd(guildId: string, s: GuildPlayback, reason: TrackEndReason): Promise<void> {
    const wasSkipping = s.skipping;
    s.skipping = false;

    if (reason === "replaced" || reason === "cleanup") return;
    if (reason === "stopped") {
      if (!wasSkipping) return; // teardown or a node rebuild already owns this
      await this.playNext(guildId, "skipped");
      return;
    }

    const finishedTrack = s.queue.nowPlaying();
    const elapsed = this.positionMs(guildId);
    const expected = finishedTrack?.durationMs ?? null;

    if (reason === "loadFailed") {
      s.failStreak += 1;
      this.announceFailure(
        guildId,
        `**${finishedTrack?.title ?? "That track"}** couldn't be loaded by the music node — skipping ahead.`,
      );
      if (s.failStreak >= MAX_CONSECUTIVE_FAILURES) {
        this.announce(guildId, {
          color: 0xed4245,
          title: "⏹ Giving up",
          description: `${MAX_CONSECUTIVE_FAILURES} tracks in a row failed. Use \`/music play\` to start again.`,
        });
        this.teardown(guildId, false);
        return;
      }
      await this.playNext(guildId, "load-failed");
      return;
    }

    // `finished`.
    const wasPremature = expected !== null && elapsed > 0 && elapsed + PREMATURE_EARLY_MS < expected;
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
          reason,
        });
        this.announce(guildId, {
          color: 0xed4245,
          title: "⚠️ Track cut short",
          description:
            `**${finishedTrack.title}** stopped at \`${formatDuration(elapsed)}\` but should be \`${formatDuration(expected)}\`.\n` +
            "The audio node reported the track as finished, so this is on its side: update the node and its " +
            "youtube-source plugin, or enable IP rotation / a YouTube cookie in its `application.yml`. Skipping ahead.",
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

    await this.playNext(guildId, wasSkipping ? "skipped" : "finished");
  }

  // ── playback ───────────────────────────────────────────────────────

  /**
   * Pull the next track and hand it to the node. `why` only feeds the logs.
   * When the queue runs dry the bot stays connected for a few minutes
   * (IDLE_LEAVE_MS) in case someone queues more, then leaves.
   */
  private async playNext(guildId: string, why: string): Promise<void> {
    const s = this.session(guildId);
    if (s.advancing || s.stopping) return;
    s.advancing = true;
    try {
      let skipFailed = false;
      while (!s.stopping) {
        const track = s.queue.next(skipFailed);
        s.elector.reset(guildId);
        if (!track) {
          s.playing = false;
          s.paused = false;
          s.queue.setPaused(false);
          s.lastPosition = null;
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
          await this.lavalink.whenReady(VOICE_HANDSHAKE_TIMEOUT_MS);
          await this.ensureVoice(guildId, s);
          if (s.stopping || this.sessions.get(guildId) !== s) return;

          s.node = this.lavalink.nodeOf(guildId) ?? s.node;
          await this.lavalink.play(guildId, track.encoded!, {
            volume: lavalinkVolume(s.volume),
            userData: { id: track.id, requestedBy: track.requestedBy },
          });
        } catch (e) {
          if (s.stopping || this.sessions.get(guildId) !== s) return;
          s.failStreak += 1;
          log.warn("track could not be handed to the node", { guildId, track: track.title, error: String(e) });
          const message =
            e instanceof SourceError
              ? e.message
              : e instanceof LavalinkError
                ? backendFailureMessage(e)
                : `**${track.title}** couldn't be played.`;
          this.announceFailure(guildId, message);
          if (s.failStreak >= MAX_CONSECUTIVE_FAILURES) {
            this.announce(guildId, {
              color: 0xed4245,
              title: "⏹ Giving up",
              description: `${MAX_CONSECUTIVE_FAILURES} tracks in a row failed. Use \`/music play\` to start again.`,
            });
            this.teardown(guildId, false);
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
        s.lastPosition = { position: 0, time: Date.now() };
        log.info("now playing", {
          guildId,
          track: track.title,
          videoId: track.videoId,
          source: track.sourceName ?? track.sourceKind,
          node: s.node?.name,
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

  /** Stop everything, free the node's player and disconnect. Announces unless `silent`. */
  teardown(guildId: string, announceLeft = true): void {
    const s = this.sessions.get(guildId);
    if (!s) return;
    s.stopping = true;
    this.cancelLeaveTimer(s);
    this.rejectVoiceWaiters(s, new SourceError("Playback was stopped."));
    s.queue.clear();
    s.elector.reset(guildId);
    s.playing = false;
    s.paused = false;
    // A /music stop must not block on the node, so this is fire-and-forget —
    // but it is *tracked*: shutdown() waits for the deletes to leave the
    // process before the worker exits (see below).
    const destroy = this.lavalink.destroyPlayer(guildId).catch(() => undefined);
    this.pendingDestroys.add(destroy);
    void destroy.finally(() => this.pendingDestroys.delete(destroy));
    const guild = this.guild(guildId);
    if (guild && !s.following) this.sendVoiceState(guild, null); // leave the channel on Discord
    this.sessions.delete(guildId);
    if (announceLeft) {
      this.announce(guildId, {
        color: 0x99aab5,
        title: "👋 Left the voice channel",
        description: "Playback stopped and the queue was cleared.",
      });
    }
  }

  /**
   * Worker shutdown: every guild stops, the node drops their players, and only
   * then do the node sockets close. The SIGTERM handler awaits this (with a
   * cap) because `process.exit()` right after `teardown()` would cut the REST
   * deletes and the op-4 "leave voice" frames off mid-flight, leaving a player
   * on the node per guild.
   */
  async shutdown(): Promise<void> {
    for (const guildId of [...this.sessions.keys()]) this.teardown(guildId, false);
    await Promise.allSettled([...this.pendingDestroys]);
    this.lavalink.stop();
  }

  // ── voice connection ──────────────────────────────────────────────

  private guild(guildId: string): Guild | null {
    return this.client.guilds?.cache.get(guildId) ?? null;
  }

  /**
   * Join (or move to) a voice channel the Discord way — op 4 on the guild's
   * shard. The node then gets the credentials Discord answers with; this
   * process never opens a voice socket of its own.
   */
  private sendVoiceState(guild: Guild, channelId: string | null): void {
    try {
      guild.shard?.send({
        op: 4,
        d: { guild_id: guild.id, channel_id: channelId, self_mute: false, self_deaf: true },
      });
    } catch (error) {
      log.error("could not send the voice state update", { guildId: guild.id, channelId, error: String(error) });
    }
  }

  /** Join (or stay joined to) the member's voice channel, node-ready. */
  async connect(guildId: string, channel: VoiceBasedChannel): Promise<void> {
    const s = this.session(guildId);
    this.cancelLeaveTimer(s);
    this.lavalink.start(this.client.user?.id ?? process.env.LAVALINK_USER_ID ?? "");

    const guild = channel.guild ?? this.guild(guildId);
    if (!guild) throw new SourceError("I can't see that server's gateway connection — try again in a moment.");

    const moving = s.voiceChannelId !== null && s.voiceChannelId !== channel.id;
    const alreadyJoined = !moving && s.voiceChannelId === channel.id && s.voiceSent !== null;
    s.voiceChannelId = channel.id;
    if (alreadyJoined) return;

    if (moving) {
      // A channel move voids the voice credentials the node is holding: get
      // fresh ones and put the current track back where it was.
      await this.rehandshake(guildId, "channel move");
      return;
    }

    this.sendVoiceState(guild, channel.id);
    await this.waitForVoice(guildId, s);
  }

  /**
   * Redo Discord's voice handshake and put the current track back where it was.
   *
   * One path for the three things that invalidate a voice connection: the bot
   * was moved to another channel, Discord closed the node's voice socket with a
   * dead-session code (4006/4007/4009), or the node restarted without resuming
   * our session. In every case the answer is the same — join again on the
   * gateway, hand the node the fresh credentials, and resume at the last known
   * position instead of starting the song over. The player on the node is left
   * alone on purpose: destroying it first would race the credentials we are
   * about to send it.
   */
  private async rehandshake(guildId: string, why: string): Promise<void> {
    const s = this.sessions.get(guildId);
    if (!s || s.stopping || !s.voiceChannelId) return;
    const guild = this.guild(guildId);
    if (!guild) return;

    const resumeAt = this.positionMs(guildId);
    const current = s.queue.nowPlaying();
    log.info("re-handshaking voice", {
      guildId,
      why,
      channelId: s.voiceChannelId,
      track: current?.title ?? null,
      resumeAtMs: Math.round(resumeAt),
    });

    // Cleared before anything awaits: the old token is void, and the node's
    // voice socket dying while we do this is expected (see voiceSocketClosed).
    s.following = true;
    s.voiceServer = null;
    s.voiceSent = null;
    this.sendVoiceState(guild, s.voiceChannelId);
    try {
      await this.waitForVoice(guildId, s);
      if (s.stopping) return;
      if (current?.encoded) await this.resumeTrack(guildId, s, current, resumeAt);
    } catch (error) {
      log.warn("voice re-handshake failed", { guildId, why, error: String(error).slice(0, 300) });
      this.announceFailure(
        guildId,
        error instanceof Error ? error.message : "The voice connection dropped and couldn't be re-established.",
      );
      this.teardown(guildId, false);
    } finally {
      s.following = false;
    }
  }

  /** Rebuild a guild's player after its node came back without resuming. */
  private async recover(guildId: string, node: LavalinkNode): Promise<void> {
    const s = this.sessions.get(guildId);
    if (!s || s.stopping) return;
    log.warn("node session was lost — rebuilding the player", {
      guildId,
      node: node.name,
      track: s.queue.nowPlaying()?.title ?? null,
      resumeAtMs: Math.round(this.positionMs(guildId)),
    });
    this.announce(guildId, {
      color: 0x99aab5,
      title: "🔁 Music node restarted",
      description: s.queue.nowPlaying()
        ? `Reconnecting — **${s.queue.nowPlaying()!.title}** picks back up where it left off.`
        : "Reconnecting to the voice channel.",
    });
    s.node = node;
    await this.rehandshake(guildId, "node session lost");
  }

  /** Put a track back on at `positionMs` (used after a move / node restart). */
  private async resumeTrack(guildId: string, s: GuildPlayback, track: Track, positionMs: number): Promise<void> {
    const position = Math.max(0, Math.round(positionMs));
    await this.lavalink.updatePlayer(guildId, {
      track: { encoded: track.encoded!, userData: { id: track.id, requestedBy: track.requestedBy } },
      position: track.durationMs !== null && position >= track.durationMs ? 0 : position,
      volume: lavalinkVolume(s.volume),
      paused: s.paused,
    });
    s.playing = !s.paused;
    s.lastPosition = { position, time: Date.now() };
    log.info("resumed a track after a voice rebuild", { guildId, track: track.title, positionMs: position });
  }

  /**
   * Wait until Discord's voice credentials have reached the node. Resolves
   * immediately when they're already there.
   */
  private waitForVoice(guildId: string, s: GuildPlayback): Promise<void> {
    if (s.voiceSent && s.voiceSessionId && s.voiceServer) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        s.voiceWaiters = s.voiceWaiters.filter((w) => w.timer !== timer);
        reject(
          new SourceError(
            "Discord didn't hand out voice credentials in time — I can join the channel but not talk in it. " +
              "Check the bot's Connect/Speak permissions, then try again.",
          ),
        );
      }, VOICE_HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
      s.voiceWaiters.push({ resolve, reject, timer });
      // Credentials may already be complete but unsent (a node rebuild).
      void this.flushVoice(guildId, s);
    });
  }

  /** Send the collected handshake to the node once it's complete. */
  private async flushVoice(guildId: string, s: GuildPlayback): Promise<void> {
    if (!s.voiceSessionId || !s.voiceServer || !s.voiceChannelId) return;
    const signature = `${s.voiceSessionId}|${s.voiceServer.token}|${s.voiceServer.endpoint}`;
    if (s.voiceSent === signature) {
      this.resolveVoiceWaiters(s);
      return;
    }
    try {
      await this.lavalink.updateVoice(guildId, {
        token: s.voiceServer.token,
        endpoint: s.voiceServer.endpoint,
        sessionId: s.voiceSessionId,
        channelId: s.voiceChannelId,
      });
      s.voiceSent = signature;
      s.node = this.lavalink.nodeOf(guildId) ?? s.node;
      log.info("voice credentials handed to the node", {
        guildId,
        node: s.node?.name,
        channelId: s.voiceChannelId,
        endpoint: s.voiceServer.endpoint,
      });
      this.resolveVoiceWaiters(s);
    } catch (error) {
      s.voiceSent = null;
      log.error("could not hand voice credentials to the node", { guildId, error: String(error).slice(0, 300) });
      this.rejectVoiceWaiters(
        s,
        new SourceError(
          error instanceof LavalinkError ? backendFailureMessage(error) : "The music node refused the voice connection.",
        ),
      );
    }
  }

  private resolveVoiceWaiters(s: GuildPlayback): void {
    const waiters = s.voiceWaiters;
    s.voiceWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectVoiceWaiters(s: GuildPlayback, error: Error): void {
    const waiters = s.voiceWaiters;
    s.voiceWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  /**
   * Make sure the node has a voice connection before we ask it to play.
   * Called on every track start so a lost handshake is rebuilt, not ignored.
   */
  private async ensureVoice(guildId: string, s: GuildPlayback): Promise<void> {
    if (s.voiceSent && s.voiceSessionId && s.voiceServer) return;
    if (!s.voiceChannelId) throw new SourceError("I'm not in a voice channel — join one and run the command again.");
    const guild = this.guild(guildId);
    if (!guild) throw new SourceError("I lost sight of that server — try again in a moment.");
    this.sendVoiceState(guild, s.voiceChannelId);
    await this.waitForVoice(guildId, s);
  }

  // ── public state ──────────────────────────────────────────────────

  /** The voice channel the bot is (or is about to be) in for this guild. */
  connectedChannelId(guildId: string): string | null {
    return this.sessions.get(guildId)?.voiceChannelId ?? null;
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

  /** Which node a guild is playing through — for logs and diagnostics. */
  nodeName(guildId: string): string | null {
    return this.sessions.get(guildId)?.node?.name ?? null;
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
    s.paused = true;
    s.playing = false;
    s.queue.setPaused(true);
    void this.lavalink.pause(guildId, true).catch((error) => this.controlFailed(guildId, "pause", error));
    return true;
  }

  resume(guildId: string): boolean {
    const s = this.sessions.get(guildId);
    if (!s || !s.paused) return false;
    s.paused = false;
    s.playing = true;
    s.queue.setPaused(false);
    void this.lavalink.pause(guildId, false).catch((error) => this.controlFailed(guildId, "resume", error));
    return true;
  }

  isPaused(guildId: string): boolean {
    return this.sessions.get(guildId)?.paused ?? false;
  }

  /** Force-skip. The vote flow lives in the command handler. */
  skip(guildId: string): boolean {
    const s = this.sessions.get(guildId);
    if (!s || !s.queue.nowPlaying()) return false;
    s.elector.reset(guildId);
    s.skipping = true;
    // The node answers with TrackEndEvent(stopped), which advances the queue.
    void this.lavalink.stopTrack(guildId).catch(async (error) => {
      log.warn("skip did not reach the node", { guildId, error: String(error).slice(0, 300) });
      const session = this.sessions.get(guildId);
      if (!session) return;
      session.skipping = false;
      await this.playNext(guildId, "skip-after-error");
    });
    return true;
  }

  setVolume(guildId: string, percent: number): void {
    const s = this.session(guildId);
    s.volume = percent;
    // Applied live to whatever the node is playing.
    void this.lavalink.setVolume(guildId, lavalinkVolume(percent)).catch((error) => this.controlFailed(guildId, "volume", error));
  }

  getVolume(guildId: string): number {
    return this.sessions.get(guildId)?.volume ?? 100;
  }

  queue(guildId: string): MusicQueue {
    return this.session(guildId).queue;
  }

  /** How far into the current track we are, from the node's own clock. */
  positionMs(guildId: string): number {
    const s = this.sessions.get(guildId);
    if (!s) return 0;
    const base = s.lastPosition?.position ?? 0;
    if (!s.lastPosition || s.paused || !s.playing) return base;
    return base + Math.max(0, Date.now() - s.lastPosition.time);
  }

  private controlFailed(guildId: string, what: string, error: unknown): void {
    log.warn("playback control did not reach the node", { guildId, what, error: String(error).slice(0, 300) });
    this.announceFailure(
      guildId,
      error instanceof LavalinkError ? backendFailureMessage(error) : `The music node didn't accept the ${what} command.`,
    );
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
  canForceSkip(member: GuildMember, currentTrack: Track | null): { allowed: boolean; reason?: ForceSkipReason } {
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
   * Raw gateway packets carry the two things Lavalink needs and discord.js
   * doesn't expose as events: our voice `session_id` and the voice server's
   * `token`/`endpoint`. Everything else about voice states comes through the
   * typed handler below.
   */
  handleRawPacket(packet: RawVoicePacket): void {
    const type = packet?.t;
    const data = packet?.d;
    if (!type || !data?.guild_id) return;
    const guildId = data.guild_id;

    if (type === "VOICE_STATE_UPDATE") {
      // Only *our* voice state carries the session id the node authenticates with.
      const botId = this.client.user?.id ?? process.env.LAVALINK_USER_ID;
      if (botId && data.user_id && data.user_id !== botId) return;
      const s = this.sessions.get(guildId);
      if (!s || s.stopping) return;
      if (data.session_id) s.voiceSessionId = data.session_id;
      if (data.channel_id && data.channel_id !== s.voiceChannelId) s.voiceChannelId = data.channel_id;
      void this.flushVoice(guildId, s);
      return;
    }

    if (type === "VOICE_SERVER_UPDATE") {
      const s = this.sessions.get(guildId);
      if (!s || s.stopping || !data.token || !data.endpoint) return;
      s.voiceServer = { token: data.token, endpoint: data.endpoint };
      void this.flushVoice(guildId, s);
    }
  }

  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    if (!guildId) return;
    const s = this.sessions.get(guildId);
    if (!s?.voiceChannelId) return;

    const botId = this.client.user?.id;

    // The bot itself moved or was disconnected.
    if (newState.id === botId) {
      if (!newState.channelId) {
        if (!s.stopping && !s.following) {
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
        s.voiceChannelId = newState.channelId; // follow the move
        s.voiceServer = null; // fresh credentials are on their way
        s.voiceSent = null; // …and the old voice socket dying is expected
      }
      return;
    }

    // Someone joined/left the bot's channel — watch for an empty room.
    const involved = oldState.channelId === s.voiceChannelId || newState.channelId === s.voiceChannelId;
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

// ── embed builders ───────────────────────────────────────────────────

const MUSIC_COLOR = 0xf5c542; // Monarch gold

/** What the "Source" row of the now-playing embed says. */
export function sourceLabel(track: Track): string {
  if (track.sourceKind === "spotify") return "Spotify → YouTube";
  if (track.sourceKind === "youtube") return "YouTube";
  const name = track.sourceName ?? "the music node";
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

  const total = snapshot.upcomingDurationMs === null ? null : formatDuration(snapshot.upcomingDurationMs);
  return {
    color: MUSIC_COLOR,
    title: `🎵 Queue — ${guild.name}`,
    description: `${nowLine}${snapshot.loopMode !== "off" ? ` · 🔁 ${snapshot.loopMode}` : ""}`,
    fields: [
      {
        name: `Up next — ${snapshot.upcoming.length} track${snapshot.upcoming.length === 1 ? "" : "s"}${total ? ` · ${total}` : ""} · vol ${volume}%`,
        value: lines.length > 0 ? lines.join("\n").slice(0, 1024) : "_The queue is empty — add something with `/music play`._",
      },
    ],
    footer: pages > 1 ? { text: `Page ${current}/${pages} — browse with /music queue <page>` } : undefined,
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
      { name: "Skip votes", value: skip.required > 0 ? `${skip.votes}/${skip.required} — DJ, staff and the requester skip instantly` : "—", inline: false },
    ],
    thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
  };
}
