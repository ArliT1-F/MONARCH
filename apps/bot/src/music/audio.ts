import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from "@discordjs/voice";
import { createLogger } from "@monarch/shared";
import { volumeGain, type Track } from "@monarch/music";
import { YtdlpError, explainYtdlpFailure, openAudioPipe, stderrTail } from "./ytdlp.js";

/**
 * The voice backend — what a Lavalink node used to do for us, in this process.
 *
 *   yt-dlp  →  ffmpeg (PCM)  →  Opus encoder  →  Discord
 *          └→  Opus passthrough (no ffmpeg, no encoder)
 *
 * yt-dlp does the extraction (see `ytdlp.ts`); this file owns the voice socket,
 * the ffmpeg transcode that makes volume control possible, and the lifecycle
 * events the player reacts to. There is no second service, no Java, and no
 * Docker: `npm install`, a bot token, and optionally ffmpeg on the host.
 *
 * When ffmpeg *and* an Opus encoder are present we decode to PCM and re-encode:
 * that is the only path on which volume can change while a track plays. When
 * they are not, YouTube's WebM/Opus is passed straight through — no
 * re-encoding, no CPU, and volume is reported as unavailable rather than
 * silently ignored.
 *
 * `AudioBackend` is the seam the player talks to, so queue/loop/skip behaviour
 * is testable without a voice socket (see the fakes in apps/bot/test).
 */

const log = createLogger("bot.music.audio");

/** Discord wants 48 kHz stereo; ffmpeg's -ar/-ac keep it that way. */
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
/** How long a voice handshake may take before we call it failed. */
const JOIN_TIMEOUT_MS = 20_000;
/** How long a dropped voice socket gets to come back on its own. */
const RECOVER_TIMEOUT_MS = 10_000;
/** Wait for yt-dlp's exit status before calling an idle player "finished". */
const EXIT_GRACE_MS = 400;
export class AudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioError";
  }
}

// ── ffmpeg & the Opus encoder ───────────────────────────────────────────

const FFMPEG_CACHE_MS = 5 * 60_000;
let ffmpegCache: { at: number; path: string | null } | null = null;

