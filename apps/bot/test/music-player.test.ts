import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceState } from "discord.js";
import type { Track } from "@monarch/music";

/**
 * The playback lifecycle: what the player hands to the audio backend, what it
 * does with what the backend reports back, and how a guild's session ends.
 *
 * The bot owns the voice socket itself now (yt-dlp → ffmpeg → Discord) instead
 * of delegating to a Lavalink node, so the backend is a seam rather than a
 * socket: these tests pin down the queue behaviour that used to lose a song —
 * a skip, a stream that dies mid-track, a track that ends early, a voice
 * connection Discord closes, an idle channel.
 */

vi.mock("../src/music/sources.js", async (original) => ({
  ...await original<typeof import("../src/music/sources.js")>(),
  ensurePlayable: vi.fn(async (track: Track) => track),
}));

import { ensurePlayable } from "../src/music/sources.js";
import { MusicManager } from "../src/music/player.js";
import { FakeAudioBackend, fakeClient, fakeGuild, fakeVoiceChannel, fakeVoiceChannelState } from "./music-fakes.js";

const track = (id: string, extra: Partial<Track> = {}): Track =>
  ({
    id,
    title: `Track ${id}`,
    author: "Author",
    videoId: id,
    sourceKind: "youtube",
    sourceName: "youtube",
    sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    url: `https://www.youtube.com/watch?v=${id}`,
    durationMs: 300_000,
    requestedBy: "user",
    requestedByName: "User",
    thumbnail: "https://img/thumb.jpg",
    ...extra,
  }) as Track;

/** One microtask/IO flush: the player's event handlers are fire-and-forget. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** `members` are the humans the manager can count in the bot's voice channel. */
function setup(members: string[] = []) {
  const backend = new FakeAudioBackend();
  const guild = fakeGuild("guild");
  const client = fakeClient(guild);
  client.channels.cache.set("voice", fakeVoiceChannelState("voice", members));
  const announce = vi.fn();
  const manager = new MusicManager(client, announce, undefined, backend);
  return { backend, guild, client, announce, manager };
}

/** Join a channel the way the bot does: one call, the backend does the rest. */
async function joinVoice(manager: MusicManager, guild: ReturnType<typeof fakeGuild>, channelId = "voice"): Promise<void> {
  await manager.connect("guild", fakeVoiceChannel(channelId, guild));
}

/** Joined, with one track already handed to the backend. */
async function playing(manager: MusicManager, guild: ReturnType<typeof fakeGuild>, first = "one") {
  await joinVoice(manager, guild);
  await manager.enqueue("guild", [track(first), track("two")]);
  await manager.startIfIdle("guild");
}

/** The two gateway packets behind a voice state change, as discord.js emits them. */
function fakeVoiceState(channelId: string | null, id = "bot-user") {
  return { id, channelId, guild: { id: "guild" } } as unknown as VoiceState;
}

const titles = (announce: ReturnType<typeof vi.fn>) =>
  announce.mock.calls.map(([, embed]) => (embed as { title?: string }).title);
const descriptions = (announce: ReturnType<typeof vi.fn>) =>
  announce.mock.calls.map(([, embed]) => String((embed as { description?: string }).description ?? ""));
const plays = (backend: FakeAudioBackend) =>
  backend.callsTo("play").map((call) => (call.args[1] as Track).id);

