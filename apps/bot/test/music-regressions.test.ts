import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import { MusicQueue, type Track } from "@monarch/music";

/**
 * Failure regressions — the bugs that used to be silent.
 *
 * Audio now runs in-process (yt-dlp → ffmpeg → Discord), so "the stream died"
 * became "yt-dlp exited non-zero" / "the downloader isnt installed". What must
 * not regress is the behaviour *around* those failures: a failed track is
 * skipped without wedging the queue, a stop wins the race against a slow
 * resolve, a dead downloader is named as such, and a deferred reply still
 * carries the original human-readable error.
 */

vi.mock("../src/music/sources.js", async (original) => ({
  ...(await original<typeof import("../src/music/sources.js")>()),
  ensurePlayable: vi.fn(async (track: Track) => track),
  resolveQuery: vi.fn(),
}));

import { SourceError, ensurePlayable, resolveQuery } from "../src/music/sources.js";
import { MusicCommands } from "../src/music/commands.js";
import { MusicManager } from "../src/music/player.js";
import { SlashCommandContext } from "../src/slash-context.js";
import {
  FakeAudioBackend,
  fakeClient,
  fakeGuild,
  fakeVoiceChannel,
  type FakeGuild,
} from "./music-fakes.js";

const track = (id: string, extra: Partial<Track> = {}): Track =>
  ({
    id,
    title: id,
    author: "Author",
    videoId: id,
    sourceKind: "youtube",
    sourceName: "youtube",
    sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    url: `https://www.youtube.com/watch?v=${id}`,
    durationMs: 200_000,
    requestedBy: "user",
    requestedByName: "User",
    thumbnail: null,
    ...extra,
  }) as Track;

function setup() {
  const backend = new FakeAudioBackend();
  const guild = fakeGuild("guild");
  const announce = vi.fn();
  const manager = new MusicManager(fakeClient(guild), announce, undefined, backend);
  return { backend, guild, announce, manager };
}

/** Join a channel the way the bot does: one call, the backend does the rest. */
async function joinVoice(
  manager: MusicManager,
  guild: FakeGuild,
  channelId = "voice",
): Promise<void> {
  await manager.connect("guild", fakeVoiceChannel(channelId, guild));
}

const titles = (announce: ReturnType<typeof vi.fn>) =>
  announce.mock.calls.map(([, embed]) => (embed as { title?: string }).title);
const descriptions = (announce: ReturnType<typeof vi.fn>) =>
  announce.mock.calls.map(([, embed]) =>
    String((embed as { description?: string }).description ?? ""),
  );

beforeEach(() => {
  vi.mocked(ensurePlayable).mockImplementation(async (t: Track) => t);
});
afterEach(() => vi.clearAllMocks());

