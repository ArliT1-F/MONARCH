import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceState } from "discord.js";
import type { Track } from "@monarch/music";

/**
 * The Lavalink playback lifecycle: what the bot sends to the node, what it does
 * with what the node sends back, and how a guild's session ends.
 *
 * The bot never opens a voice socket or decodes audio — it joins a channel on
 * Discord's gateway (op 4), hands the resulting credentials to the node, and
 * then only says *what* to play. These tests pin that contract down, including
 * the paths that used to lose a song: a skip, a node restart, a track that ends
 * early and a voice socket Discord closes.
 */

vi.mock("../src/music/sources.js", async (original) => ({
  ...await original<typeof import("../src/music/sources.js")>(),
  ensurePlayable: vi.fn(async (track: Track) => track),
}));

import { ensurePlayable } from "../src/music/sources.js";
import { MusicManager } from "../src/music/player.js";
import {
  FakeLavalink,
  fakeClient,
  fakeGuild,
  fakeVoiceChannel,
  fakeVoiceChannelState,
  type FakeGuild,
} from "./music-fakes.js";

const track = (id: string, extra: Partial<Track> = {}): Track =>
  ({
    id,
    title: `Track ${id}`,
    author: "Author",
    videoId: id,
    sourceKind: "youtube",
    sourceName: "youtube",
    url: `https://www.youtube.com/watch?v=${id}`,
    durationMs: 300_000,
    requestedBy: "user",
    requestedByName: "User",
    thumbnail: "https://img/thumb.jpg",
    encoded: `enc-${id}`,
    ...extra,
  }) as Track;

/** One microtask/IO flush: the player's event handlers are fire-and-forget. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** `members` are the humans the manager can count in the bot's voice channel. */
function setup(members: string[] = []) {
  const lavalink = new FakeLavalink();
  const guild = fakeGuild("guild");
  const client = fakeClient(guild);
  client.channels.cache.set("voice", fakeVoiceChannelState("voice", members));
  const announce = vi.fn();
  const manager = new MusicManager(client, announce, undefined, lavalink as never);
  return { lavalink, guild, client, announce, manager };
}

/** The two packets Discord answers an op-4 join with. */
function deliverVoice(
  manager: MusicManager,
  { channelId = "voice", token = "voice-token", endpoint = "voice.discord.gg", sessionId = "discord-session" } = {},
): void {
  manager.handleRawPacket({
    t: "VOICE_STATE_UPDATE",
    d: { guild_id: "guild", user_id: "bot-user", session_id: sessionId, channel_id: channelId },
  });
  manager.handleRawPacket({
    t: "VOICE_SERVER_UPDATE",
    d: { guild_id: "guild", token, endpoint },
  });
}

/** Join a channel, then deliver the voice packets Discord would answer with. */
async function joinVoice(manager: MusicManager, guild: FakeGuild, channelId = "voice"): Promise<void> {
  const pending = manager.connect("guild", fakeVoiceChannel(channelId, guild));
  deliverVoice(manager, { channelId });
  await pending;
}

/** Joined, with one track already handed to the node. */
async function playing(manager: MusicManager, guild: FakeGuild, lavalink: FakeLavalink, first = "one") {
  await joinVoice(manager, guild);
  await manager.enqueue("guild", [track(first), track("two")]);
  await manager.startIfIdle("guild");
  return lavalink.lastCall("play");
}

const titles = (announce: ReturnType<typeof vi.fn>) =>
  announce.mock.calls.map(([, embed]) => (embed as { title?: string }).title);
const descriptions = (announce: ReturnType<typeof vi.fn>) =>
  announce.mock.calls.map(([, embed]) => String((embed as { description?: string }).description ?? ""));

