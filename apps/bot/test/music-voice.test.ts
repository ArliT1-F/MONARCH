import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction, Client, VoiceBasedChannel } from "discord.js";

vi.mock("../src/music/ffmpeg.js", () => ({ resolveFfmpeg: vi.fn() }));
vi.mock("../src/music/sources.js", async (original) => ({
  ...await original<typeof import("../src/music/sources.js")>(),
  resolveQuery: vi.fn(),
  audioStreamFor: vi.fn(),
}));

// Only the join is faked: the timeout itself (entersState) and the dependency
// report are the parts of @discordjs/voice this suite needs to control.
const voice = vi.hoisted(() => ({
  joinVoiceChannel: vi.fn(),
  entersState: vi.fn(),
  generateDependencyReport: vi.fn(),
}));
vi.mock("@discordjs/voice", async (original) => ({
  ...await original<typeof import("@discordjs/voice")>(),
  ...voice,
}));

import {
  NetworkingStatusCode,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { resolveQuery } from "../src/music/sources.js";
import { handleMusicCommand } from "../src/music/commands.js";
import { MusicManager, VoiceError } from "../src/music/player.js";

/** The exact error @discordjs/voice turns a join timeout into. */
const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

type FakeConnection = EventEmitter & {
  destroy: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  joinConfig: { channelId: string };
  state: unknown;
};

/** A stand-in VoiceConnection whose `destroy` emits `destroyed` like the real one. */
function fakeConnection(state: unknown = connecting(), channelId = "voice-1"): FakeConnection {
  const connection = new EventEmitter() as FakeConnection;
  connection.joinConfig = { channelId };
  connection.state = state;
  connection.subscribe = vi.fn();
  connection.destroy = vi.fn(() => {
    connection.emit(VoiceConnectionStatus.Destroyed);
  });
  return connection;
}

const connecting = () => ({
  status: VoiceConnectionStatus.Connecting,
  networking: { state: { code: NetworkingStatusCode.UdpHandshaking } },
});

const channel = (id: string) =>
  ({ id, name: id, guild: { voiceAdapterCreator: vi.fn() } }) as unknown as VoiceBasedChannel;

const playInteraction = () => {
  const voiceChannel = { id: "voice-1", name: "Voice", permissionsFor: () => ({ has: () => true }) };
  const interaction = {
    inCachedGuild: () => true,
    guildId: "guild",
    channelId: "text",
    guild: { members: { me: {} }, channels: { cache: new Map() } },
    member: { voice: { channel: voiceChannel } },
    user: { id: "user", displayName: "User" },
    options: { getSubcommand: () => "play", getString: () => "rickroll" },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
  return interaction;
};

beforeEach(() => {
  vi.clearAllMocks();
  voice.joinVoiceChannel.mockReset();
  voice.entersState.mockReset();
  voice.generateDependencyReport.mockReset().mockReturnValue("dependency report");
});

describe("voice join failures", () => {
  it("names the stalled stage — a bare AbortError must not reach the user", async () => {
    voice.entersState.mockRejectedValue(abortError());
    const connection = fakeConnection();
    voice.joinVoiceChannel.mockReturnValue(connection);
    const manager = new MusicManager({} as Client, vi.fn());

    const error = (await manager.connect("guild", channel("voice-1")).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(VoiceError);
    // Stuck in UdpHandshaking = the host never answered a UDP packet.
    expect(error.message).toMatch(/UDP/);
    expect(error.message).not.toMatch(/operation was aborted/);
  });

  it("forgets the failed connection so the next attempt really re-joins", async () => {
    voice.entersState.mockRejectedValue(abortError());
    const connection = fakeConnection();
    voice.joinVoiceChannel.mockReturnValue(connection);
    const manager = new MusicManager({} as Client, vi.fn());

    await manager.connect("guild", channel("voice-1")).catch(() => {});

    expect(connection.destroy).toHaveBeenCalled();
    expect(manager.connectedChannelId("guild")).toBeNull(); // not "in voice" anymore
    await manager.connect("guild", channel("voice-1")).catch(() => {});
    expect(voice.joinVoiceChannel).toHaveBeenCalledTimes(2);
  });

  it("explains a websocket close code Discord sent (4014 = missing permissions)", async () => {
    voice.entersState.mockRejectedValue(abortError());
    voice.joinVoiceChannel.mockReturnValue(
      fakeConnection({
        status: VoiceConnectionStatus.Disconnected,
        reason: VoiceConnectionDisconnectReason.WebSocketClose,
        closeCode: 4014,
      }),
    );
    const manager = new MusicManager({} as Client, vi.fn());

    const error = (await manager.connect("guild", channel("voice-1")).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(VoiceError);
    expect(error.message).toMatch(/I need \*\*Connect\*\* and \*\*Speak\*\*/);
    expect(error.message).not.toMatch(/aborted/i);
  });

  it("shows the reason in Discord instead of a generic failure", async () => {
    vi.mocked(resolveQuery).mockResolvedValue({
      kind: "search",
      origin: "Never Gonna Give You Up",
      skipped: 0,
      tracks: [{
        id: "1",
        title: "Never Gonna Give You Up",
        author: "Rick Astley",
        videoId: "dQw4w9WgXcQ",
        sourceKind: "youtube",
        url: "https://youtu.be/dQw4w9WgXcQ",
        durationMs: 213_000,
        requestedBy: "user",
        requestedByName: "User",
        thumbnail: null,
      }],
    });
    const manager = {
      setAnnouncementChannel: vi.fn(),
      connectedChannelId: () => null,
      connect: vi.fn().mockRejectedValue(new VoiceError("🔇 I couldn't join voice: no UDP here.")),
    };
    const interaction = playInteraction();

    await handleMusicCommand(interaction as unknown as ChatInputCommandInteraction, manager as unknown as MusicManager);

    // First the progress line, then the voice explanation on top of it.
    expect(interaction.editReply).toHaveBeenLastCalledWith({ content: "⚠️ 🔇 I couldn't join voice: no UDP here." });
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});

describe("voice joins that work", () => {
  it("returns once ready and reuses the connection for the same channel", async () => {
    voice.entersState.mockResolvedValue(undefined);
    voice.joinVoiceChannel.mockReturnValue(fakeConnection());
    const manager = new MusicManager({} as Client, vi.fn());

    await manager.connect("guild", channel("voice-1"));
    await manager.connect("guild", channel("voice-1"));

    expect(manager.connectedChannelId("guild")).toBe("voice-1");
    expect(voice.joinVoiceChannel).toHaveBeenCalledTimes(1);
  });

  it("moves to another channel by replacing the connection", async () => {
    voice.entersState.mockResolvedValue(undefined);
    const first = fakeConnection();
    voice.joinVoiceChannel.mockReturnValueOnce(first).mockReturnValueOnce(fakeConnection(connecting(), "voice-2"));
    const manager = new MusicManager({} as Client, vi.fn());

    await manager.connect("guild", channel("voice-1"));
    await manager.connect("guild", channel("voice-2"));

    expect(first.destroy).toHaveBeenCalled();
    expect(voice.joinVoiceChannel).toHaveBeenCalledTimes(2);
    expect(manager.connectedChannelId("guild")).toBe("voice-2");

    // The session survived the move: the new channel is reused, not re-joined.
    await manager.connect("guild", channel("voice-2"));
    expect(voice.joinVoiceChannel).toHaveBeenCalledTimes(2);
  });

  it("replaces a connection that died while nobody was looking", async () => {
    voice.entersState.mockResolvedValue(undefined);
    const dead = fakeConnection({
      status: VoiceConnectionStatus.Destroyed,
    });
    voice.joinVoiceChannel.mockReturnValueOnce(dead).mockReturnValueOnce(fakeConnection());
    const manager = new MusicManager({} as Client, vi.fn());

    await manager.connect("guild", channel("voice-1")); // stores the (later) dead connection
    await manager.connect("guild", channel("voice-1"));

    expect(voice.joinVoiceChannel).toHaveBeenCalledTimes(2);
  });

  it("survives a voice connection error event instead of crashing the worker", async () => {
    voice.entersState.mockResolvedValue(undefined);
    const connection = fakeConnection();
    voice.joinVoiceChannel.mockReturnValue(connection);
    const manager = new MusicManager({} as Client, vi.fn());

    await manager.connect("guild", channel("voice-1"));

    expect(connection.listenerCount("error")).toBeGreaterThan(0);
    expect(() => connection.emit("error", new Error("udp exploded"))).not.toThrow();
  });

  it("tears the session down when Discord drops the connection", async () => {
    voice.entersState.mockResolvedValue(undefined);
    const connection = fakeConnection();
    voice.joinVoiceChannel.mockReturnValue(connection);
    const manager = new MusicManager({} as Client, vi.fn());

    await manager.connect("guild", channel("voice-1"));
    connection.emit(VoiceConnectionStatus.Destroyed);

    expect(manager.connectedChannelId("guild")).toBeNull();
  });
});
