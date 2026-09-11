import { describe, expect, it } from "vitest";
import { classifySource } from "../src/resolve.js";

describe("classifySource", () => {
  it("classifies YouTube watch links", () => {
    const q = classifySource("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(q.kind).toBe("youtube-video");
    expect(q.id).toBe("dQw4w9WgXcQ");
    expect(q.playlistId).toBeUndefined();
  });

  it("keeps a playlist attached to a watch link", () => {
    const q = classifySource("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ");
    expect(q.kind).toBe("youtube-video");
    expect(q.id).toBe("dQw4w9WgXcQ");
    expect(q.playlistId).toBe("RDdQw4w9WgXcQ");
  });

  it("classifies youtu.be links and Shorts", () => {
    expect(classifySource("https://youtu.be/dQw4w9WgXcQ?t=42").kind).toBe("youtube-video");
    expect(classifySource("https://youtu.be/dQw4w9WgXcQ").id).toBe("dQw4w9WgXcQ");
    expect(classifySource("https://www.youtube.com/shorts/abcdefghijk").id).toBe("abcdefghijk");
    expect(classifySource("https://www.youtube.com/live/abcdefghijk").kind).toBe("youtube-video");
  });

  it("classifies YouTube playlists", () => {
    const q = classifySource("youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI");
    expect(q.kind).toBe("youtube-playlist");
    expect(q.id).toBe("PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI");
  });

  it("classifies Spotify links and URIs", () => {
    const link = classifySource("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc");
    expect(link.kind).toBe("spotify-track");
    expect(link.id).toBe("4uLU6hMCjMI75M1A2tKUQC");

    const intl = classifySource("open.spotify.com/intl-de/album/1DFixLWuPkv3KT3TnV35m3");
    expect(intl.kind).toBe("spotify-album");
    expect(intl.id).toBe("1DFixLWuPkv3KT3TnV35m3");

    const uri = classifySource("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M");
    expect(uri.kind).toBe("spotify-playlist");
    expect(uri.id).toBe("37i9dQZF1DXcBWIGoYBM5M");
  });

  it("treats everything else as a search query", () => {
    expect(classifySource("daft punk around the world")).toEqual({
      kind: "search",
      query: "daft punk around the world",
    });
    expect(classifySource("").kind).toBe("search");
    expect(classifySource("https://example.com/song").kind).toBe("search");
    expect(classifySource("https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk").kind).toBe("search");
  });

  it("does not crash on malformed links", () => {
    expect(classifySource("https://www.youtube.com/watch").kind).toBe("search");
    expect(classifySource("https://youtu.be/").kind).toBe("search");
    expect(classifySource("https://www.youtube.com/playlist").kind).toBe("search");
  });
});