beforeEach(() => {
  vi.mocked(ensurePlayable).mockImplementation(async (t: Track) => t);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("joining a voice channel", () => {
  it("joins on the gateway and hands Discord's voice credentials to the node", async () => {
    const { lavalink, guild, manager } = setup();
    await joinVoice(manager, guild);

    expect(guild.shard.send).toHaveBeenCalledWith({
      op: 4,
      d: { guild_id: "guild", channel_id: "voice", self_mute: false, self_deaf: true },
    });
    expect(lavalink.lastCall("updateVoice")?.args).toEqual([
      "guild",
      { token: "voice-token", endpoint: "voice.discord.gg", sessionId: "discord-session", channelId: "voice" },
    ]);
    expect(manager.connectedChannelId("guild")).toBe("voice");
    manager.teardown("guild", false);
  });

  it("ignores voice state updates that belong to somebody else", async () => {
    const { lavalink, guild, manager } = setup();
    const pending = manager.connect("guild", fakeVoiceChannel("voice", guild));
    manager.handleRawPacket({
      t: "VOICE_STATE_UPDATE",
      d: { guild_id: "guild", user_id: "some-listener", session_id: "not-ours", channel_id: "voice" },
    });
    manager.handleRawPacket({
      t: "VOICE_SERVER_UPDATE",
      d: { guild_id: "guild", token: "voice-token", endpoint: "voice.discord.gg" },
    });
    // Still waiting: a listener's session id is not ours to hand over.
    expect(lavalink.callsTo("updateVoice")).toHaveLength(0);
    manager.handleRawPacket({
      t: "VOICE_STATE_UPDATE",
      d: { guild_id: "guild", user_id: "bot-user", session_id: "discord-session", channel_id: "voice" },
    });
    await pending;
    expect(lavalink.callsTo("updateVoice")).toHaveLength(1);
    manager.teardown("guild", false);
  });

  it("doesn't re-join a channel it is already in", async () => {
    const { guild, manager } = setup();
    await joinVoice(manager, guild);
    await manager.connect("guild", fakeVoiceChannel("voice", guild));
    expect(guild.shard.send).toHaveBeenCalledTimes(1);
    manager.teardown("guild", false);
  });

  it("says so when Discord never hands out voice credentials", async () => {
    vi.useFakeTimers();
    const { guild, manager } = setup();
    const pending = manager.connect("guild", fakeVoiceChannel("voice", guild));
    const failure = pending.then(
      () => null,
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await failure).toMatch(/voice credentials in time/);
    manager.teardown("guild", false);
  });

  it("re-handshakes when the bot is moved to another channel, keeping the song", async () => {
    const { lavalink, guild, manager } = setup();
    await playing(manager, guild, lavalink);
    lavalink.position("guild", 40_000);
    lavalink.calls.length = 0;

    const moved = manager.connect("guild", fakeVoiceChannel("stage-two", guild));
    deliverVoice(manager, { channelId: "stage-two", token: "token-2", endpoint: "voice2.discord.gg" });
    await moved;

    expect(guild.shard.send).toHaveBeenLastCalledWith({
      op: 4,
      d: { guild_id: "guild", channel_id: "stage-two", self_mute: false, self_deaf: true },
    });
    expect(lavalink.lastCall("updateVoice")?.args[1]).toMatchObject({
      token: "token-2",
      endpoint: "voice2.discord.gg",
      channelId: "stage-two",
    });
    // …and the song picks back up where it was instead of starting over.
    const resumed = lavalink.lastCall("updatePlayer")?.args[1] as { track: { encoded: string }; position: number };
    expect(resumed.track.encoded).toBe("enc-one");
    expect(resumed.position).toBeGreaterThanOrEqual(40_000);
    // Nothing was destroyed: a move is not a stop.
    expect(lavalink.callsTo("destroyPlayer")).toHaveLength(0);
    expect(manager.connectedChannelId("guild")).toBe("stage-two");
    manager.teardown("guild", false);
  });
});

describe("playing tracks", () => {
  it("hands the node the encoded track, the volume and the track id", async () => {
    const { lavalink, guild, announce, manager } = setup();
    await playing(manager, guild, lavalink);

    expect(lavalink.lastCall("play")?.args).toEqual([
      "guild",
      "enc-one",
      { volume: 100, userData: { id: "one", requestedBy: "user" } },
    ]);
    expect(titles(announce)).toContain("▶️ Now playing");
    expect(manager.isPlayingSomewhere("guild")).toBe(true);
    manager.teardown("guild", false);
  });

  it("advances when the node reports the track finished", async () => {
    const { lavalink, guild, manager } = setup();
    await playing(manager, guild, lavalink);
    lavalink.endTrack("guild", "finished", { userData: { id: "one" } });
    await tick();

    expect(lavalink.lastCall("play")?.args[1]).toBe("enc-two");
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    manager.teardown("guild", false);
  });

  it("replays the same track in loop-track mode", async () => {
    const { lavalink, guild, manager } = setup();
    await joinVoice(manager, guild);
    manager.queue("guild").setLoop("track");
    await manager.enqueue("guild", [track("one")]);
    await manager.startIfIdle("guild");
    lavalink.endTrack("guild", "finished", { userData: { id: "one" } });
    await tick();

    expect(lavalink.callsTo("play").map((call) => call.args[1])).toEqual(["enc-one", "enc-one"]);
    manager.teardown("guild", false);
  });

  it("cycles the queue in loop-queue mode", async () => {
    const { lavalink, guild, manager } = setup();
    await joinVoice(manager, guild);
    manager.queue("guild").setLoop("queue");
    await manager.enqueue("guild", [track("one"), track("two")]);
    await manager.startIfIdle("guild");

    lavalink.endTrack("guild", "finished", { userData: { id: "one" } });
    await tick();
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    lavalink.endTrack("guild", "finished", { userData: { id: "two" } });
    await tick();
    expect(manager.queue("guild").nowPlaying()?.id).toBe("one");
    manager.teardown("guild", false);
  });

  it("leaves the channel once the queue runs dry", async () => {
    vi.useFakeTimers();
    const { lavalink, guild, announce, manager } = setup();
    await joinVoice(manager, guild);
    await manager.enqueue("guild", [track("only")]);
    await manager.startIfIdle("guild");

    lavalink.endTrack("guild", "finished", { userData: { id: "only" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.isPlayingSomewhere("guild")).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(titles(announce)).toContain("👋 Left the voice channel");
    expect(lavalink.callsTo("destroyPlayer").length).toBeGreaterThan(0);
  });

  it("matches a Spotify track to YouTube only when it plays", async () => {
    const { lavalink, guild, manager } = setup();
    await joinVoice(manager, guild);
    const spotify = track("sp", {
      sourceKind: "spotify",
      sourceName: "spotify",
      encoded: undefined,
      videoId: "",
      url: "https://open.spotify.com/track/x",
      youtubeSearch: "Artist – Title",
    });
    vi.mocked(ensurePlayable).mockImplementation(async (t: Track) => {
      t.encoded = "enc-matched";
      t.videoId = "matched";
      return t;
    });
    await manager.enqueue("guild", [spotify]);

    // Queued, not resolved: a 200-track playlist must stay instant.
    expect(ensurePlayable).not.toHaveBeenCalled();
    await manager.startIfIdle("guild");

    expect(ensurePlayable).toHaveBeenCalledWith(spotify);
    expect(lavalink.lastCall("play")?.args[1]).toBe("enc-matched");
    manager.teardown("guild", false);
  });
});

describe("playback controls", () => {
  it("pauses and resumes on the node", async () => {
    const { lavalink, guild, manager } = setup();
    await playing(manager, guild, lavalink);

    expect(manager.pause("guild")).toBe(true);
    expect(lavalink.lastCall("pause")?.args).toEqual(["guild", true]);
    expect(manager.isPaused("guild")).toBe(true);
    expect(manager.pause("guild")).toBe(false); // already paused

    expect(manager.resume("guild")).toBe(true);
    expect(lavalink.lastCall("pause")?.args).toEqual(["guild", false]);
    expect(manager.isPaused("guild")).toBe(false);
    manager.teardown("guild", false);
  });

  it("sends volume as a Lavalink percentage, live", async () => {
    const { lavalink, guild, manager } = setup();
    await playing(manager, guild, lavalink);
    manager.setVolume("guild", 140);
    expect(lavalink.lastCall("setVolume")?.args).toEqual(["guild", 140]);
    expect(manager.getVolume("guild")).toBe(140);
    manager.teardown("guild", false);
  });

  it("reads the position from the node's clock, and freezes it while paused", async () => {
    const { lavalink, guild, manager } = setup();
    await playing(manager, guild, lavalink);
    lavalink.position("guild", 60_000, Date.now() - 5_000);
    expect(manager.positionMs("guild")).toBeGreaterThanOrEqual(60_000);
    expect(manager.positionMs("guild")).toBeLessThan(90_000);

    manager.pause("guild");
    const frozen = manager.positionMs("guild");
    lavalink.position("guild", 60_000, Date.now() - 30_000);
    expect(manager.positionMs("guild")).toBe(60_000); // paused: no extrapolation
    expect(frozen).toBeGreaterThan(0);
    manager.teardown("guild", false);
  });

  it("skips by stopping the track and advancing when the node confirms", async () => {
    const { lavalink, guild, manager } = setup();
    await playing(manager, guild, lavalink);

    expect(manager.skip("guild")).toBe(true);
    expect(lavalink.callsTo("stopTrack")).toHaveLength(1);
    expect(manager.queue("guild").nowPlaying()?.id).toBe("one"); // not yet — the node confirms

    lavalink.endTrack("guild", "stopped", { userData: { id: "one" } });
    await tick();
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    expect(lavalink.lastCall("play")?.args[1]).toBe("enc-two");
    manager.teardown("guild", false);
  });

  it("ignores a stop nobody asked for", async () => {
    const { lavalink, guild, manager } = setup();
    await playing(manager, guild, lavalink);
    lavalink.calls.length = 0;

    lavalink.endTrack("guild", "stopped", { userData: { id: "one" } });
    await tick();

    expect(lavalink.callsTo("play")).toHaveLength(0);
    expect(manager.queue("guild").nowPlaying()?.id).toBe("one");
    manager.teardown("guild", false);
  });

  it("ignores events about a track it already moved on from", async () => {
    const { lavalink, guild, manager } = setup();
    await playing(manager, guild, lavalink);
    lavalink.endTrack("guild", "finished", { userData: { id: "one" } });
    await tick();
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    lavalink.calls.length = 0;

    // A late loadFailed for the track we already skipped past.
    lavalink.endTrack("guild", "loadFailed", { userData: { id: "one" } });
    await tick();

    expect(lavalink.callsTo("play")).toHaveLength(0);
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    manager.teardown("guild", false);
  });

  it("says when a track ends far before its length", async () => {
    const { lavalink, guild, announce, manager } = setup();
    await playing(manager, guild, lavalink); // 5:00 track
    lavalink.position("guild", 45_000);
    lavalink.endTrack("guild", "finished", { userData: { id: "one" } });
    await tick();

    expect(titles(announce)).toContain("⚠️ Track cut short");
    expect(descriptions(announce).join("\n")).toMatch(/stopped at `0:45` but should be `5:00`/);
    // …and it still moves on instead of hanging.
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    manager.teardown("guild", false);
  });

  it("does not cry wolf when a track ends on time", async () => {
    const { lavalink, guild, announce, manager } = setup();
    await playing(manager, guild, lavalink);
    lavalink.position("guild", 299_000);
    lavalink.endTrack("guild", "finished", { userData: { id: "one" } });
    await tick();
    expect(titles(announce)).not.toContain("⚠️ Track cut short");
    manager.teardown("guild", false);
  });

  it("skips ahead when playback stalls on the node", async () => {
    const { lavalink, guild, announce, manager } = setup();
    await playing(manager, guild, lavalink);
    lavalink.stuck("guild");
    await tick();

    expect(titles(announce)).toContain("⚠️ Track failed");
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    manager.teardown("guild", false);
  });
});

describe("when the node or the voice link dies", () => {
  it("rebuilds the player after a node restart and resumes the position", async () => {
    const { lavalink, guild, announce, manager } = setup();
    await playing(manager, guild, lavalink);
    lavalink.position("guild", 90_000, Date.now());
    lavalink.calls.length = 0;

    lavalink.nodeRestarted(false);
    deliverVoice(manager, { token: "token-2", endpoint: "voice2.discord.gg" });
    await tick();
    await tick();

    expect(titles(announce)).toContain("🔁 Music node restarted");
    expect(lavalink.lastCall("updateVoice")?.args[1]).toMatchObject({ sessionId: "discord-session" });
    const resumed = lavalink.lastCall("updatePlayer")?.args[1] as { track: { encoded: string }; position: number };
    expect(resumed.track.encoded).toBe("enc-one");
    expect(resumed.position).toBeGreaterThanOrEqual(90_000);
    expect(resumed.position).toBeLessThan(120_000);
    manager.teardown("guild", false);
  });

  it("leaves playback alone when the node resumed our session", async () => {
    const { lavalink, guild, manager } = setup();
    await playing(manager, guild, lavalink);
    lavalink.calls.length = 0;

    lavalink.nodeRestarted(true);
    await tick();

    expect(lavalink.callsTo("updatePlayer")).toHaveLength(0);
    expect(lavalink.callsTo("destroyPlayer")).toHaveLength(0);
    manager.teardown("guild", false);
  });

  it("re-joins when Discord invalidates the voice session", async () => {
    const { lavalink, guild, manager } = setup();
    await playing(manager, guild, lavalink);
    lavalink.calls.length = 0;
    guild.shard.send.mockClear();

    lavalink.voiceClosed("guild", 4006);
    deliverVoice(manager, { token: "token-2", endpoint: "voice2.discord.gg" });
    await tick();
    await tick();

    expect(guild.shard.send).toHaveBeenCalledWith({
      op: 4,
      d: { guild_id: "guild", channel_id: "voice", self_mute: false, self_deaf: true },
    });
    expect(lavalink.lastCall("updatePlayer")?.args[1]).toMatchObject({ track: { encoded: "enc-one" } });
    manager.teardown("guild", false);
  });

  it("leaves quietly when Discord disconnects the bot (4014)", async () => {
    const { lavalink, guild, announce, manager } = setup();
    await playing(manager, guild, lavalink);

    lavalink.voiceClosed("guild", 4014, true);
    await tick();

    expect(manager.connectedChannelId("guild")).toBeNull();
    expect(titles(announce)).not.toContain("👋 Left the voice channel");
  });

  it("leaves when somebody disconnects the bot from voice", async () => {
    const { lavalink, guild, manager } = setup();
    await playing(manager, guild, lavalink);
    guild.shard.send.mockClear();

    manager.handleVoiceStateUpdate(
      { guild: { id: "guild" }, channelId: "voice", id: "bot-user" } as unknown as VoiceState,
      { guild: { id: "guild" }, channelId: null, id: "bot-user" } as unknown as VoiceState,
    );

    expect(manager.connectedChannelId("guild")).toBeNull();
    expect(guild.shard.send).toHaveBeenCalledWith({
      op: 4,
      d: { guild_id: "guild", channel_id: null, self_mute: false, self_deaf: true },
    });
  });

  it("leaves a minute after everyone else leaves the channel", async () => {
    vi.useFakeTimers();
    const { lavalink, guild, client, announce, manager } = setup(["listener"]);
    await playing(manager, guild, lavalink);
    client.channels.cache.set("voice", fakeVoiceChannelState("voice", [])); // the last listener left

    manager.handleVoiceStateUpdate(
      { guild: { id: "guild" }, channelId: "voice", id: "listener" } as unknown as VoiceState,
      { guild: { id: "guild" }, channelId: null, id: "listener" } as unknown as VoiceState,
    );
    expect(titles(announce)).toContain("🌙 Everyone left");

    await vi.advanceTimersByTimeAsync(59_000);
    expect(manager.connectedChannelId("guild")).toBe("voice");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(manager.connectedChannelId("guild")).toBeNull();
  });

  it("cancels leaving when somebody comes back", async () => {
    vi.useFakeTimers();
    const { guild, client, announce, manager } = setup();
    await joinVoice(manager, guild);
    const leave = { guild: { id: "guild" }, channelId: null, id: "listener" } as unknown as VoiceState;
    const here = { guild: { id: "guild" }, channelId: "voice", id: "listener" } as unknown as VoiceState;

    manager.handleVoiceStateUpdate(here, leave); // room is empty → countdown starts
    expect(titles(announce)).toContain("🌙 Everyone left");

    client.channels.cache.set("voice", fakeVoiceChannelState("voice", ["listener"]));
    manager.handleVoiceStateUpdate(leave, here); // …somebody's back → cancelled
    await vi.advanceTimersByTimeAsync(120_000);

    expect(manager.connectedChannelId("guild")).toBe("voice");
    manager.teardown("guild", false);
  });
});

describe("stopping", () => {
  it("destroys the node's player and leaves the channel", async () => {
    const { lavalink, guild, announce, manager } = setup();
    await playing(manager, guild, lavalink);
    guild.shard.send.mockClear();

    manager.teardown("guild");

    expect(lavalink.callsTo("destroyPlayer")).toHaveLength(1);
    expect(guild.shard.send).toHaveBeenCalledWith({
      op: 4,
      d: { guild_id: "guild", channel_id: null, self_mute: false, self_deaf: true },
    });
    expect(titles(announce)).toContain("👋 Left the voice channel");
    expect(manager.queue("guild").isEmpty).toBe(true);
    expect(manager.isPlayingSomewhere("guild")).toBe(false);
  });

  it("ignores the node's cleanup event that a teardown causes", async () => {
    const { lavalink, guild, manager } = setup();
    await playing(manager, guild, lavalink);
    manager.teardown("guild", false);
    lavalink.calls.length = 0;

    lavalink.endTrack("guild", "cleanup", { userData: { id: "one" } });
    lavalink.endTrack("guild", "stopped", { userData: { id: "one" } });
    await tick();

    expect(lavalink.callsTo("play")).toHaveLength(0);
  });

  it("waits for the node to drop every player before closing the sockets", async () => {
    const { lavalink, guild, manager } = setup();
    await playing(manager, guild, lavalink);

    const done = manager.shutdown();

    // The delete is already on its way (teardown doesn't block a /music stop),
    // but the sockets stay up until the node has actually dropped the player —
    // the SIGTERM handler exits the worker as soon as this promise settles.
    expect(lavalink.callsTo("destroyPlayer")).toHaveLength(1);
    expect(lavalink.stopped).toBe(false);
    expect(guild.shard.send).toHaveBeenLastCalledWith({
      op: 4,
      d: { guild_id: "guild", channel_id: null, self_mute: false, self_deaf: true },
    });

    await done;

    expect(lavalink.stopped).toBe(true);
    expect(manager.connectedChannelId("guild")).toBeNull();
  });
});