function pathLookup(bin: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function probeFfmpeg(): string | null {
  const configured = process.env.MUSIC_FFMPEG_PATH?.trim() || process.env.FFMPEG_PATH?.trim();
  if (configured) return existsSync(configured) ? configured : configured; // trust an explicit setting

  // A binary we downloaded ourselves (scripts/setup-music.mjs), then the
  // optional npm package (no system install, no build), then the system one.
  const local = path.join(process.env.MONARCH_BIN_DIR?.trim() || path.join(process.cwd(), ".monarch", "bin"), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (existsSync(local)) return local;

  try {
    const require = createRequire(import.meta.url);
    const installer = require("@ffmpeg-installer/ffmpeg") as { path?: string };
    if (installer?.path && existsSync(installer.path)) return installer.path;
  } catch {
    // Optional dependency — not installed on this machine.
  }

  return pathLookup("ffmpeg");
}

/**
 * The ffmpeg to use, or null when this host has none. Cached for a few minutes
 * so installing ffmpeg while the bot runs is picked up without a restart.
 */
export function resolveFfmpegPath(force = false): string | null {
  if (!force && ffmpegCache && Date.now() - ffmpegCache.at < FFMPEG_CACHE_MS) return ffmpegCache.path;
  const resolved = probeFfmpeg();
  ffmpegCache = { at: Date.now(), path: resolved };
  return resolved;
}

/** Tests (and a fresh env) can drop the cache. */
export function resetFfmpegCache(): void {
  ffmpegCache = null;
}

let encoderCache: boolean | null = null;

/**
 * prism-media needs an Opus *encoder* to turn PCM into Discord's packet
 * format. `@discordjs/opus` is the fast one (native build); `opusscript` is
 * pure JS and always installable, which is why it is a dependency.
 */
export function hasOpusEncoder(): boolean {
  if (encoderCache !== null) return encoderCache;
  const require = createRequire(import.meta.url);
  for (const name of ["@discordjs/opus", "opusscript"]) {
    try {
      require.resolve(name);
      encoderCache = true;
      return true;
    } catch {
      // try the next one
    }
  }
  encoderCache = false;
  return false;
}

/** Tests can pretend a machine has (or hasn't) an Opus encoder. */
export function setOpusEncoderAvailable(value: boolean | null): void {
  encoderCache = value;
}

// ── the backend contract ───────────────────────────────────────────────

export type TrackEndReason = "finished" | "stopped" | "failed";

export interface TrackEndEvent {
  guildId: string;
  /** The `Track.id` that ended, so a late event can be ignored. */
  trackId: string | null;
  reason: TrackEndReason;
  /** How long the track actually played (0 if it never started). */
  elapsedMs: number;
  /** Human-readable cause, when `reason` is `failed`. */
  error?: string;
}

export interface VoiceClosedEvent {
  guildId: string;
  reason: string;
}

export interface AudioBackendEvents {
  trackEnd: TrackEndEvent;
  voiceClosed: VoiceClosedEvent;
}

/**
 * Everything the player needs from audio, and nothing else. `DiscordAudioBackend`
 * is the real implementation; tests substitute a fake.
 */
export interface AudioBackend {
  /** Can volume change while a track plays? (Needs ffmpeg + an Opus encoder.) */
  readonly supportsVolume: boolean;
  join(guildId: string, channel: VoiceChannelLike): Promise<void>;
  leave(guildId: string): void;
  /** Start a track. Throws {@link AudioError} with a user-readable reason. */
  play(guildId: string, track: Track): Promise<void>;
  /** Stop the current track, keeping the connection (a skip). */
  stop(guildId: string): void;
  pause(guildId: string, paused: boolean): boolean;
  setVolume(guildId: string, percent: number): void;
  positionMs(guildId: string): number;
  connectedChannelId(guildId: string): string | null;
  isConnected(guildId: string): boolean;
  /** One line describing the pipeline (boot log, `/music status`). */
  describe(): string;
  shutdown(): Promise<void>;
  on<K extends keyof AudioBackendEvents>(event: K, listener: (payload: AudioBackendEvents[K]) => void): this;
  off<K extends keyof AudioBackendEvents>(event: K, listener: (payload: AudioBackendEvents[K]) => void): this;
  emit<K extends keyof AudioBackendEvents>(event: K, payload: AudioBackendEvents[K]): boolean;
}

/** The little of a voice channel this layer needs (kept structural for tests). */
export interface VoiceChannelLike {
  id: string;
  guild: { id: string; voiceAdapterCreator: unknown };
}

export interface AudioBackendOptions {
  /** Force a pipeline (tests, or an operator who knows better). */
  pipeline?: "pcm" | "opus";
  /** Open the downloader pipe (tests inject a fake). */
  openPipe?: (url: string) => Promise<AudioPipe>;
  /** Spawn ffmpeg (tests inject a fake). */
  spawnFfmpeg?: (bin: string, args: string[]) => ChildProcess;
  /** Create the Discord audio player (tests inject a fake). */
  createPlayer?: () => AudioPlayer;
  /** Join a voice channel (tests inject a fake connection). */
  joinConnection?: (options: {
    guildId: string;
    channelId: string;
    adapterCreator: unknown;
    selfDeaf: boolean;
    selfMute: boolean;
  }) => VoiceConnection;
}

interface AudioPipe {
  stream: Readable;
  kill(): void;
  alive(): boolean;
  result(): { code: number | null; stderr: string; signaled: boolean };
  exited: Promise<{ code: number | null; stderr: string; signaled: boolean }>;
}

interface GuildSession {
  guildId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  channelId: string;
  /** What is playing right now (null while idle). */
  current: { trackId: string; title: string; startedAt: number; pausedFor: number; pausedAt: number | null } | null;
  resource: AudioResource | null;
  pipe: AudioPipe | null;
  ffmpeg: ChildProcess | null;
  /** Set when we asked for the stop → the next idle is a "stopped". */
  stopping: boolean;
  /** Set when the track died → the next idle is a "failed". */
  failure: string | null;
  volume: number;
  leaving: boolean;
}

export class DiscordAudioBackend extends EventEmitter implements AudioBackend {
  private readonly sessions = new Map<string, GuildSession>();

  constructor(private readonly options: AudioBackendOptions = {}) {
    super();
  }

  /** ffmpeg *and* an Opus encoder: the only combination that can re-encode. */
  private canTranscode(): boolean {
    return Boolean(resolveFfmpegPath()) && hasOpusEncoder();
  }

  /** Which pipeline a track will use, given what this machine has. */
  private pipeline(): "pcm" | "opus" {
    if (this.options.pipeline) return this.options.pipeline;
    // Operators can force a path with `MUSIC_AUDIO_PIPELINE=pcm|opus`
    // (passthrough is cheaper; it just can't change volume).
    const forced = process.env.MUSIC_AUDIO_PIPELINE?.trim().toLowerCase();
    if (forced === "opus") return "opus";
    return this.canTranscode() ? "pcm" : "opus";
  }

  get supportsVolume(): boolean {
    return this.pipeline() === "pcm";
  }

  describe(): string {
    const ffmpeg = resolveFfmpegPath();
    if (this.pipeline() === "pcm") return `yt-dlp → ffmpeg → Opus (volume ✓)${ffmpeg ? ` · ${path.basename(ffmpeg)}` : ""}`;
    if (ffmpeg) return "yt-dlp → Opus passthrough (no Opus encoder installed — volume unavailable)";
    return "yt-dlp → Opus passthrough (no ffmpeg — volume unavailable)";
  }

  // ── joining & leaving ───────────────────────────────────────────────

  async join(guildId: string, channel: VoiceChannelLike): Promise<void> {
    const existing = this.sessions.get(guildId);
    if (existing && existing.channelId === channel.id && existing.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      return;
    }
    if (existing) this.leave(guildId);

    let connection: VoiceConnection;
    try {
      connection = this.options.joinConnection
        ? this.options.joinConnection({
            guildId,
            channelId: channel.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: false,
          })
        : joinVoiceChannel({
            guildId,
            channelId: channel.id,
            adapterCreator: channel.guild.voiceAdapterCreator as never,
            selfDeaf: true,
            selfMute: false,
          });
    } catch (error) {
      throw new AudioError(this.voiceJoinFailure(error));
    }

    const player = this.options.createPlayer
      ? this.options.createPlayer()
      : createAudioPlayer({
          // Stay with the queue's decision to play, not the socket's: the bot's
          // own timers decide when an empty channel ends the session.
          behaviors: { noSubscriber: NoSubscriberBehavior.Play },
        });

    const session: GuildSession = {
      guildId,
      connection,
      player,
      channelId: channel.id,
      current: null,
      resource: null,
      pipe: null,
      ffmpeg: null,
      stopping: false,
      failure: null,
      volume: 100,
      leaving: false,
    };
    this.sessions.set(guildId, session);
    connection.subscribe(player);
    this.wire(session);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
    } catch {
      this.leave(guildId);
      throw new AudioError(
        "I couldn't get into the voice channel — Discord never finished the handshake. " +
          "Check that I have **Connect** and **Speak** in that channel, then try again.",
      );
    }
    log.info("voice ready", { guildId, channelId: channel.id, pipeline: this.pipeline() });
  }

  /**
   * `joinVoiceChannel` fails synchronously when discord.js has no voice adapter
   * for the shard (a gateway that never became ready, or a client built without
   * the GuildVoiceStates intent). That used to surface as a bare `AbortError`.
   */
  private voiceJoinFailure(error: unknown): string {
    const detail = String(error instanceof Error ? error.message : error).slice(0, 200);
    if (/abort|adapter/i.test(detail)) {
      return (
        "Discord's gateway isn't ready for voice on this server — give it a few seconds and try again. " +
        "If it keeps happening, check that the bot is online."
      );
    }
    return `I couldn't join that voice channel (${detail}).`;
  }

  private wire(session: GuildSession): void {
    const { connection, player } = session;

    connection.on("stateChange", (_old: unknown, next: { status: VoiceConnectionStatus }) => {
      if (next.status === VoiceConnectionStatus.Disconnected) void this.onDisconnected(session);
    });

    player.on("stateChange", (_old: unknown, next: { status: AudioPlayerStatus }) => {
      if (next.status === AudioPlayerStatus.Idle) void this.onIdle(session);
    });

    player.on("error", (error: Error) => {
      log.warn("audio player error", { guildId: session.guildId, error: String(error?.message ?? error).slice(0, 300) });
      session.failure ??= `The audio stream failed (${String(error?.message ?? error).slice(0, 160)}).`;
    });
  }

  /** Discord dropped the socket: give it a moment to come back, else hand it up. */
  private async onDisconnected(session: GuildSession): Promise<void> {
    if (this.sessions.get(session.guildId) !== session || session.leaving) return;
    log.warn("voice connection dropped", { guildId: session.guildId, channelId: session.channelId });
    try {
      // A move to another channel, or a voice-server reshuffle, recovers by
      // itself within seconds. Anything longer means Discord closed the session.
      await Promise.race([
        entersState(session.connection, VoiceConnectionStatus.Signalling, RECOVER_TIMEOUT_MS),
        entersState(session.connection, VoiceConnectionStatus.Connecting, RECOVER_TIMEOUT_MS),
        entersState(session.connection, VoiceConnectionStatus.Ready, RECOVER_TIMEOUT_MS),
      ]);
      if (this.sessions.get(session.guildId) === session) log.info("voice connection recovered", { guildId: session.guildId });
    } catch {
      if (this.sessions.get(session.guildId) !== session) return;
      log.warn("voice connection could not be recovered", { guildId: session.guildId });
      this.leave(session.guildId);
      this.emit("voiceClosed", {
        guildId: session.guildId,
        reason: "The voice connection dropped and couldn't be re-established",
      });
    }
  }

  leave(guildId: string): void {
    const session = this.sessions.get(guildId);
    if (!session) return;
    session.leaving = true;
    this.sessions.delete(guildId);
    this.killPipeline(session);
    session.player.removeAllListeners();
    try {
      session.player.stop(true);
    } catch {
      // nothing was playing
    }
    try {
      session.connection.destroy();
    } catch {
      // already destroyed
    }
    session.current = null;
    session.resource = null;
  }

  connectedChannelId(guildId: string): string | null {
    const session = this.sessions.get(guildId);
    if (!session) return null;
    // `joinConfig.channelId` is what Discord last told the voice adapter — it
    // follows a move, so it is the honest answer.
    return session.connection.joinConfig?.channelId ?? session.channelId;
  }

  isConnected(guildId: string): boolean {
    return this.sessions.get(guildId)?.connection.state.status === VoiceConnectionStatus.Ready;
  }

  // ── playback ───────────────────────────────────────────────────────

  async play(guildId: string, track: Track): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session) throw new AudioError("I'm not in a voice channel — join one and run the command again.");
    if (!track.sourceUrl) throw new AudioError(`I don't have a playable source for **${track.title}**.`);

    this.killPipeline(session);
    session.stopping = false;
    session.failure = null;
    session.current = {
      trackId: track.id,
      title: track.title,
      startedAt: Date.now(),
      pausedFor: 0,
      pausedAt: null,
    };

    let pipe: AudioPipe;
    try {
      pipe = await (this.options.openPipe ?? openAudioPipe)(track.sourceUrl);
    } catch (error) {
      session.current = null;
      if (error instanceof YtdlpError) throw new AudioError(error.message);
      throw error instanceof AudioError ? error : new AudioError(String(error instanceof Error ? error.message : error));
    }
    session.pipe = pipe;

    let stream: Readable;
    let inputType: StreamType;
    try {
      ({ stream, inputType } = await this.buildStream(session, pipe));
    } catch (error) {
      this.killPipeline(session);
      session.current = null;
      throw error instanceof AudioError ? error : new AudioError(String(error instanceof Error ? error.message : error));
    }

    let resource: AudioResource;
    try {
      resource = createAudioResource(stream, {
        inputType,
        // Volume only exists on the PCM path: scaling Opus packets would
        // corrupt them. Asking for it on a passthrough stream is a no-op.
        inlineVolume: this.pipeline() === "pcm",
        metadata: { trackId: track.id, title: track.title },
      });
    } catch (error) {
      this.killPipeline(session);
      session.current = null;
      throw new AudioError(
        `I couldn't prepare this track's audio (${String(error instanceof Error ? error.message : error).slice(0, 140)}).`,
      );
    }
    resource.volume?.setVolume(volumeGain(session.volume));
    session.resource = resource;
    session.player.play(resource);
    log.info("audio started", {
      guildId,
      track: track.title,
      pipeline: this.pipeline(),
      volume: session.volume,
    });
  }

  /**
   * yt-dlp's bytes → something Discord can send: PCM through ffmpeg when that
   * buys volume control, otherwise YouTube's own Opus passthrough.
   */
  private async buildStream(session: GuildSession, pipe: AudioPipe): Promise<{ stream: Readable; inputType: StreamType }> {
    const ffmpegPath = resolveFfmpegPath();
    if (this.pipeline() === "pcm" && ffmpegPath) {
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vn",
        "-f",
        "s16le",
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        String(CHANNELS),
        "pipe:1",
      ];
      const ffmpeg = (this.options.spawnFfmpeg ?? ((bin, argv) => spawn(bin, argv, { windowsHide: true })))(
        ffmpegPath,
        args,
      );
      session.ffmpeg = ffmpeg;
      let stderr = "";
      ffmpeg.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4_000) stderr += chunk.toString("utf8");
      });
      ffmpeg.on("error", (error) => {
        stderr += `\n${String(error)}`;
        session.failure ??= `ffmpeg couldn't start: ${String((error as Error)?.message ?? error).slice(0, 160)}`;
      });
      ffmpeg.on("close", (code) => {
        if (session.ffmpeg === ffmpeg) session.ffmpeg = null;
        // A non-zero exit after the stream ends is normal when we killed it;
        // before then it means the decode failed.
        if (code !== 0 && code !== null && !session.stopping && session.current) {
          log.warn("ffmpeg exited early", { guildId: session.guildId, code, stderr: stderrTail(stderr) });
          session.failure ??= "The audio transcoder (ffmpeg) failed on this track.";
        }
        // ffmpeg is gone: stop yt-dlp writing into a dead pipe.
        if (pipe.alive()) pipe.kill();
      });
      pipe.stream.on("error", () => {
        try {
          ffmpeg.stdin?.end();
        } catch {
          // already closed
        }
      });
      pipe.stream.pipe(ffmpeg.stdin!);
      if (!ffmpeg.stdout) {
        this.killPipeline(session);
        throw new AudioError("Couldn't start the audio transcoder (ffmpeg).");
      }
      return { stream: ffmpeg.stdout, inputType: StreamType.Raw };
    }

    // Passthrough: YouTube hands out WebM/Opus, which Discord can be fed
    // as-is. `demuxProbe` figures out the container and strips it.
    try {
      const probed = await demuxProbe(pipe.stream);
      if (probed.type === StreamType.Arbitrary) {
        // Something Discord can't be handed directly (AAC/M4A, MP3, …). Only
        // ffmpeg can turn that into Opus, and this machine hasn't got one.
        // Give yt-dlp a moment to say *why* it produced nothing, though: a
        // failed download reported as "no Opus" would send the operator
        // chasing the wrong problem.
        const ended = await Promise.race([
          pipe.exited,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), EXIT_GRACE_MS).unref?.()),
        ]);
        this.killPipeline(session);
        if (ended && ended.code !== 0 && ended.stderr.trim()) {
          throw new AudioError(explainYtdlpFailure(ended.stderr));
        }
        throw new AudioError(
          "This track's audio isn't in a format Discord takes directly (it isn't Opus), and this machine has no **ffmpeg** " +
            "to convert it. Install ffmpeg, or set `YTDLP_FORMAT` to prefer an Opus source — see docs/troubleshooting-music.md.",
        );
      }
      return { stream: probed.stream, inputType: probed.type };
    } catch (error) {
      if (error instanceof AudioError) throw error;
      this.killPipeline(session);
      throw new AudioError(
        "I couldn't read this track's audio stream. " +
          `(${String(error instanceof Error ? error.message : error).slice(0, 120)}) ` +
          "Installing **ffmpeg** on the bot's machine makes non-Opus sources work — see docs/troubleshooting-music.md.",
      );
    }
  }

  private killPipeline(session: GuildSession): void {
    if (session.pipe) {
      try {
        session.pipe.kill();
      } catch {
        // already gone
      }
      session.pipe = null;
    }
    if (session.ffmpeg) {
      try {
        session.ffmpeg.kill("SIGKILL");
      } catch {
        // already gone
      }
      session.ffmpeg = null;
    }
  }

  /**
   * The player went idle: the track finished, died, or we stopped it. yt-dlp's
   * exit status is what tells a finished song from a broken one, so give it a
   * beat to publish that status before deciding.
   */
  private async onIdle(session: GuildSession): Promise<void> {
    if (this.sessions.get(session.guildId) !== session || session.leaving) return;
    const ended = session.current;
    if (!ended) return; // already reported (or never started)

    const elapsedMs = this.elapsedMs(session);
    const stopping = session.stopping;
    session.stopping = false;
    session.current = null;
    session.resource = null;

    const pipe = session.pipe;
    if (!stopping && pipe && pipe.alive()) {
      await Promise.race([pipe.exited, new Promise((resolve) => setTimeout(resolve, EXIT_GRACE_MS).unref?.())]);
    }
    const exit = pipe && !pipe.alive() ? pipe.result() : null;
    let failure = session.failure;
    if (!failure && !stopping && exit && exit.code !== 0) {
      // Killed by us on the way out? Then it is a stop, not a failure.
      failure = exit.signaled && session.leaving ? null : explainYtdlpFailure(exit.stderr);
    }
    session.failure = null;
    this.killPipeline(session);

    if (stopping) {
      this.emit("trackEnd", { guildId: session.guildId, trackId: ended.trackId, reason: "stopped", elapsedMs });
      return;
    }
    if (failure) {
      log.warn("track failed", { guildId: session.guildId, track: ended.title, error: failure.slice(0, 200) });
      this.emit("trackEnd", { guildId: session.guildId, trackId: ended.trackId, reason: "failed", elapsedMs, error: failure });
      return;
    }
    this.emit("trackEnd", { guildId: session.guildId, trackId: ended.trackId, reason: "finished", elapsedMs });
  }

  private elapsedMs(session: GuildSession): number {
    const current = session.current;
    if (!current) return 0;
    const end = current.pausedAt ?? Date.now();
    return Math.max(0, end - current.startedAt - current.pausedFor);
  }

  stop(guildId: string): void {
    const session = this.sessions.get(guildId);
    if (!session?.current) return;
    session.stopping = true;
    try {
      // `true` tears the resource down now, so idle fires immediately.
      session.player.stop(true);
    } catch {
      session.stopping = false;
    }
  }

  pause(guildId: string, paused: boolean): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    const status = session.player.state.status;
    if (paused) {
      if (status !== AudioPlayerStatus.Playing && status !== AudioPlayerStatus.Buffering) return false;
      session.player.pause();
      if (session.current) session.current.pausedAt = Date.now();
      return true;
    }
    if (status !== AudioPlayerStatus.Paused && status !== AudioPlayerStatus.AutoPaused) return false;
    // Freeze the position clock across the pause.
    if (session.current?.pausedAt) {
      session.current.pausedFor += Date.now() - session.current.pausedAt;
      session.current.pausedAt = null;
    }
    session.player.unpause();
    return true;
  }

  setVolume(guildId: string, percent: number): void {
    const session = this.sessions.get(guildId);
    if (!session) return;
    session.volume = Math.min(150, Math.max(0, Math.round(percent)));
    // No-op on the passthrough path (Opus packets can't be scaled).
    session.resource?.volume?.setVolume(volumeGain(session.volume));
  }

  positionMs(guildId: string): number {
    const session = this.sessions.get(guildId);
    if (!session) return 0;
    return this.elapsedMs(session);
  }

  async shutdown(): Promise<void> {
    for (const guildId of [...this.sessions.keys()]) this.leave(guildId);
    this.removeAllListeners();
  }
}
