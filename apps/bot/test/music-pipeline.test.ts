import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AudioPlayerStatus, VoiceConnectionStatus } from "@discordjs/voice";
import type { Track } from "@monarch/music";
import { DiscordAudioBackend, type AudioBackendOptions } from "../src/music/audio.js";
import { ytdlpCapabilityArgs, ytdlpCommonArgs, ytdlpExtraArgs, resetYtdlpCapabilities } from "../src/music/ytdlp.js";

/**
 * The parts of the audio path that only show up when YouTube is being difficult:
 * the flags yt-dlp is given, and what happens to a track that dies before it
 * plays a single note.
 */

// ── yt-dlp invocation ────────────────────────────────────────────────────────

describe("yt-dlp invocation", () => {
  it("asks for the audio in small chunks, so a throttled connection starts over instead of crawling", () => {
    const args = ytdlpCommonArgs();
    expect(args).toContain("--http-chunk-size");
    expect(args[args.indexOf("--http-chunk-size") + 1]).toBe("16384");
  });

  it("retries the download and the extraction", () => {
    const args = ytdlpCommonArgs();
    expect(args.join(" ")).toContain("--retries 5");
    expect(args.join(" ")).toContain("--fragment-retries 5");
    expect(args.join(" ")).toContain("--extractor-retries 2");
  });

  it("keeps quoted YTDLP_ARGS together", () => {
    expect(ytdlpExtraArgs('--extractor-args "youtube:player_client=tv,web"')).toEqual([
      "--extractor-args",
      "youtube:player_client=tv,web",
    ]);
    expect(ytdlpExtraArgs("--no-check-certificates --throttled-rate 100K")).toEqual([
      "--no-check-certificates",
      "--throttled-rate",
      "100K",
    ]);
    expect(ytdlpExtraArgs("")).toEqual([]);
  });
});

// ── capability detection ─────────────────────────────────────────────────────

describe("binary capabilities", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "monarch-ytdlp-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A stand-in yt-dlp whose `--help` says whatever we want it to. */
  function fakeBinary(help: string): string {
    const file = path.join(dir, `yt-dlp-${Math.random().toString(36).slice(2, 8)}`);
    writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--help" ]; then\n  echo "${help}"\n  exit 0\nfi\nexit 1\n`);
    chmodSync(file, 0o755);
    return file;
  }

  const itOrSkip = process.platform === "win32" ? it.skip : it;

  itOrSkip("hands yt-dlp this very Node when its build supports --js-runtimes", async () => {
    resetYtdlpCapabilities();
    const args = await ytdlpCapabilityArgs(fakeBinary("  --js-runtimes RUNTIME[:PATH]  Additional JavaScript runtime"));
    expect(args).toEqual(["--js-runtimes", `node:${process.execPath}`]);
  });

  itOrSkip("stays quiet for an old build that has never heard of a JS runtime", async () => {
    resetYtdlpCapabilities();
    expect(await ytdlpCapabilityArgs(fakeBinary("  --no-check-certificate  Suppress certificate verification"))).toEqual([]);
  });
});

// ── a track that dies before it starts ───────────────────────────────────────

class FakePlayer extends EventEmitter {
  state: { status: AudioPlayerStatus } = { status: AudioPlayerStatus.Idle };
  resources: unknown[] = [];

  play(resource: unknown): void {
    this.resources.push(resource);
    this.state = { status: AudioPlayerStatus.Playing };
  }

  stop(): void {
    this.state = { status: AudioPlayerStatus.Idle };
  }

  pause(): void {
    this.state = { status: AudioPlayerStatus.Paused };
  }

  unpause(): void {
    this.state = { status: AudioPlayerStatus.Playing };
  }

  /** What @discordjs/voice does when the stream runs out or dies. */
  emitIdle(): void {
    const previous = this.state;
    this.state = { status: AudioPlayerStatus.Idle };
    this.emit("stateChange", previous, this.state);
  }
}

class FakeConnection extends EventEmitter {
  state = { status: VoiceConnectionStatus.Ready };
  joinConfig = { channelId: "chan", guildId: "guild" };

  subscribe(): void {}
  destroy(): void {
    this.state = { status: VoiceConnectionStatus.Destroyed };
  }
}

/** A yt-dlp pipe that has already come and gone, with the exit code we want. */
function deadPipe(code: number, stderr: string) {
  const exit = { code, stderr, signaled: false };
  return {
    stream: Readable.from([Buffer.alloc(0)]),
    kill: vi.fn(),
    alive: () => false,
    result: () => exit,
    exited: Promise.resolve(exit),
  };
}

function track(): Track {
  return {
    id: "t1",
    title: "Throttle me",
    author: "artist",
    videoId: "v1",
    sourceKind: "other",
    sourceName: "yt-dlp",
    sourceUrl: "https://www.youtube.com/watch?v=v1",
    url: "https://www.youtube.com/watch?v=v1",
    durationMs: 300_000,
    requestedBy: "u1",
    requestedByName: "Tester",
    thumbnail: null,
  } as Track;
}

/** A backend wired to fakes: no sockets, no spawned processes. */
function harness(pipes: ReturnType<typeof deadPipe>[]) {
  const player = new FakePlayer();
  const openPipe = vi.fn(async () => {
    const next = pipes.shift();
    if (!next) throw new Error("openPipe called more often than the test expected");
    return next;
  });
  const spawnFfmpeg = vi.fn(() => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout: Readable.from([Buffer.alloc(64)]),
      stderr,
      kill: vi.fn(),
    });
    stdin.on("error", () => {});
    return child as never;
  });
  const options: AudioBackendOptions = {
    pipeline: "pcm",
    openPipe,
    spawnFfmpeg,
    createPlayer: () => player as never,
    joinConnection: () => new FakeConnection() as never,
  };
  const backend = new DiscordAudioBackend(options);
  const events: { reason: string; error?: string; elapsedMs: number }[] = [];
  backend.on("trackEnd", (event: { reason: string; error?: string; elapsedMs: number }) => events.push(event));
  return { backend, player, openPipe, events };
}

describe("a track that never gets going", () => {
  it("is started again once, silently, before the queue hears about it", async () => {
    const { backend, player, openPipe, events } = harness([
      deadPipe(1, "ERROR: unable to download webpage: <urlopen error timed out>"),
      deadPipe(1, "ERROR: unable to download webpage: <urlopen error timed out>"),
    ]);
    await backend.join("guild", { id: "chan", guild: { id: "guild", voiceAdapterCreator: () => () => {} } });
    await backend.play("guild", track());

    player.emitIdle(); // yt-dlp died immediately
    await vi.waitFor(() => expect(player.resources.length).toBe(2));

    // The retry owns the guild again and the queue has been told nothing.
    expect(events).toEqual([]);
    expect(openPipe).toHaveBeenCalledTimes(2);

    player.emitIdle(); // the retry died too → now it is a real failure
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.reason).toBe("failed");
    expect(events[0]?.error).toMatch(/couldn't reach the source/i);
    expect(openPipe).toHaveBeenCalledTimes(2);
  });

  it("does not retry a track that says why it can't play", async () => {
    const { backend, player, openPipe, events } = harness([deadPipe(1, "ERROR: Private video. Sign in if you've been granted access")]);
    await backend.join("guild", { id: "chan", guild: { id: "guild", voiceAdapterCreator: () => () => {} } });
    await backend.play("guild", track());

    player.emitIdle();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.reason).toBe("failed");
    expect(events[0]?.error).toMatch(/private/i);
    expect(openPipe).toHaveBeenCalledTimes(1);
  });
});
