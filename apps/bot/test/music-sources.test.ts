import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { getBasicInfo, create, platform } = vi.hoisted(() => ({
  getBasicInfo: vi.fn(), create: vi.fn(), platform: { shim: { eval: undefined as unknown } },
}));
vi.mock("youtubei.js", () => ({ Innertube: { create }, Platform: platform }));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // Keep the extractor tests deterministic; the preferred-path tests opt back
  // in with a temporary fake binary below.
  process.env.YTDLP_DISABLED = "1";
  create.mockResolvedValue({ getBasicInfo });
});
afterEach(() => {
  delete process.env.YOUTUBE_CLIENTS;
  delete process.env.YOUTUBE_PO_TOKEN;
  delete process.env.YTDLP_DISABLED;
  delete process.env.YTDLP_PATH;
  delete process.env.YTDLP_PREFER;
  delete process.env.YTDLP_COOKIES;
});

async function fakeYtdlp(scriptBody: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "monarch-ytdlp-"));
  const binary = join(directory, "yt-dlp");
  await writeFile(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo test; exit 0; fi\n${scriptBody}\n`);
  await chmod(binary, 0o755);
  delete process.env.YTDLP_DISABLED;
  process.env.YTDLP_PATH = binary;
  return directory;
}

it("falls back to InnerTube when preferred yt-dlp exits without audio", async () => {
  const directory = await fakeYtdlp("echo 'cookie file not found' >&2; exit 1");
  try {
    process.env.YTDLP_PREFER = "1";
    process.env.YOUTUBE_CLIENTS = "TV";
    const download = vi.fn().mockResolvedValue(new ReadableStream({ start(c) { c.close(); } }));
    getBasicInfo.mockResolvedValue({
      streaming_data: {
        adaptive_formats: [{ has_audio: true, has_video: false, bitrate: 128, url: "https://example.com/audio", itag: 140 }],
      },
      download,
    });
    const { youtubeAudioStream } = await import("../src/music/sources.js");
    const stream = await youtubeAudioStream("video");
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ itag: 140 }));
    stream.destroy();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not hand an empty preferred yt-dlp pipe to the player", async () => {
  const directory = await fakeYtdlp("exit 0");
  try {
    process.env.YTDLP_PREFER = "1";
    process.env.YOUTUBE_CLIENTS = "TV";
    getBasicInfo.mockResolvedValue({ playability_status: { status: "LOGIN_REQUIRED" } });
    const { youtubeAudioStream } = await import("../src/music/sources.js");
    await expect(youtubeAudioStream("video")).rejects.toThrow("YouTube requires login");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("falls back from URL-less formats and downloads a usable audio format", async () => {
  process.env.YOUTUBE_CLIENTS = "ANDROID,WEB";
  const download = vi.fn().mockResolvedValue(new ReadableStream({ start(c) { c.close(); } }));
  getBasicInfo.mockResolvedValueOnce({ streaming_data: { adaptive_formats: [{ has_audio: true, bitrate: 999 }] } })
    .mockResolvedValueOnce({ streaming_data: { adaptive_formats: [
      { has_audio: true, has_video: false, bitrate: 128, url: "https://example.com/audio", itag: 140 },
    ] }, download });
  const { youtubeAudioStream } = await import("../src/music/sources.js");
  const stream = await youtubeAudioStream("video");
  expect(getBasicInfo.mock.calls).toEqual([["video", { client: "ANDROID" }], ["video", { client: "WEB" }]]);
  expect(download).toHaveBeenCalledWith(expect.objectContaining({ itag: 140 }));
  expect(platform.shim.eval).toBeTypeOf("function");
  stream.destroy();
});
it("tries non-SABR clients before WEB by default", async () => {
  const download = vi.fn().mockResolvedValue(new ReadableStream({ start(c) { c.close(); } }));
  getBasicInfo.mockResolvedValue({ streaming_data: { adaptive_formats: [
    { has_audio: true, has_video: false, bitrate: 128, url: "https://example.com/audio", itag: 140 },
  ] }, download });
  const { youtubeAudioStream } = await import("../src/music/sources.js");
  const stream = await youtubeAudioStream("video");
  // TV first (the most reliable plain-URL client); WEB last (often SABR-only).
  expect(getBasicInfo.mock.calls[0]).toEqual(["video", { client: "TV" }]);
  stream.destroy();
});
it("honours a YOUTUBE_CLIENTS override", async () => {
  process.env.YOUTUBE_CLIENTS = " android,,WEB,ANDROID ";
  const { youtubeClients } = await import("../src/music/sources.js");
  expect(youtubeClients()).toEqual(["ANDROID", "WEB"]);
});
it("falls back to a progressive video+audio file when no audio-only format exists", async () => {
  process.env.YOUTUBE_CLIENTS = "TV";
  const download = vi.fn().mockResolvedValue(new ReadableStream({ start(c) { c.close(); } }));
  getBasicInfo.mockResolvedValue({
    streaming_data: {
      adaptive_formats: [{ has_audio: false, has_video: true, bitrate: 1000, url: "https://example.com/video", itag: 137 }],
      formats: [{ has_audio: true, has_video: true, bitrate: 96, url: "https://example.com/av", itag: 18 }],
    },
    download,
  });
  const { youtubeAudioStream } = await import("../src/music/sources.js");
  const stream = await youtubeAudioStream("video");
  expect(download).toHaveBeenCalledWith(expect.objectContaining({ itag: 18 }));
  stream.destroy();
});
it("explains login restrictions instead of masking them", async () => {
  process.env.YTDLP_DISABLED = "1";
  getBasicInfo.mockResolvedValue({ playability_status: { status: "LOGIN_REQUIRED" } });
  const { youtubeAudioStream } = await import("../src/music/sources.js");
  await expect(youtubeAudioStream("video")).rejects.toThrow("YouTube requires login");
});
it("names SABR-only answers and points at the yt-dlp fallback", async () => {
  process.env.YOUTUBE_CLIENTS = "WEB";
  process.env.YTDLP_DISABLED = "1";
  getBasicInfo.mockResolvedValue({
    playability_status: { status: "OK" },
    streaming_data: {
      adaptive_formats: [{ has_audio: true, has_video: false, bitrate: 128, itag: 251 }],
      formats: [],
      server_abr_streaming_url: "https://www.youtube.com/sabr",
    },
  });
  const { youtubeAudioStream } = await import("../src/music/sources.js");
  await expect(youtubeAudioStream("video")).rejects.toThrow(/SABR.*yt-dlp/s);
});
it("retries session initialization after a transient failure", async () => {
  create.mockRejectedValueOnce(new Error("network"));
  const { getYoutube } = await import("../src/music/sources.js");
  await expect(getYoutube()).rejects.toThrow("network");
  await expect(getYoutube()).resolves.toEqual({ getBasicInfo });
  expect(create).toHaveBeenCalledTimes(2);
});
