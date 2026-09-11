import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  MusicQueue,
  SkipElector,
  canForceSkip,
  formatDuration,
  progressBar,
  volumeToGain,
  DEFAULT_DJ_ROLE_NAMES,
  DEFAULT_STAFF_ROLE_NAMES,
  type ForceSkipReason,
  type Track,
} from "@monarch/music";
import { createLogger } from "@monarch/shared";
import type {
  APIEmbed,
  Client,
  GuildMember,
  VoiceBasedChannel,
  VoiceState,
} from "discord.js";
import { resolveFfmpeg } from "./ffmpeg.js";
import { audioStreamFor, musicLimits } from "./sources.js";
import { SourceError } from "./sources.js";

/**
 * The voice layer: one AudioPlayer + VoiceConnection per guild, driven by
 * the pure `MusicQueue` from @monarch/music. Everything Discord-voice-y
 * lives here — the queue rules, skip votes and role policy do not.
 */
const log = createLogger("bot.music");

const EMPTY_CHANNEL_LEAVE_MS = 60_000; // alone in voice → leave after this
const IDLE_LEAVE_MS = 5 * 60_000; // nothing playing → leave after this
const MAX_CONSECUTIVE_FAILURES = 3;

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

interface GuildPlayback {
  queue: MusicQueue;
  elector: SkipElector;
  player: AudioPlayer;
  connection: VoiceConnection | null;
  voiceChannelId: string | null;
  textChannelId: string | null;
  volume: number; // 0–150
  startedAt: number | null;
  pausedElapsed: number;
  skipping: boolean;
  stopping: boolean;
  /** true while we intentionally destroy a connection to follow a channel move. */
  following: boolean;
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
  ) {
    resolveFfmpeg(); // fail fast on missing ffmpeg, before the first play
  }

  // ── session plumbing ──────────────────────────────────────────────

  private session(guildId: string): GuildPlayback {
    let s = this.sessions.get(guildId);
    if (s) return s;

    const player = createAudioPlayer();
    s = {
      queue: new MusicQueue(),
      elector: new SkipElector(),
      player,
      connection: null,
      voiceChannelId: null,
      textChannelId: null,
      volume: 100,
      startedAt: null,
      pausedElapsed: 0,
      skipping: false,
      stopping: false,
      following: false,
      advancing: false,
      failStreak: 0,
      leaveTimer: null,
    };
    this.sessions.set(guildId, s);

    player.on(AudioPlayerStatus.Idle, () => {
      if (s!.stopping) return; // stop() handles teardown
      s!.skipping = false;
      void this.playNext(guildId, "finished");
    });
    player.on(AudioPlayerStatus.Playing, () => {
      if (s!.startedAt === null) s!.startedAt = Date.now();
    });
    player.on("error", (e) => {
      log.error("audio player error", { guildId, error: String(e) });
      // The stream died mid-play. Don't advance here — the player also
      // transitions to Idle on error, and that handler advances exactly once.
      this.announceFailure(guildId, "Playback failed mid-track — skipping ahead.");
    });

    return s;
  }

  private cancelLeaveTimer(s: GuildPlayback): void {
    if (s.leaveTimer) {
      clearTimeout(s.leaveTimer);
      s.leaveTimer = null;
    }
  }

  /** True when this is the last track (queue empty and nothing upcoming). */
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

  /**
   * Pull the next track and play it. `why` only feeds the logs.
   * When the queue runs dry the bot stays connected for a few minutes
   * (IDLE_LEAVE_MS) in case someone queues more, then leaves.
   */
  private async playNext(guildId: string, why: string): Promise<void> {
    const s = this.session(guildId);
    if (s.advancing || s.stopping) return;
    s.advancing = true;
    try {
      const track = s.queue.next();
      s.elector.reset(guildId);
      if (!track) {
        s.queue.setPaused(false);
        s.startedAt = null;
        s.pausedElapsed = 0;
        this.scheduleIdleLeave(guildId, s);
        return;
      }
      this.cancelLeaveTimer(s);

      let resource: AudioResource;
      try {
        const stream = await audioStreamFor(track);
        resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      } catch (e) {
        s.failStreak += 1;
        log.warn("track resolution failed", { guildId, track: track.title, error: String(e) });
        const message =
          e instanceof SourceError
            ? e.message
            : `**${track.title}** couldn't be played (stream unavailable).`;
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
        // Try the next one (recursion is bounded by the fail streak).
        return void this.playNext(guildId, `${why}→skip-failed`);
      }

      s.failStreak = 0;
      s.queue.setPaused(false);
      s.startedAt = null;
      s.pausedElapsed = 0;
      resource.volume?.setVolume(volumeToGain(s.volume));
      s.player.play(resource);
      log.info("now playing", {
        guildId,
        track: track.title,
        spotify: track.sourceKind === "spotify",
        last: this.isLastTrack(s),
      });
      this.announce(guildId, nowPlayingEmbed(track, s, this.isLastTrack(s)));
    } finally {
      s.advancing = false;
    }
  }

  private scheduleIdleLeave(guildId: string, s: GuildPlayback): void {
    this.cancelLeaveTimer(s);
    if (!s.connection) return;
    const hadQueue = true;
    s.leaveTimer = setTimeout(() => {
      const current = this.sessions.get(guildId);
      if (!current || current.player.state.status !== AudioPlayerStatus.Idle) return;
      this.announce(guildId, {
        color: 0x99aab5,
        title: "👋 Left the voice channel",
        description: "Nothing was played for a while. See you next show!",
      });
      this.teardown(guildId, false);
    }, IDLE_LEAVE_MS);
    void hadQueue;
  }

  /** Stop everything and disconnect. Announces unless `silent`. */
  teardown(guildId: string, announceLeft = true): void {
    const s = this.sessions.get(guildId);
    if (!s) return;
    s.stopping = true;
    this.cancelLeaveTimer(s);
    s.queue.clear();
    s.elector.reset(guildId);
    try {
      s.player.stop(true);
    } catch {
      // already stopped
    }
    try {
      s.connection?.destroy();
    } catch {
      // already destroyed
    }
    this.sessions.delete(guildId);
    if (announceLeft) {
      this.announce(guildId, {
        color: 0x99aab5,
        title: "👋 Left the voice channel",
        description: "Playback stopped and the queue was cleared.",
      });
    }
  }

  // ── voice connection ──────────────────────────────────────────────

  /** Join (or stay joined to) the member's voice channel. */
  async connect(guildId: string, channel: VoiceBasedChannel): Promise<void> {
    const s = this.session(guildId);
    this.cancelLeaveTimer(s);
    s.voiceChannelId = channel.id;

    if (s.connection && s.connection.joinConfig.channelId === channel.id) return;

    if (s.connection) {
      // Moving to another channel: destroy quietly first. Destroyed fires
      // synchronously inside destroy(), so the flag reliably guards it.
      s.following = true;
      try {
        s.connection.destroy();
      } finally {
        s.following = false;
      }
      s.connection = null;
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    s.connection = connection;
    connection.subscribe(s.player);
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      // Discord kicked the bot or the channel was deleted — unless we're
      // mid-move (following) or mid-teardown (session already gone).
      if (s.following) return;
      if (this.sessions.get(guildId) === s) this.teardown(guildId, false);
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  }

  connectedChannelId(guildId: string): string | null {
    return this.sessions.get(guildId)?.voiceChannelId ?? null;
  }

  isPlayingSomewhere(guildId: string): boolean {
    const s = this.sessions.get(guildId);
    return Boolean(s && (s.player.state.status !== AudioPlayerStatus.Idle || !s.queue.isEmpty));
  }

  setAnnouncementChannel(guildId: string, channelId: string): void {
    this.session(guildId).textChannelId = channelId;
  }

  /** Where now-playing / vote announcements go for this guild. */
  announcementChannelId(guildId: string): string | null {
    return this.sessions.get(guildId)?.textChannelId ?? null;
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
    if (s.player.state.status !== AudioPlayerStatus.Idle) return false;
    await this.playNext(guildId, "enqueue");
    return true;
  }

  pause(guildId: string): boolean {
    const s = this.sessions.get(guildId);
    if (!s || s.player.state.status !== AudioPlayerStatus.Playing) return false;
    if (s.startedAt !== null) s.pausedElapsed += Date.now() - s.startedAt;
    s.startedAt = null;
    s.queue.setPaused(true);
    return s.player.pause(true);
  }

  resume(guildId: string): boolean {
    const s = this.sessions.get(guildId);
    if (!s || s.player.state.status !== AudioPlayerStatus.Paused) return false;
    s.startedAt = Date.now();
    s.queue.setPaused(false);
    return s.player.unpause();
  }

  isPaused(guildId: string): boolean {
    return this.sessions.get(guildId)?.player.state.status === AudioPlayerStatus.Paused;
  }

  /** Force-skip. Vote flow lives in the command handler. */
  skip(guildId: string): boolean {
    const s = this.sessions.get(guildId);
    if (!s || s.player.state.status === AudioPlayerStatus.Idle) return false;
    s.elector.reset(guildId);
    s.skipping = true;
    s.player.stop(true); // Idle handler advances the queue
    return true;
  }

  setVolume(guildId: string, percent: number): void {
    const s = this.session(guildId);
    s.volume = percent;
    // Apply live to whatever is playing.
    const resource = (s.player.state as { resource?: AudioResource }).resource;
    resource?.volume?.setVolume(volumeToGain(percent));
  }

  getVolume(guildId: string): number {
    return this.sessions.get(guildId)?.volume ?? 100;
  }

  queue(guildId: string): MusicQueue {
    return this.session(guildId).queue;
  }

  /** How far into the current track we are (best-effort, ms). */
  positionMs(guildId: string): number {
    const s = this.sessions.get(guildId);
    if (!s) return 0;
    const base = s.pausedElapsed;
    return s.startedAt === null ? base : base + (Date.now() - s.startedAt);
  }

  // ── skip votes ────────────────────────────────────────────────────

  /** Human member ids currently in the bot's voice channel. */
  listenerIds(guildId: string): string[] {
    const s = this.sessions.get(guildId);
    if (!s?.voiceChannelId) return [];
    const channel = this.client.channels.cache.get(s.voiceChannelId);
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

  // ── voice state updates (wired from index.ts) ─────────────────────

  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    if (!guildId) return;
    const s = this.sessions.get(guildId);
    if (!s?.voiceChannelId) return;

    const botId = this.client.user?.id;

    // The bot itself moved or was disconnected.
    if (newState.id === botId) {
      if (newState.channelId && newState.channelId !== s.voiceChannelId) {
        s.voiceChannelId = newState.channelId; // follow the move
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
    } else if (s.leaveTimer) {
      this.cancelLeaveTimer(s);
    }
  }
}

// ── embed builders ───────────────────────────────────────────────────

const MUSIC_COLOR = 0xf5c542; // Monarch gold

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
    return `\`${String(pos).padStart(2, " ")}.\` **[${t.title}](${t.url})** — ${t.requestedByName} · \`${formatDuration(t.durationMs)}\``;
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
      { name: "Source", value: track.sourceKind === "spotify" ? "Spotify → YouTube" : "YouTube", inline: true },
      { name: "Requested by", value: track.requestedByName, inline: true },
      { name: "Loop", value: loopMode, inline: true },
      { name: "Volume", value: `${volume}%`, inline: true },
      { name: "Skip votes", value: skip.required > 0 ? `${skip.votes}/${skip.required} — DJ, staff and the requester skip instantly` : "—", inline: false },
    ],
    thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
  };
}
