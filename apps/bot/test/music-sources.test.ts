import { beforeEach, expect, it, vi } from "vitest";
const { getBasicInfo, create, platform } = vi.hoisted(() => ({
  getBasicInfo: vi.fn(), create: vi.fn(), platform: { shim: { eval: undefined as unknown } },
}));
vi.mock("youtubei.js", () => ({ Innertube: { create }, Platform: platform }));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  create.mockResolvedValue({ getBasicInfo });
});
it("falls back from URL-less formats and downloads a usable audio format", async () => {
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
it("explains login restrictions instead of masking them", async () => {
  getBasicInfo.mockResolvedValue({ playability_status: { status: "LOGIN_REQUIRED" } });
  const { youtubeAudioStream } = await import("../src/music/sources.js");
  await expect(youtubeAudioStream("video")).rejects.toThrow("YouTube requires login");
});
it("retries session initialization after a transient failure", async () => {
  create.mockRejectedValueOnce(new Error("network"));
  const { getYoutube } = await import("../src/music/sources.js");
  await expect(getYoutube()).rejects.toThrow("network");
  await expect(getYoutube()).resolves.toEqual({ getBasicInfo });
  expect(create).toHaveBeenCalledTimes(2);
});
