import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Source resolution now runs entirely through the Lavalink node: links,
 * playlists and searches are one `GET /v4/loadtracks` call, and Spotify is
 * metadata-only until a track actually plays.
 *
 * Both edges are faked — the node (mocked `lavalink.js`) and Spotify's Web API
 * (a stubbed `fetch`) — so these tests assert *what we ask for* and *how the
 * answer is turned into tracks*, including the failure copy a user sees.
 */

const { loadTracks, LavalinkError } = vi.hoisted(() => {
  class FakeLavalinkError extends Error {
    constructor(
      message: string,
      readonly status?: number,
      readonly nodeName?: string,
    ) {
      super(message);
      this.name = "LavalinkError";
    }
  }
  return { loadTracks: vi.fn(), LavalinkError: FakeLavalinkError };
});

vi.mock("../src/music/lavalink.js", () => ({
  getLavalink: () => ({ loadTracks }),
  LavalinkError,
}));

/** A `/v4/loadtracks` track, the way Lavalink v4 shapes it. */
const spotifyTrackInfo = {
  identifier: "dQw4w9WgXcQ",
  isSeekable: true,
  author: "RickAstleyVEVO",
  length: 212_000,
  isStream: false,
  position: 0,
  title: "Never Gonna Give You Up",
  uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  artworkUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  isrc: null,
  sourceName: "youtube",
};

const nodeTrack = (overrides: Record<string, unknown> = {}, encoded = "encoded-track") => ({
  encoded,
  info: { ...spotifyTrackInfo, ...overrides },
  pluginInfo: {},
});

/** What the node answers for `GET /v4/loadtracks`. */
const search = (...tracks: unknown[]) => ({ loadType: "search", data: tracks });
const oneTrack = (track: unknown) => ({ loadType: "track", data: track });
const playlist = (name: string, tracks: unknown[], selectedTrack = -1) => ({
  loadType: "playlist",
  data: { info: { name, selectedTrack }, pluginInfo: {}, tracks },
});
const empty = { loadType: "empty", data: null };
const nodeError = (message: string, severity = "common") => ({
  loadType: "error",
  data: { message, severity, cause: "cause" },
});

const requestedBy = "user-1";
const requestedByName = "User";

async function sources() {
  return import("../src/music/sources.js");
}

/**
 * Stub Spotify's Web API. Routes are matched in declaration order against the
 * request URL, so list the more specific key (a paged `?offset=` link) first.
 */
function stubSpotify(routes: Record<string, unknown>, token = { access_token: "tok", expires_in: 3600 }) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("accounts.spotify.com/api/token")) {
      return { ok: true, status: 200, json: async () => token } as Response;
    }
    const match = Object.entries(routes).find(([key]) => url.includes(key));
    if (!match) return { ok: false, status: 404, json: async () => ({ error: "not found" }) } as unknown as Response;
    return { ok: true, status: 200, json: async () => match[1] } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const spotifyTrackPayload = {
  name: "Viti Ri Gon Kalaja",
  duration_ms: 253_000,
  external_urls: { spotify: "https://open.spotify.com/track/abc123abc123abc1" },
  album: { images: [{ url: "https://i.scdn.co/small.jpg" }, { url: "https://i.scdn.co/large.jpg" }] },
  artists: [{ name: "Muharrem Ahmeti" }],
};

beforeEach(() => {
  vi.resetModules();
  loadTracks.mockReset();
  process.env.SPOTIFY_CLIENT_ID = "client";
  process.env.SPOTIFY_CLIENT_SECRET = "secret";
  delete process.env.MUSIC_SEARCH_PREFIX;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;
  delete process.env.MUSIC_SEARCH_PREFIX;
});

