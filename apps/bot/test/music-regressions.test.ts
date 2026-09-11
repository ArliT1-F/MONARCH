import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { MusicQueue, type Track } from "@monarch/music";
import { evaluatePlayer } from "../src/music/javascript.js";

vi.mock("../src/music/sources.js", async (original) => ({
  ...await original<typeof import("../src/music/sources.js")>(),
  resolveQuery: vi.fn(),
  audioStreamFor: vi.fn(),
}));
vi.mock("../src/music/ffmpeg.js", () => ({ resolveFfmpeg: vi.fn() }));
import { audioStreamFor, resolveQuery, SourceError } from "../src/music/sources.js";
import { handleMusicCommand } from "../src/music/commands.js";
import { MusicManager } from "../src/music/player.js";
import type { Client, ChatInputCommandInteraction } from "discord.js";

const track = (id: string) => ({ id, title: id, videoId: id, requestedBy: "user" }) as Track;
afterEach(() => vi.clearAllMocks());

describe("music failure regressions", () => {
  it("edits the deferred reply with the original Spotify error", async () => {
    const channel = { id: "voice", permissionsFor: () => ({ has: () => true }) };
    const interaction = {
      inCachedGuild: () => true,
      guildId: "guild", channelId: "text",
      guild: { members: { me: {}, }, channels: { cache: new Map() } },
      member: { voice: { channel } }, user: { id: "user", displayName: "User" },
      options: { getSubcommand: () => "play", getString: () => "spotify link" },
      deferred: false, replied: false,
      deferReply: vi.fn(async () => { interaction.deferred = true; }),
      editReply: vi.fn(), reply: vi.fn(),
    };
    const manager = { connectedChannelId: () => null, setAnnouncementChannel: vi.fn(), connect: vi.fn() };
    vi.mocked(resolveQuery).mockRejectedValue(new SourceError("Spotify links are not configured"));
    await handleMusicCommand(interaction as unknown as ChatInputCommandInteraction, manager as unknown as MusicManager);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "⚠️ Spotify links are not configured" });
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it.each(["off", "track", "queue"] as const)("drains failed tracks without getting stuck in %s loop", async (mode) => {
    const announce = vi.fn();
    const manager = new MusicManager({} as Client, announce);
    manager.queue("guild").setLoop(mode);
    await manager.enqueue("guild", [track("one"), track("two")]);
    vi.mocked(audioStreamFor).mockRejectedValue(new SourceError("Unavailable"));
    await manager.startIfIdle("guild");
    expect(audioStreamFor).toHaveBeenCalledTimes(2);
    expect(manager.queue("guild").isEmpty).toBe(true);
    manager.teardown("guild", false);
  });

  it("does not start a resolved stream after stop", async () => {
    const manager = new MusicManager({} as Client, vi.fn());
    let resolve!: (stream: Readable) => void;
    vi.mocked(audioStreamFor).mockReturnValue(new Promise((r) => { resolve = r; }));
    await manager.enqueue("guild", [track("one")]);
    const pending = manager.startIfIdle("guild");
    manager.teardown("guild", false);
    const stream = new Readable({ read() {} });
    resolve(stream);
    await pending;
    expect(stream.destroyed).toBe(true);
  });

  it("can skip a failed current track without changing the loop setting", () => {
    const queue = new MusicQueue();
    queue.addMany([track("one"), track("two")]);
    queue.next();
    queue.setLoop("track");
    expect(queue.next(true)?.id).toBe("two");
    expect(queue.loopMode).toBe("track");
  });
});

describe("isolated player evaluator", () => {
  it("returns decipher results without exposing Node globals", async () => {
    expect(await evaluatePlayer({ output: '({sig: "decoded", node: typeof process, files: typeof require})' }))
      .toEqual({ sig: "decoded", node: "undefined", files: "undefined" });
  });
  it("interrupts runaway code", async () => {
    await expect(evaluatePlayer({ output: "while (true) {}" })).rejects.toThrow("evaluation failed");
  });
});