beforeEach(() => {
  vi.mocked(ensurePlayable).mockImplementation(async (t: Track) => t);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("joining a voice channel", () => {
  it("hands the channel to the audio backend and remembers it", async () => {
    const { backend, guild, manager } = setup();
    await joinVoice(manager, guild);

    expect(backend.lastCall("join")?.args).toEqual(["guild", "voice"]);
    expect(manager.connectedChannelId("guild")).toBe("voice");
    manager.teardown("guild", false);
  });

  it("doesn't re-join a channel it is already in", async () => {
    const { backend, guild, manager } = setup();
    await joinVoice(manager, guild);
    await manager.connect("guild", fakeVoiceChannel("voice", guild));
    expect(backend.callsTo("join")).toHaveLength(1);
    manager.teardown("guild", false);
  });

  it("turns a failed join into something a user can read", async () => {
    const { backend, guild, manager } = setup();
    const { AudioError } = await import("../src/music/audio.js");
    backend.join = vi.fn(async () => {
      throw new AudioError("I need **Connect** and **Speak** permissions in that channel.");
    }) as never;

    const { SourceError } = await import("../src/music/sources.js");
    await expect(manager.connect("guild", fakeVoiceChannel("voice", guild))).rejects.toThrow(SourceError);
    await expect(
      (() => {
        backend.join = vi.fn(async () => {
          throw new AudioError("no permission");
        }) as never;
        return manager.connect("guild", fakeVoiceChannel("voice", guild));
      })(),
    ).rejects.toThrow(/no permission/);
  });

  it("moves to another channel when the user drags the bot along", async () => {
    const { backend, guild, manager } = setup();
    await playing(manager, guild);

    await manager.connect("guild", fakeVoiceChannel("stage-two", guild));

    expect(backend.lastCall("join")?.args).toEqual(["guild", "stage-two"]);
    expect(manager.connectedChannelId("guild")).toBe("stage-two");
    expect(manager.queue("guild").nowPlaying()?.title).toBe("Track one");
    manager.teardown("guild", false);
  });
});

describe("playing tracks", () => {
  it("hands the track to the backend and announces it", async () => {
    const { backend, guild, announce, manager } = setup();
    await playing(manager, guild);

    expect(plays(backend)).toEqual(["one"]);
    expect(backend.lastCall("play")?.args[0]).toBe("guild");
    expect(titles(announce)).toContain("▶️ Now playing");
    expect(manager.isPlayingSomewhere("guild")).toBe(true);
    manager.teardown("guild", false);
  });

  it("advances when the backend reports the track finished", async () => {
    const { backend, guild, manager } = setup();
    await playing(manager, guild);
    backend.endTrack("guild", "finished", { trackId: "one", elapsedMs: 300_000 });
    await tick();

    expect(plays(backend)).toEqual(["one", "two"]);
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    manager.teardown("guild", false);
  });

  it("replays the same track in loop-track mode", async () => {
    const { backend, guild, manager } = setup();
    await joinVoice(manager, guild);
    manager.queue("guild").setLoop("track");
    await manager.enqueue("guild", [track("one")]);
    await manager.startIfIdle("guild");
    backend.endTrack("guild", "finished", { trackId: "one", elapsedMs: 300_000 });
    await tick();

    expect(plays(backend)).toEqual(["one", "one"]);
    manager.teardown("guild", false);
  });

  it("cycles the queue in loop-queue mode", async () => {
    const { backend, guild, manager } = setup();
    await joinVoice(manager, guild);
    manager.queue("guild").setLoop("queue");
    await manager.enqueue("guild", [track("one"), track("two")]);
    await manager.startIfIdle("guild");

    backend.endTrack("guild", "finished", { trackId: "one", elapsedMs: 300_000 });
    await tick();
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    backend.endTrack("guild", "finished", { trackId: "two", elapsedMs: 300_000 });
    await tick();
    expect(manager.queue("guild").nowPlaying()?.id).toBe("one");
    manager.teardown("guild", false);
  });

  it("leaves the channel once the queue runs dry", async () => {
    vi.useFakeTimers();
    const { backend, guild, announce, manager } = setup();
    await joinVoice(manager, guild);
    await manager.enqueue("guild", [track("only")]);
    await manager.startIfIdle("guild");

    backend.endTrack("guild", "finished", { trackId: "only", elapsedMs: 300_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.isPlayingSomewhere("guild")).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(titles(announce)).toContain("👋 Left the voice channel");
    expect(backend.callsTo("leave").length).toBeGreaterThan(0);
    expect(backend.isConnected()).toBe(false);
  });

  it("stays in the channel while a queue waits, and cancels the idle leave", async () => {
    vi.useFakeTimers();
    const { guild, manager } = setup();
    await joinVoice(manager, guild);
    await manager.enqueue("guild", [track("one")]);
    await manager.startIfIdle("guild");

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await manager.enqueue("guild", [track("two")]);
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(manager.connectedChannelId("guild")).toBe("voice");
    manager.teardown("guild", false);
  });

  it("matches a Spotify track to YouTube only when it plays", async () => {
    const { backend, guild, manager } = setup();
    await joinVoice(manager, guild);
    const spotify = track("sp", {
      sourceKind: "spotify",
      sourceName: "spotify",
      sourceUrl: undefined,
      videoId: "",
      url: "https://open.spotify.com/track/x",
      youtubeSearch: "Artist – Title",
    });
    vi.mocked(ensurePlayable).mockImplementation(async (t: Track) => {
      t.sourceUrl = "https://www.youtube.com/watch?v=matched";
      t.videoId = "matched";
      return t;
    });
    await manager.enqueue("guild", [spotify]);

    // Queued, not resolved: a 200-track playlist must stay instant.
    expect(ensurePlayable).not.toHaveBeenCalled();
    await manager.startIfIdle("guild");

    expect(ensurePlayable).toHaveBeenCalledWith(spotify);
    expect(plays(backend)).toEqual(["sp"]);
    manager.teardown("guild", false);
  });
});

describe("playback controls", () => {
  it("pauses and resumes through the backend", async () => {
    const { backend, guild, manager } = setup();
    await playing(manager, guild);

    expect(manager.pause("guild")).toBe(true);
    expect(backend.lastCall("pause")?.args).toEqual(["guild", true]);
    expect(manager.isPaused("guild")).toBe(true);
    expect(manager.pause("guild")).toBe(false); // already paused

    expect(manager.resume("guild")).toBe(true);
    expect(backend.lastCall("pause")?.args).toEqual(["guild", false]);
    expect(manager.isPaused("guild")).toBe(false);
    manager.teardown("guild", false);
  });

  it("says when the pipeline can't change volume", async () => {
    const { backend, guild, manager } = setup();
    await playing(manager, guild);
    backend.supportsVolume = false;

    expect(manager.setVolume("guild", 140)).toBe(false);
    expect(backend.lastCall("setVolume")?.args).toEqual(["guild", 140]);
    // The stored value still round-trips, so the UI can show what was asked.
    expect(manager.getVolume("guild")).toBe(140);
    manager.teardown("guild", false);
  });

  it("reads the position from the backend's clock", async () => {
    const { backend, guild, manager } = setup();
    await playing(manager, guild);
    backend.position = 60_000;
    expect(manager.positionMs("guild")).toBe(60_000);
    manager.teardown("guild", false);
  });

  it("skips by stopping the track and advancing when the backend confirms", async () => {
    const { backend, guild, manager } = setup();
    await playing(manager, guild);

    expect(manager.skip("guild")).toBe(true);
    expect(backend.callsTo("stop")).toHaveLength(1);
    expect(manager.queue("guild").nowPlaying()?.id).toBe("one"); // not yet — the backend confirms

    backend.endTrack("guild", "stopped", { trackId: "one", elapsedMs: 20_000 });
    await tick();
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    expect(plays(backend)).toEqual(["one", "two"]);
    manager.teardown("guild", false);
  });

  it("ignores a stop nobody asked for", async () => {
    const { backend, guild, manager } = setup();
    await playing(manager, guild);
    backend.calls.length = 0;

    backend.endTrack("guild", "stopped", { trackId: "one", elapsedMs: 10_000 });
    await tick();

    expect(backend.callsTo("play")).toHaveLength(0);
    expect(manager.queue("guild").nowPlaying()?.id).toBe("one");
    manager.teardown("guild", false);
  });

  it("ignores events about a track it already moved on from", async () => {
    const { backend, guild, manager } = setup();
    await playing(manager, guild);
    backend.endTrack("guild", "finished", { trackId: "one", elapsedMs: 300_000 });
    await tick();
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");

    // A late failure for the track we already skipped past.
    backend.endTrack("guild", "failed", { trackId: "one", error: "too late" });
    await tick();

    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    expect(plays(backend)).toEqual(["one", "two"]);
    manager.teardown("guild", false);
  });

  it("says when a track ends far before its length", async () => {
    const { backend, guild, announce, manager } = setup();
    await playing(manager, guild); // 5:00 track
    backend.endTrack("guild", "finished", { trackId: "one", elapsedMs: 45_000 });
    await tick();

    expect(titles(announce)).toContain("⚠️ Track cut short");
    expect(descriptions(announce).join("\n")).toMatch(/stopped at `0:45` but should be `5:00`/);
    // …and it still moves on instead of hanging.
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    manager.teardown("guild", false);
  });

  it("does not cry wolf when a track ends on time", async () => {
    const { backend, guild, announce, manager } = setup();
    await playing(manager, guild);
    backend.endTrack("guild", "finished", { trackId: "one", elapsedMs: 299_000 });
    await tick();
    expect(titles(announce)).not.toContain("⚠️ Track cut short");
    manager.teardown("guild", false);
  });
});

describe("when playback fails", () => {
  it("announces the reason and skips ahead", async () => {
    const { backend, guild, announce, manager } = setup();
    await playing(manager, guild);

    backend.endTrack("guild", "failed", { trackId: "one", error: "That video is private, so it can't be played." });
    await tick();

    expect(titles(announce)).toContain("⚠️ Track failed");
    expect(descriptions(announce).join("\n")).toMatch(/private/);
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    manager.teardown("guild", false);
  });

  it("gives up after three consecutive failures instead of burning the queue", async () => {
    const { backend, guild, announce, manager } = setup();
    await joinVoice(manager, guild);
    backend.playHandler = async () => {
      throw new (class extends Error {})(`yt-dlp failed for ${Math.random()}`);
    };
    await manager.enqueue("guild", [track("a"), track("b"), track("c"), track("d")]);

    await manager.startIfIdle("guild");

    expect(backend.callsTo("play")).toHaveLength(3);
    expect(titles(announce)).toContain("⏹ Giving up");
    expect(manager.connectedChannelId("guild")).toBeNull();
  });

  it("leaves quietly when Discord closes the voice socket", async () => {
    const { backend, guild, announce, manager } = setup();
    await playing(manager, guild);

    backend.voiceClosed("guild", "the voice connection was destroyed");
    await tick();

    expect(titles(announce)).toContain("🔌 Voice connection lost");
    expect(manager.connectedChannelId("guild")).toBeNull();
    expect(manager.isPlayingSomewhere("guild")).toBe(false);
  });
});

describe("voice state updates", () => {
  it("leaves when somebody disconnects the bot", async () => {
    const { backend, guild, manager } = setup();
    await playing(manager, guild);
    backend.calls.length = 0;

    manager.handleVoiceStateUpdate(fakeVoiceState("voice"), fakeVoiceState(null));

    expect(backend.callsTo("leave")).toHaveLength(1);
    expect(manager.connectedChannelId("guild")).toBeNull();
  });

  it("follows the bot when Discord moves it to another channel", async () => {
    const { backend, guild, client, manager } = setup();
    await playing(manager, guild);
    client.channels.cache.set("stage-two", fakeVoiceChannelState("stage-two", []));

    manager.handleVoiceStateUpdate(fakeVoiceState("voice"), fakeVoiceState("stage-two"));
    // The real backend learns the new channel from Discord's own voice-state
    // packet (it re-negotiates the socket); the fake needs the nudge.
    backend.channelId = "stage-two";

    expect(manager.connectedChannelId("guild")).toBe("stage-two");
    expect(backend.callsTo("leave")).toHaveLength(0);
    manager.teardown("guild", false);
  });

  it("leaves a minute after everyone else leaves the channel", async () => {
    vi.useFakeTimers();
    const { guild, client, announce, manager } = setup(["listener"]);
    await playing(manager, guild);
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
  it("leaves the channel, clears the queue and says so", async () => {
    const { backend, guild, announce, manager } = setup();
    await playing(manager, guild);

    manager.teardown("guild");

    expect(backend.callsTo("leave")).toHaveLength(1);
    expect(titles(announce)).toContain("👋 Left the voice channel");
    expect(manager.queue("guild").isEmpty).toBe(true);
    expect(manager.isPlayingSomewhere("guild")).toBe(false);
  });

  it("stops every guild and closes the backend on shutdown", async () => {
    const { backend, guild, manager } = setup();
    await playing(manager, guild);

    await manager.shutdown();

    expect(backend.callsTo("leave")).toHaveLength(1);
    expect(backend.shutDown).toBe(true);
    expect(manager.connectedChannelId("guild")).toBeNull();
  });
});
