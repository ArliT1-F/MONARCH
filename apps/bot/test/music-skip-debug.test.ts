import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import type { Track } from "@monarch/music";

/**
 * The two things users noticed by hand:
 *
 * 1. A skip must drop **one** track. Not the playlist, not nothing — exactly
 *    the track it was aimed at, whether that track is playing or still being
 *    prepared (a Spotify match, a slow voice join).
 * 2. `/monarch debug on` is the owner's window into failures: with it on, the
 *    raw error (yt-dlp's own words) is posted next to the human-readable one;
 *    with it off — the default — nothing but the tidy line appears.
 */

vi.mock("../src/music/sources.js", async (original) => ({
  ...(await original<typeof import("../src/music/sources.js")>()),
  ensurePlayable: vi.fn(async (track: Track) => track),
  resolveQuery: vi.fn(),
}));

import { ensurePlayable, SourceError } from "../src/music/sources.js";
import { MusicManager } from "../src/music/player.js";
import { YtdlpError } from "../src/music/ytdlp.js";
import { DebugFlags, clampDebugText, type DebugReporter } from "../src/debug.js";
import { BurgRegistry } from "../src/burg.js";
import { ConfessionRegistry } from "../src/confession.js";
import { PrefixRegistry } from "../src/prefix/registry.js";
import { MonarchCommands } from "../src/monarch-commands.js";
import { SlashCommandContext } from "../src/slash-context.js";
import { FakeAudioBackend, fakeClient, fakeGuild, fakeVoiceChannel } from "./music-fakes.js";

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

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const played = (backend: FakeAudioBackend) =>
  backend.callsTo("play").map((call) => (call.args[1] as Track).id);

function setup(debug?: DebugReporter) {
  const backend = new FakeAudioBackend();
  const guild = fakeGuild("guild");
  const announce = vi.fn();
  const manager = new MusicManager(fakeClient(guild), announce, undefined, backend, debug);
  return { backend, guild, announce, manager };
}

beforeEach(() => {
  vi.mocked(ensurePlayable).mockImplementation(async (t: Track) => t);
});

describe("skip drops exactly one track", () => {
  it("advances one track and leaves the rest of the queue alone", async () => {
    const { backend, guild, manager } = setup();
    await manager.connect("guild", fakeVoiceChannel("voice", guild));
    await manager.enqueue("guild", [track("a"), track("b"), track("c")]);
    await manager.startIfIdle("guild");
    expect(played(backend)).toEqual(["a"]);

    expect(manager.skip("guild")).toBe(true);
    backend.endTrack("guild", "stopped", { trackId: "a" }); // the backend answering the stop
    await tick();

    expect(played(backend)).toEqual(["a", "b"]);
    expect(manager.queue("guild").size).toBe(1); // c is still queued
    expect(manager.queue("guild").nowPlaying()?.id).toBe("b");
  });

  it("drops a track a skip landed on while it was still being resolved", async () => {
    const { backend, guild, manager } = setup();
    await manager.connect("guild", fakeVoiceChannel("voice", guild));
    await manager.enqueue("guild", [track("a"), track("b"), track("c")]);

    // b is a Spotify track: resolving it takes a while (a search, a download
    // probe). The second skip arrives in that window.
    let release!: (value: Track) => void;
    const gate = new Promise<Track>((resolve) => {
      release = resolve;
    });
    vi.mocked(ensurePlayable).mockImplementation(async (t: Track) => (t.id === "b" ? gate : t));

    await manager.startIfIdle("guild");
    manager.skip("guild"); // skip a
    backend.endTrack("guild", "stopped", { trackId: "a" });
    await tick();

    expect(manager.skip("guild")).toBe(true); // b is not playing yet — the skip waits
    release(track("b"));
    await tick();

    expect(played(backend)).toEqual(["a", "c"]); // b was skipped, not played
    expect(manager.queue("guild").size).toBe(0);
  });

  it("never replays the skipped track, whatever the loop mode says", async () => {
    const { backend, guild, manager } = setup();
    await manager.connect("guild", fakeVoiceChannel("voice", guild));
    manager.queue("guild").setLoop("track");
    await manager.enqueue("guild", [track("a"), track("b")]);
    await manager.startIfIdle("guild");

    manager.skip("guild");
    backend.endTrack("guild", "stopped", { trackId: "a" });
    await tick();

    expect(played(backend)).toEqual(["a", "b"]); // the loop must not resurrect a
    expect(manager.queue("guild").nowPlaying()?.id).toBe("b");
  });
});

