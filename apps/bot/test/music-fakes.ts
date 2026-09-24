import { EventEmitter } from "node:events";
import type { Track } from "@monarch/music";
import type { Client, Guild, VoiceBasedChannel } from "discord.js";
import type { AudioBackend, TrackEndReason, VoiceChannelLike } from "../src/music/audio.js";

/**
 * Test doubles for the audio side of the music player.
 *
 * The real backend owns voice sockets, spawned processes and an AudioPlayer
 * (covered in music-audio.test.ts); this fake records what the player asked
 * for and lets a test fire the backend's events back at it by hand — a track
 * finishing, a track dying, the voice socket dropping.
 */

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export class FakeAudioBackend extends EventEmitter implements AudioBackend {
  calls: RecordedCall[] = [];
  /** Overridable per test: make `play` fail, hang, etc. */
  playHandler: (guildId: string, track: Track) => Promise<void> = async () => undefined;
  /** Null while the bot isnt in a channel. */
  channelId: string | null = null;
  connected = false;
  paused = false;
  volume = 100;
  position = 0;
  /** Set to false in a test to model a machine without ffmpeg. */
  supportsVolume = true;
  shutDown = false;

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  lastCall(method: string): RecordedCall | undefined {
    return this.callsTo(method).at(-1);
  }

  async join(guildId: string, channel: VoiceChannelLike): Promise<void> {
    this.record("join", [guildId, channel.id]);
    this.channelId = channel.id;
    this.connected = true;
  }

  leave(guildId: string): void {
    this.record("leave", [guildId]);
    this.channelId = null;
    this.connected = false;
  }

  play(guildId: string, track: Track): Promise<void> {
    this.record("play", [guildId, track]);
    this.connected = true;
    return this.playHandler(guildId, track);
  }

  stop(guildId: string): void {
    this.record("stop", [guildId]);
  }

  pause(guildId: string, paused: boolean): boolean {
    this.record("pause", [guildId, paused]);
    this.paused = paused;
    return true;
  }

  setVolume(guildId: string, percent: number): void {
    this.record("setVolume", [guildId, percent]);
    this.volume = percent;
  }

  positionMs(): number {
    return this.position;
  }

  connectedChannelId(): string | null {
    return this.channelId;
  }

  isConnected(): boolean {
    return this.connected;
  }

  describe(): string {
    return this.supportsVolume ? "fake-backend (ffmpeg→PCM)" : "fake-backend (Opus passthrough)";
  }

  async shutdown(): Promise<void> {
    this.record("shutdown", []);
    this.shutDown = true;
    this.channelId = null;
    this.connected = false;
  }

  // ── what the backend would push back ───────────────────────────────

  /** The current track ended. `trackId` defaults to whatever played last. */
  endTrack(
    guildId: string,
    reason: TrackEndReason,
    extra: { trackId?: string | null; elapsedMs?: number; error?: string; raw?: string } = {},
  ): void {
    this.emit("trackEnd", {
      guildId,
      trackId: extra.trackId ?? null,
      reason,
      elapsedMs: extra.elapsedMs ?? 0,
      ...(extra.error ? { error: extra.error } : {}),
      ...(extra.raw ? { raw: extra.raw } : {}),
    });
  }

  /** The voice socket died and could not be recovered. */
  voiceClosed(guildId: string, reason = "the voice connection was lost"): void {
    this.emit("voiceClosed", { guildId, reason });
  }
}

/**
 * A guild whose `voiceAdapterCreator` is a stub: @discordjs/voice is what
 * actually opens the voice session, so the fake only has to exist.
 * Deliberately *not* a `Guild`: only the members the player touches exist.
 */
export interface FakeGuild {
  id: string;
  voiceAdapterCreator: unknown;
  channels: { cache: Map<string, unknown> };
  /** The bot's own member, as far as the gateway cache knows it. */
  members: { me: { voice: { channelId: string | null } } | null };
}

export function fakeGuild(id = "guild"): FakeGuild {
  return {
    id,
    voiceAdapterCreator: () => () => {},
    channels: { cache: new Map() },
    members: { me: null },
  };
}

/** A voice channel the manager can count listeners in. */
export function fakeVoiceChannelState(id: string, memberIds: string[] = []) {
  const members = new Map(
    memberIds.map((memberId) => [memberId, { id: memberId, user: { id: memberId, bot: false } }]),
  );
  return { id, isVoiceBased: () => true, members };
}

export function fakeClient(
  guild: FakeGuild,
  userId = "bot-user",
): Client & { channels: { cache: Map<string, unknown> } } {
  const guilds = new Map<string, Guild>();
  guilds.set(guild.id, guild as unknown as Guild);
  return {
    user: { id: userId },
    guilds: { cache: guilds },
    channels: { cache: new Map() },
  } as unknown as Client & { channels: { cache: Map<string, unknown> } };
}

export function fakeVoiceChannel(id: string, guild: FakeGuild): VoiceBasedChannel {
  return { id, guild } as unknown as VoiceBasedChannel;
}