describe("music failure regressions", () => {
  it("edits the deferred reply with the original Spotify error", async () => {
    const channel = { id: "voice", permissionsFor: () => ({ has: () => true }) };
    const interaction = {
      inCachedGuild: () => true,
      guildId: "guild",
      channelId: "text",
      guild: { members: { me: {} }, channels: { cache: new Map() } },
      member: { voice: { channel } },
      user: { id: "user", displayName: "User" },
      options: { getSubcommand: () => "play", getString: () => "spotify link" },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {
        interaction.deferred = true;
      }),
      editReply: vi.fn(),
      reply: vi.fn(),
    };
    const manager = {
      connectedChannelId: () => null,
      setAnnouncementChannel: vi.fn(),
      connect: vi.fn(),
    };
    vi.mocked(resolveQuery).mockRejectedValue(new SourceError("Spotify links are not configured"));
    // The same handler serves /music play and !play — the test drives the
    // slash surface through its CommandContext adapter.
    const ctx = new SlashCommandContext(
      interaction as unknown as ChatInputCommandInteraction<"cached">,
      "!",
    );
    await new MusicCommands(manager as unknown as MusicManager).run(ctx, "play");
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "⚠️ Spotify links are not configured",
      embeds: undefined,
      allowedMentions: { parse: [] },
    });
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it.each(["off", "track", "queue"] as const)(
    "drains tracks the downloader refuses without getting stuck in %s loop",
    async (mode) => {
      const { backend, announce, manager } = setup();
      manager.queue("guild").setLoop(mode);
      await manager.enqueue("guild", [track("one"), track("two")]);
      vi.mocked(ensurePlayable).mockRejectedValue(new SourceError("Unavailable"));

      await manager.startIfIdle("guild");

      expect(ensurePlayable).toHaveBeenCalledTimes(2);
      expect(backend.callsTo("play")).toHaveLength(0); // nothing unplayable reached the pipeline
      expect(manager.queue("guild").isEmpty).toBe(true);
      // Every refusal is announced, so a silent skip can't happen again.
      expect(titles(announce).filter((t) => t === "⚠️ Track failed")).toHaveLength(2);
      manager.teardown("guild", false);
    },
  );

  it("does not start a track after stop", async () => {
    const { backend, guild, manager } = setup();
    await joinVoice(manager, guild);

    const late = track("late");
    let resolvePlayable!: (value: Track) => void;
    vi.mocked(ensurePlayable).mockReturnValue(
      new Promise<Track>((resolve) => {
        resolvePlayable = resolve;
      }),
    );

    await manager.enqueue("guild", [late]);
    const playing = manager.startIfIdle("guild");
    manager.teardown("guild", false); // the user gave up while we were resolving
    resolvePlayable(late);
    await playing;

    expect(backend.callsTo("play")).toHaveLength(0);
    expect(backend.callsTo("leave")).toHaveLength(1);
  });

  it("can skip a failed current track without changing the loop setting", () => {
    const queue = new MusicQueue();
    queue.addMany([track("one"), track("two")]);
    queue.next();
    queue.setLoop("track");
    expect(queue.next(true)?.id).toBe("two");
    expect(queue.loopMode).toBe("track");
  });

  it("gives up after three consecutive failures instead of burning the whole queue", async () => {
    const { backend, guild, announce, manager } = setup();
    await joinVoice(manager, guild);
    vi.mocked(ensurePlayable).mockRejectedValue(new SourceError("Unavailable"));
    await manager.enqueue("guild", [track("a"), track("b"), track("c"), track("d")]);

    await manager.startIfIdle("guild");

    expect(ensurePlayable).toHaveBeenCalledTimes(3);
    expect(titles(announce)).toContain("⏹ Giving up");
    // Giving up means leaving: the voice channel is freed.
    expect(backend.callsTo("leave").length).toBeGreaterThan(0);
    expect(manager.connectedChannelId("guild")).toBeNull();
  });

  it("names a broken downloader instead of blaming the song", async () => {
    const { backend, guild, announce, manager } = setup();
    await joinVoice(manager, guild);
    await manager.enqueue("guild", [track("one")]);
    backend.playHandler = async () => {
      throw new SourceError(
        "The music downloader (**yt-dlp**) isn't ready on the bot's machine, so nothing can play right now.",
      );
    };

    await manager.startIfIdle("guild");

    const failure = announce.mock.calls.find(
      ([, embed]) => (embed as { title?: string }).title === "⚠️ Track failed",
    );
    expect(String((failure?.[1] as { description?: string }).description)).toMatch(/yt-dlp/);
    expect(backend.callsTo("play")).toHaveLength(1); // the track was handed over and the pipeline explained itself
    manager.teardown("guild", false);
  });

  it("reports a stream failure as a track failure, without a stack trace in chat", async () => {
    const { backend, guild, announce, manager } = setup();
    await joinVoice(manager, guild);
    await manager.enqueue("guild", [track("one"), track("two")]);
    await manager.startIfIdle("guild");

    backend.endTrack("guild", "failed", {
      trackId: "one",
      elapsedMs: 12_000,
      error:
        "That video is unavailable (removed, region-locked, or age-restricted without cookies).",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(titles(announce)).toContain("⚠️ Track failed");
    expect(descriptions(announce).join("\n")).toMatch(/not available|region-locked|unavailable/i);
    expect(manager.queue("guild").nowPlaying()?.id).toBe("two");
    manager.teardown("guild", false);
  });

  it("keeps the queue alive when the voice socket blinks but recovers", async () => {
    const { backend, guild, manager } = setup();
    await joinVoice(manager, guild);
    await manager.enqueue("guild", [track("one")]);
    await manager.startIfIdle("guild");

    // The backend only reports `voiceClosed` once recovery has failed, so a
    // surviving connection must not disturb the session at all.
    expect(manager.isPlayingSomewhere("guild")).toBe(true);
    expect(manager.queue("guild").nowPlaying()?.id).toBe("one");
    expect(backend.callsTo("leave")).toHaveLength(0);
    manager.teardown("guild", false);
  });
});