describe("the debug switch", () => {
  it("is off until the owner turns it on", () => {
    const flags = new DebugFlags();
    expect(flags.enabled).toBe(false);
    expect(flags.set(true)).toBe(true);
    expect(flags.enabled).toBe(true);
    expect(flags.toggle()).toBe(false);
    expect(flags.enabled).toBe(false);
  });

  it("posts the raw error only while it is on", async () => {
    const raw = "ffmpeg exited with code 1\n[libopus @ 0x55] invalid stream";
    const fail = async (debug: DebugReporter) => {
      const { backend, guild, manager, announce } = setup(debug);
      await manager.connect("guild", fakeVoiceChannel("voice", guild));
      await manager.enqueue("guild", [track("a")]);
      await manager.startIfIdle("guild");
      backend.endTrack("guild", "failed", {
        trackId: "a",
        error: "The audio transcoder (ffmpeg) failed on this track.",
        raw,
      });
      await tick();
      return announce;
    };

    const post = vi.fn();
    const announce = await fail({ enabled: () => true, post });
    expect(post).toHaveBeenCalledTimes(1);
    expect(String(post.mock.calls[0]![1])).toContain("invalid stream");
    // The tidy line still goes out either way.
    expect((announce.mock.calls.at(-1)?.[1] as { title?: string }).title).toBe("⚠️ Track failed");

    const quiet = vi.fn();
    await fail({ enabled: () => false, post: quiet });
    expect(quiet).not.toHaveBeenCalled();
  });

  it("hands the resolver's original error to the reporter", () => {
    const post = vi.fn();
    const { manager } = setup({ enabled: () => true, post });

    manager.reportDebug("guild", new YtdlpError("the downloader couldn't reach the source", "ERROR: TLS EOF"));

    expect(post).toHaveBeenCalledWith("guild", expect.stringContaining("ERROR: TLS EOF"));
  });

  it("stays quiet with the switch off", () => {
    const post = vi.fn();
    const { manager } = setup({ enabled: () => false, post });
    manager.reportDebug("guild", new SourceError("nothing matched"));
    expect(post).not.toHaveBeenCalled();
  });

  it("clamps over-long detail, keeping the newest lines", () => {
    const long = `${"old line\n".repeat(400)}LAST LINE`;
    const clamped = clampDebugText(long, 100);
    expect(clamped.length).toBeLessThanOrEqual(102); // "…\n" + max
    expect(clamped.endsWith("LAST LINE")).toBe(true);
  });
});

describe("/monarch debug", () => {
  const interactionFor = (userId: string, state?: string) =>
    ({
      inCachedGuild: () => true,
      guildId: "guild",
      channelId: "text",
      guild: { members: { me: {} }, channels: { cache: new Map() } },
      member: {},
      user: { id: userId, displayName: "User" },
      options: {
        getSubcommand: () => "debug",
        getString: (name: string) => (name === "state" ? state ?? null : null),
      },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    }) as unknown as ChatInputCommandInteraction<"cached">;

  function commands(ownerUserId: string | null, flags = new DebugFlags()) {
    return new MonarchCommands({
      appUrl: "https://monarch.example",
      burg: new BurgRegistry(),
      prefixes: new PrefixRegistry(),
      confessions: new ConfessionRegistry(),
      burgEnabled: () => true,
      ownerUserId,
      debug: flags,
      log: { info: vi.fn(), warn: vi.fn() },
    });
  }

  const said = (interaction: ChatInputCommandInteraction<"cached">) => {
    const last = vi.mocked(interaction.reply).mock.calls.at(-1)?.[0];
    if (typeof last === "string") return last;
    return String((last as { content?: string } | undefined)?.content ?? "");
  };

  it("lets the owner turn it on and off", async () => {
    const flags = new DebugFlags();
    const monarch = commands("owner", flags);

    const on = interactionFor("owner", "on");
    await monarch.run(new SlashCommandContext(on, "!"), "debug");
    expect(flags.enabled).toBe(true);
    expect(said(on)).toContain("Debug on");

    const off = interactionFor("owner", "off");
    await monarch.run(new SlashCommandContext(off, "!"), "debug");
    expect(flags.enabled).toBe(false);
    expect(said(off)).toContain("Debug off");
  });

  it("reports the current state when asked nothing", async () => {
    const flags = new DebugFlags();
    flags.set(true);
    const interaction = interactionFor("owner");
    await commands("owner", flags).run(new SlashCommandContext(interaction, "!"), "debug");
    expect(said(interaction)).toContain("Debug is on");
  });

  it("refuses everyone who is not the owner — without leaking the state", async () => {
    const flags = new DebugFlags();
    const interaction = interactionFor("someone-else", "on");
    await commands("owner", flags).run(new SlashCommandContext(interaction, "!"), "debug");

    expect(flags.enabled).toBe(false);
    expect(said(interaction)).toContain("reserved for the bot's owner");
    expect(said(interaction)).not.toContain("Debug on");
  });

  it("refuses politely when no owner is configured", async () => {
    const interaction = interactionFor("anyone", "on");
    await commands(null).run(new SlashCommandContext(interaction, "!"), "debug");
    expect(said(interaction)).toContain("reserved for the bot's owner");
  });

  it("says what it accepts when the state is nonsense", async () => {
    const interaction = interactionFor("owner", "maybe");
    const flags = new DebugFlags();
    await commands("owner", flags).run(new SlashCommandContext(interaction, "!"), "debug");
    expect(flags.enabled).toBe(false);
    expect(said(interaction)).toContain("isn't a state I know");
  });
});
