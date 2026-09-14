import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { Client, Guild, VoiceBasedChannel } from "discord.js";
import type { LavalinkManager, LavalinkNode } from "../src/music/lavalink.js";

/**
 * Test doubles for the Lavalink side of the music player.
 *
 * The real manager owns sockets and REST calls (tested in
 * music-lavalink.test.ts); these fakes record what the player asked for and let
 * a test fire the node's events back at it by hand.
 */

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export class FakeLavalink extends EventEmitter {
  calls: RecordedCall[] = [];
  started = false;
  stopped = false;
  /** Overridable per test: make `play` fail, hang, etc. */
  playHandler: (guildId: string, encoded: string, options?: unknown) => Promise<unknown> = async () => undefined;
  whenReadyHandler: () => Promise<LavalinkNode> = async () => this.node as unknown as LavalinkNode;

  readonly node = {
    name: "fake-node",
    host: "localhost",
    port: 2333,
    connected: true,
    sessionId: "fake-session",
    assignedGuilds: new Set<string>(),
  };

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  lastCall(method: string): RecordedCall | undefined {
    return this.callsTo(method).at(-1);
  }

  start(userId?: string): void {
    this.started = true;
    this.record("start", [userId]);
  }

  stop(): void {
    this.stopped = true;
    this.record("stop", []);
  }

  whenReady(): Promise<LavalinkNode> {
    return this.whenReadyHandler();
  }

  nodeOf(): LavalinkNode | null {
    return this.node as unknown as LavalinkNode;
  }

  nodeFor(): LavalinkNode {
    return this.node as unknown as LavalinkNode;
  }

  release(): void {
    this.record("release", []);
  }

  play(guildId: string, encoded: string, options?: unknown): Promise<unknown> {
    this.record("play", [guildId, encoded, options]);
    return this.playHandler(guildId, encoded, options);
  }

  stopTrack(guildId: string): Promise<unknown> {
    this.record("stopTrack", [guildId]);
    return Promise.resolve();
  }

  pause(guildId: string, paused: boolean): Promise<unknown> {
    this.record("pause", [guildId, paused]);
    return Promise.resolve();
  }

  setVolume(guildId: string, volume: number): Promise<unknown> {
    this.record("setVolume", [guildId, volume]);
    return Promise.resolve();
  }

  seek(guildId: string, positionMs: number): Promise<unknown> {
    this.record("seek", [guildId, positionMs]);
    return Promise.resolve();
  }

  updateVoice(guildId: string, voice: unknown): Promise<unknown> {
    this.record("updateVoice", [guildId, voice]);
    return Promise.resolve();
  }

  updatePlayer(guildId: string, payload: unknown): Promise<unknown> {
    this.record("updatePlayer", [guildId, payload]);
    return Promise.resolve();
  }

  destroyPlayer(guildId: string): Promise<void> {
    this.record("destroyPlayer", [guildId]);
    return Promise.resolve();
  }

  describe(): string {
    return "fake-node(localhost:2333) ready:fake-session";
  }

  // ── what the node would push back ──────────────────────────────────

  /** `TrackEndEvent`, the way {@link LavalinkManager} re-emits it. */
  endTrack(guildId: string, reason: string, track?: { userData?: unknown; info?: unknown } | null): void {
    this.emit("trackEnd", {
      guildId,
      track: track ? { encoded: "e", info: {}, ...track } : null,
      reason,
      node: this.node,
    });
  }

  startTrack(guildId: string, info: { title?: string; identifier?: string; position?: number; sourceName?: string } = {}): void {
    this.emit("trackStart", {
      guildId,
      node: this.node,
      track: { encoded: "e", info: { position: 0, ...info }, userData: {} },
    });
  }

  position(guildId: string, position: number, time = Date.now()): void {
    this.emit("playerUpdate", { guildId, node: this.node, state: { position, time, connected: true, ping: 10 } });
  }

  exception(guildId: string, message: string, title = "That track"): void {
    this.emit("trackException", {
      guildId,
      node: this.node,
      track: { encoded: "e", info: { title } },
      exception: { message, severity: "common", cause: "test" },
    });
  }

  stuck(guildId: string, thresholdMs = 10_000): void {
    this.emit("trackStuck", { guildId, node: this.node, track: null, thresholdMs });
  }

  /** The node came back after a restart. `resumed: false` = its players are gone. */
  nodeRestarted(resumed = false): void {
    this.emit("nodeReconnect", { node: this.node, sessionId: "fake-session", resumed });
  }

  voiceClosed(guildId: string, code: number, byRemote = true): void {
    this.emit("voiceSocketClosed", { guildId, node: this.node, code, reason: "test", byRemote });
  }
}

/**
 * A guild whose shard records the op-4 voice state updates the bot sends.
 * Deliberately *not* a `Guild`: only the three members the player touches exist.
 */
export interface FakeGuild {
  id: string;
  shard: { send: ReturnType<typeof vi.fn> };
  channels: { cache: Map<string, unknown> };
  members: { me: null };
}

export function fakeGuild(id = "guild"): FakeGuild {
  return { id, shard: { send: vi.fn() }, channels: { cache: new Map() }, members: { me: null } };
}

/** A voice channel the manager can count listeners in. */
export function fakeVoiceChannelState(id: string, memberIds: string[] = []) {
  const members = new Map(memberIds.map((memberId) => [memberId, { id: memberId, user: { id: memberId, bot: false } }]));
  return { id, isVoiceBased: () => true, members };
}

export function fakeClient(guild: FakeGuild, userId = "bot-user"): Client & { channels: { cache: Map<string, unknown> } } {
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