describe("YouTube links", () => {
  it("loads a watch URL through the node and maps the track", async () => {
    loadTracks.mockResolvedValue(oneTrack(nodeTrack()));
    const { resolveQuery } = await sources();

    const result = await resolveQuery("https://www.youtube.com/watch?v=dQw4w9WgXcQ", requestedBy, requestedByName, 250);

    expect(loadTracks).toHaveBeenCalledWith("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result.kind).toBe("youtube-video");
    expect(result.origin).toBe("Never Gonna Give You Up");
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({
      title: "Never Gonna Give You Up",
      author: "RickAstleyVEVO",
      videoId: "dQw4w9WgXcQ",
      sourceKind: "youtube",
      sourceName: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      durationMs: 212_000,
      thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
      encoded: "encoded-track",
      requestedBy,
      requestedByName,
    });
    expect(result.tracks[0]!.id).toBeTruthy(); // a fresh internal id per queue entry
  });

  it("accepts youtu.be and Shorts links the same way", async () => {
    loadTracks.mockResolvedValue(oneTrack(nodeTrack()));
    const { resolveQuery } = await sources();

    await resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250);
    expect(loadTracks).toHaveBeenCalledWith("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    loadTracks.mockClear();
    await resolveQuery("https://www.youtube.com/shorts/dQw4w9WgXcQ", requestedBy, requestedByName, 250);
    expect(loadTracks).toHaveBeenCalledWith("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("refuses a live stream instead of queuing something with no end", async () => {
    loadTracks.mockResolvedValue(oneTrack(nodeTrack({ isStream: true, length: 0 })));
    const { resolveQuery, SourceError } = await sources();
    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(SourceError);
    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(/live stream/i);
  });

  it("explains an unavailable video", async () => {
    loadTracks.mockResolvedValue(empty);
    const { resolveQuery } = await sources();
    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(/unavailable/i);
  });

  it("passes the node's own reason on", async () => {
    loadTracks.mockResolvedValue(nodeError("This video is private"));
    const { resolveQuery } = await sources();
    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(/This video is private/);
  });

  it("names YouTube's IP block and points at the node, not at yt-dlp", async () => {
    loadTracks.mockResolvedValue(nodeError("Video returned by YouTube isn't what was requested"));
    const { resolveQuery } = await sources();
    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(/youtube-source plugin|IPv6 rotation/i);
  });
});

describe("playlists", () => {
  it("imports a playlist, capped, and reports what was left out", async () => {
    const tracks = Array.from({ length: 12 }, (_, i) => nodeTrack({ title: `Song ${i}`, identifier: `id${i}` }, `enc-${i}`));
    loadTracks.mockResolvedValue(playlist("My Mix", tracks));
    const { resolveQuery } = await sources();

    const result = await resolveQuery(
      "https://www.youtube.com/playlist?list=PL1234567890",
      requestedBy,
      requestedByName,
      10,
    );

    expect(loadTracks).toHaveBeenCalledWith("https://www.youtube.com/playlist?list=PL1234567890");
    expect(result.kind).toBe("youtube-playlist");
    expect(result.origin).toBe("My Mix");
    expect(result.tracks).toHaveLength(10);
    expect(result.skipped).toBe(2); // over the cap
    expect(result.tracks[0]!.encoded).toBe("enc-0");
  });

  it("counts unavailable playlist entries as skipped", async () => {
    loadTracks.mockResolvedValue(
      playlist("Mixed", [nodeTrack({}, "a"), nodeTrack({ isStream: true }, "b"), nodeTrack({}, "c")]),
    );
    const { resolveQuery } = await sources();
    const result = await resolveQuery("https://www.youtube.com/playlist?list=PL1234567890", requestedBy, requestedByName, 50);
    expect(result.tracks.map((t) => t.encoded)).toEqual(["a", "c"]);
    expect(result.skipped).toBe(1);
  });

  it("says so when a playlist has nothing playable", async () => {
    loadTracks.mockResolvedValue(playlist("Empty", []));
    const { resolveQuery } = await sources();
    await expect(resolveQuery("https://www.youtube.com/playlist?list=PL1234567890", requestedBy, requestedByName, 50))
      .rejects.toThrow(/no playable videos/i);
  });
});

describe("search", () => {
  it("searches YouTube on the node and takes the first playable result", async () => {
    loadTracks.mockResolvedValue(
      search(nodeTrack({ isStream: true, title: "A live thing" }, "live"), nodeTrack({ title: "The Song" }, "second")),
    );
    const { resolveQuery } = await sources();

    const result = await resolveQuery("the song", requestedBy, requestedByName, 250);

    expect(loadTracks).toHaveBeenCalledWith("ytsearch:the song");
    expect(result.kind).toBe("search");
    expect(result.tracks[0]!.encoded).toBe("second"); // the live one is skipped
  });

  it("honours MUSIC_SEARCH_PREFIX", async () => {
    process.env.MUSIC_SEARCH_PREFIX = "ytmsearch";
    loadTracks.mockResolvedValue(search(nodeTrack()));
    const { resolveQuery, searchPrefix } = await sources();
    expect(searchPrefix()).toBe("ytmsearch");
    await resolveQuery("the song", requestedBy, requestedByName, 250);
    expect(loadTracks).toHaveBeenCalledWith("ytmsearch:the song");
  });

  it("ignores a search prefix it doesn't know", async () => {
    process.env.MUSIC_SEARCH_PREFIX = "spsearch";
    const { searchPrefix } = await sources();
    expect(searchPrefix()).toBe("ytsearch");
  });

  it("says when nothing matched", async () => {
    loadTracks.mockResolvedValue(empty);
    const { resolveQuery } = await sources();
    await expect(resolveQuery("asdkjhaskjdh", requestedBy, requestedByName, 250)).rejects.toThrow(/No track matched/);
  });

  it("refuses an empty query", async () => {
    const { resolveQuery } = await sources();
    await expect(resolveQuery("   ", requestedBy, requestedByName, 250)).rejects.toThrow(/Tell me what to play/);
    expect(loadTracks).not.toHaveBeenCalled();
  });
});

describe("other sources the node can load", () => {
  it("plays a link the classifier doesn't know by handing it to the node", async () => {
    loadTracks.mockResolvedValue(
      oneTrack(nodeTrack({ title: "SoundCloud thing", sourceName: "soundcloud", uri: "https://soundcloud.com/x" }, "sc")),
    );
    const { resolveQuery } = await sources();

    const result = await resolveQuery("https://soundcloud.com/artist/track", requestedBy, requestedByName, 250);

    expect(loadTracks).toHaveBeenCalledWith("https://soundcloud.com/artist/track");
    expect(result.tracks[0]).toMatchObject({ sourceKind: "other", sourceName: "soundcloud", encoded: "sc" });
  });

  it("falls back to searching when the node can't load that link", async () => {
    loadTracks
      .mockResolvedValueOnce(empty) // direct load
      .mockResolvedValueOnce(search(nodeTrack({}, "searched"))); // …then as a search phrase
    const { resolveQuery } = await sources();

    const result = await resolveQuery("https://example.com/mystery", requestedBy, requestedByName, 250);

    expect(loadTracks.mock.calls).toEqual([
      ["https://example.com/mystery"],
      ["ytsearch:https://example.com/mystery"],
    ]);
    expect(result.tracks[0]!.encoded).toBe("searched");
  });
});

describe("Spotify", () => {
  it("queues a track as metadata, matched to YouTube only when it plays", async () => {
    stubSpotify({ "/tracks/abc123abc123abc1": spotifyTrackPayload });
    const { resolveQuery, ensurePlayable } = await sources();

    const result = await resolveQuery(
      "https://open.spotify.com/track/abc123abc123abc1",
      requestedBy,
      requestedByName,
      250,
    );

    // No node call at queue time — that's the whole point of the lazy match.
    expect(loadTracks).not.toHaveBeenCalled();
    expect(result.kind).toBe("spotify-track");
    expect(result.tracks[0]).toMatchObject({
      title: "Muharrem Ahmeti – Viti Ri Gon Kalaja",
      author: "Spotify",
      sourceKind: "spotify",
      url: "https://open.spotify.com/track/abc123abc123abc1",
      durationMs: 253_000,
      thumbnail: "https://i.scdn.co/large.jpg",
      youtubeSearch: "Muharrem Ahmeti – Viti Ri Gon Kalaja",
    });
    expect(result.tracks[0]!.encoded).toBeUndefined();

    loadTracks.mockResolvedValue(search(nodeTrack({ identifier: "matched", title: "Viti Ri" }, "enc-matched")));
    const playable = await ensurePlayable(result.tracks[0]!);
    expect(loadTracks).toHaveBeenCalledWith("ytsearch:Muharrem Ahmeti – Viti Ri Gon Kalaja");
    expect(playable.encoded).toBe("enc-matched");
    expect(playable.videoId).toBe("matched");
    // The user-facing link stays the Spotify one; only the audio is YouTube's.
    expect(playable.url).toBe("https://open.spotify.com/track/abc123abc123abc1");
  });

  it("keeps Spotify metadata when the node's match has none", async () => {
    stubSpotify({ "/tracks/abc123abc123abc1": spotifyTrackPayload });
    const { resolveQuery, ensurePlayable } = await sources();
    const result = await resolveQuery("spotify:track:abc123abc123abc1", requestedBy, requestedByName, 250);

    loadTracks.mockResolvedValue(
      search(nodeTrack({ identifier: "m", artworkUrl: null, length: 0, title: "Whatever" }, "enc")),
    );
    const playable = await ensurePlayable(result.tracks[0]!);
    expect(playable.durationMs).toBe(253_000); // Spotify's, not the node's 0
    expect(playable.thumbnail).toBe("https://i.scdn.co/large.jpg");
    expect(playable.title).toBe("Muharrem Ahmeti – Viti Ri Gon Kalaja");
  });

  it("imports a playlist page by page and counts unavailable tracks", async () => {
    stubSpotify({
      "offset=2": {
        items: [
          { ...spotifyTrackPayload, name: "Two", external_urls: { spotify: "https://open.spotify.com/track/two" } },
        ],
        next: null,
      },
      "/playlists/abc123abc123abc1": {
        name: "Albanian Classics",
        images: [{ url: "https://i.scdn.co/cover.jpg" }],
        tracks: {
          items: [
            { track: { ...spotifyTrackPayload, name: "One", external_urls: { spotify: "https://open.spotify.com/track/one" } } },
            { track: null }, // unavailable in this market
          ],
          next: "https://api.spotify.com/v1/playlists/abc123abc123abc1/tracks?offset=2",
        },
      },
    });
    const { resolveQuery } = await sources();

    const result = await resolveQuery(
      "https://open.spotify.com/playlist/abc123abc123abc1",
      requestedBy,
      requestedByName,
      250,
    );

    expect(result.origin).toBe("Albanian Classics");
    expect(result.tracks.map((t) => t.title)).toEqual(["Muharrem Ahmeti – One", "Muharrem Ahmeti – Two"]);
    expect(result.skipped).toBe(1);
    expect(loadTracks).not.toHaveBeenCalled();
  });

  it("says when Spotify isn't configured", async () => {
    delete process.env.SPOTIFY_CLIENT_ID;
    const { resolveQuery, spotifyConfigured } = await sources();
    expect(spotifyConfigured()).toBe(false);
    await expect(resolveQuery("https://open.spotify.com/track/abc123abc123abc1", requestedBy, requestedByName, 250))
      .rejects.toThrow(/SPOTIFY_CLIENT_ID/);
  });

  it("searches Spotify when the user asks for that source", async () => {
    stubSpotify({
      "/search": { tracks: { items: [spotifyTrackPayload] } },
    });
    const { resolveQuery } = await sources();

    const result = await resolveQuery("viti ri gon kalaja", requestedBy, requestedByName, 250, "spotify");

    expect(result.kind).toBe("spotify-track");
    expect(result.tracks[0]!.youtubeSearch).toBe("Muharrem Ahmeti – Viti Ri Gon Kalaja");
    expect(loadTracks).not.toHaveBeenCalled();
  });
});

describe("when the node is down", () => {
  it("blames the backend, not the song", async () => {
    loadTracks.mockRejectedValue(new LavalinkError("Couldn't reach the Lavalink node at localhost:2333 (ECONNREFUSED).", undefined, "node-1"));
    const { resolveQuery } = await sources();

    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(/music backend \(Lavalink\) isn't answering/);
    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(/LAVALINK_NODES/);
  });

  it("still refuses to play a track with nothing to play", async () => {
    const { ensurePlayable, SourceError } = await sources();
    await expect(ensurePlayable({ id: "x", title: "X" } as never)).rejects.toThrow(SourceError);
    await expect(ensurePlayable({ id: "x", title: "X" } as never)).rejects.toThrow(/don't know how to play/);
  });

});

describe("limits", () => {
  it("reads queue and playlist caps from the environment", async () => {
    process.env.MUSIC_MAX_QUEUE = "42";
    process.env.MUSIC_MAX_PLAYLIST_TRACKS = "7";
    const { musicLimits } = await sources();
    expect(musicLimits()).toEqual({ maxQueue: 42, maxPlaylistTracks: 7 });

    delete process.env.MUSIC_MAX_QUEUE;
    delete process.env.MUSIC_MAX_PLAYLIST_TRACKS;
    expect(musicLimits()).toEqual({ maxQueue: 500, maxPlaylistTracks: 250 });
  });
});
