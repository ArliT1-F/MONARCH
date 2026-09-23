import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Source resolution, which now runs entirely through **yt-dlp**: links,
 * playlists and searches are `yt-dlp -J` calls, and Spotify is metadata-only
 * until a track actually plays.
 *
 * Both edges are faked — the downloader (mocked `ytdlp.js`) and Spotify's Web
 * API (a stubbed `fetch`) — so these tests assert *what we ask for* and *how
 * the answer is turned into tracks*, including the failure copy a user sees.
 */

const { ytdlpJson, ytdlpSearch, ytdlpPlaylist, ensureYtdlp, YtdlpError } = vi.hoisted(() => {
  class FakeYtdlpError extends Error {
    constructor(
      message: string,
      readonly stderr = "",
    ) {
      super(message);
      this.name = "YtdlpError";
    }
  }
  return {
    ytdlpJson: vi.fn(),
    ytdlpSearch: vi.fn(),
    ytdlpPlaylist: vi.fn(),
    ensureYtdlp: vi.fn(),
    YtdlpError: FakeYtdlpError,
  };
});

vi.mock("../src/music/ytdlp.js", async (original) => ({
  ...await original<typeof import("../src/music/ytdlp.js")>(),
  ytdlpJson,
  ytdlpSearch,
  ytdlpPlaylist,
  ensureYtdlp,
  YtdlpError,
}));

/** A `yt-dlp -J` entry, the way the downloader shapes it. */
const entry = (overrides: Record<string, unknown> = {}) => ({
  id: "dQw4w9WgXcQ",
  title: "Never Gonna Give You Up",
  duration: 212,
  uploader: "RickAstleyVEVO",
  webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  extractor: "youtube",
  ie_key: "Youtube",
  is_live: false,
  live_status: "not_live",
  ...overrides,
});

// The mock above spreads the real module, so the pure helpers stay testable.
import { normalizeSearchKey, searchFailure, searchTarget } from "../src/music/ytdlp.js";
import { searchLabel } from "../src/music/sources.js";

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

/**
 * Stub Spotify's API *and* its public embed page (the iframe player's HTML,
 * which carries a playlist's tracks as JSON). `embed` null means the embed page
 * is gone too — what a private playlist looks like.
 */
function stubSpotifyAndEmbed(api: Record<string, unknown>, embed: string | null) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("accounts.spotify.com/api/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) } as Response;
    }
    if (url.includes("open.spotify.com/embed/")) {
      if (embed === null) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      return { ok: true, status: 200, text: async () => embed } as Response;
    }
    const match = Object.entries(api).find(([key]) => url.includes(key));
    if (!match) return { ok: false, status: 404, json: async () => ({ error: "not found" }) } as unknown as Response;
    return { ok: true, status: 200, json: async () => match[1] } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The embed page for a playlist, in the shape Spotify's web app ships it. */
function embedPlaylistHtml(
  name: string,
  tracks: { uri?: string; id: string; title: string; subtitle: string; duration: number }[],
): string {
  const payload = {
    props: {
      pageProps: {
        state: {
          data: {
            entity: {
              type: "playlist",
              name,
              trackList: tracks.map((track) => ({
                uri: track.uri ?? `spotify:track:${track.id}`,
                uid: `${track.id}-uid`,
                title: track.title,
                subtitle: track.subtitle,
                duration: track.duration,
                isExplicit: false,
              })),
            },
          },
        },
      },
    },
  };
  return `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`;
}

const spotifyTrackPayload = {
  name: "Viti Ri Gon Kalaja",
  duration_ms: 253_000,
  external_urls: { spotify: "https://open.spotify.com/track/abc123abc123abc1" },
  album: { images: [{ url: "https://i.scdn.co/small.jpg" }, { url: "https://i.scdn.co/large.jpg" }] },
  artists: [{ name: "Muharrem Ahmeti" }],
};

/** The playlist from the bug report, with a track renamed per row. */
const playlistId = "5f97psz2nm2XvRG6qqHenL";

function playlistRow(name: string, id: string, extras: Record<string, unknown> = {}) {
  return {
    added_at: "2026-09-01T00:00:00Z",
    added_by: { id: "icy404" },
    is_local: false,
    ...extras,
    item: { ...spotifyTrackPayload, name, external_urls: { spotify: `https://open.spotify.com/track/${id}` } },
  };
}

beforeEach(() => {
  vi.resetModules();
  ytdlpJson.mockReset();
  ytdlpSearch.mockReset();
  ytdlpPlaylist.mockReset();
  ensureYtdlp.mockReset();
  ensureYtdlp.mockResolvedValue({ available: true, bin: "/usr/local/bin/yt-dlp", version: "2026.08.19", source: "path" });
  process.env.SPOTIFY_CLIENT_ID = "client";
  process.env.SPOTIFY_CLIENT_SECRET = "secret";
  delete process.env.MUSIC_SEARCH_PREFIX;
  delete process.env.MUSIC_MAX_QUEUE;
  delete process.env.MUSIC_MAX_PLAYLIST_TRACKS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;
  delete process.env.MUSIC_SEARCH_PREFIX;
});

describe("YouTube links", () => {
  it("extracts a watch URL through yt-dlp and maps the track", async () => {
    ytdlpJson.mockResolvedValue(entry());
    const { resolveQuery } = await sources();

    const result = await resolveQuery("https://www.youtube.com/watch?v=dQw4w9WgXcQ", requestedBy, requestedByName, 250);

    expect(ytdlpJson).toHaveBeenCalledWith("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result.kind).toBe("youtube-video");
    expect(result.origin).toBe("Never Gonna Give You Up");
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({
      title: "Never Gonna Give You Up",
      author: "RickAstleyVEVO",
      videoId: "dQw4w9WgXcQ",
      sourceKind: "youtube",
      sourceName: "youtube",
      // What the downloader is handed at play time: the watch page, never a
      // signed (and expiring) stream URL.
      sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      durationMs: 212_000,
      thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
      requestedBy,
      requestedByName,
    });
    expect(result.tracks[0]!.id).toBeTruthy(); // a fresh internal id per queue entry
  });

  it("accepts youtu.be and Shorts links the same way", async () => {
    ytdlpJson.mockResolvedValue(entry());
    const { resolveQuery } = await sources();

    // Every YouTube link shape is normalized to a watch URL before yt-dlp sees
    // it, so extraction follows one code path.
    await resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250);
    expect(ytdlpJson).toHaveBeenCalledWith("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    ytdlpJson.mockClear();
    await resolveQuery("https://www.youtube.com/shorts/dQw4w9WgXcQ", requestedBy, requestedByName, 250);
    expect(ytdlpJson).toHaveBeenCalledWith("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("refuses a live stream instead of queuing something with no end", async () => {
    ytdlpJson.mockResolvedValue(entry({ is_live: true, live_status: "is_live", duration: null }));
    const { resolveQuery, SourceError } = await sources();
    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(SourceError);
    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(/live stream/i);
  });

  it("explains an unavailable video", async () => {
    ytdlpJson.mockRejectedValue(new YtdlpError("That video is unavailable (removed, region-locked, or age-restricted without cookies)."));
    const { resolveQuery } = await sources();
    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(/unavailable/i);
  });

  it("keeps yt-dlp's own explanation, wrapped as a source error", async () => {
    ytdlpJson.mockRejectedValue(new YtdlpError("That video is private, so it can't be played."));
    const { resolveQuery, SourceError } = await sources();
    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(SourceError);
    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(/private/);
  });

  it("names the missing downloader and points at the fix", async () => {
    ensureYtdlp.mockResolvedValue({
      available: false,
      bin: "yt-dlp",
      version: null,
      source: "missing",
      detail: "yt-dlp is not installed and downloading it failed (HTTP 403).",
    });
    const { resolveQuery } = await sources();
    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(/yt-dlp/);
    await expect(resolveQuery("https://youtu.be/dQw4w9WgXcQ", requestedBy, requestedByName, 250))
      .rejects.toThrow(/YTDLP_PATH|troubleshooting-music/);
    expect(ytdlpJson).not.toHaveBeenCalled();
  });
});

describe("playlists", () => {
  it("imports a playlist, capped, and reports what was left out", async () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      entry({ id: `id${i}`, title: `Song ${i}`, webpage_url: `https://www.youtube.com/watch?v=id${i}` }),
    );
    ytdlpPlaylist.mockResolvedValue({ _type: "playlist", title: "My Mix", entries });
    const { resolveQuery } = await sources();

    const result = await resolveQuery(
      "https://www.youtube.com/playlist?list=PL1234567890",
      requestedBy,
      requestedByName,
      10,
    );

    expect(ytdlpPlaylist).toHaveBeenCalledWith("https://www.youtube.com/playlist?list=PL1234567890", 10);
    expect(result.kind).toBe("youtube-playlist");
    expect(result.origin).toBe("My Mix");
    expect(result.tracks).toHaveLength(10);
    expect(result.skipped).toBe(2); // over the cap
    expect(result.tracks[0]!.sourceUrl).toBe("https://www.youtube.com/watch?v=id0");
  });

  it("counts unavailable and live playlist entries as skipped", async () => {
    ytdlpPlaylist.mockResolvedValue({
      _type: "playlist",
      title: "Mixed",
      entries: [
        entry({ id: "a", webpage_url: "https://www.youtube.com/watch?v=a" }),
        entry({ id: "b", is_live: true, live_status: "is_live", webpage_url: "https://www.youtube.com/watch?v=b" }),
        null, // removed between the flat listing and now
        entry({ id: "c", webpage_url: "https://www.youtube.com/watch?v=c" }),
      ],
    });
    const { resolveQuery } = await sources();
    const result = await resolveQuery("https://www.youtube.com/playlist?list=PL1234567890", requestedBy, requestedByName, 50);
    expect(result.tracks.map((t) => t.videoId)).toEqual(["a", "c"]);
    expect(result.skipped).toBe(2);
  });

  it("says so when a playlist has nothing playable", async () => {
    ytdlpPlaylist.mockResolvedValue({ _type: "playlist", title: "Empty", entries: [] });
    const { resolveQuery } = await sources();
    await expect(resolveQuery("https://www.youtube.com/playlist?list=PL1234567890", requestedBy, requestedByName, 50))
      .rejects.toThrow(/no playable videos/i);
  });
});

describe("search", () => {
  it("searches with yt-dlp and takes the first playable result", async () => {
    ytdlpSearch.mockResolvedValue([
      entry({ id: "live", title: "A live thing", is_live: true, live_status: "is_live" }),
      entry({ id: "second", title: "The Song", webpage_url: "https://www.youtube.com/watch?v=second" }),
    ]);
    const { resolveQuery } = await sources();

    const result = await resolveQuery("the song", requestedBy, requestedByName, 250);

    expect(ytdlpSearch).toHaveBeenCalledWith("the song", 5, "ytsearch");
    expect(result.kind).toBe("search");
    expect(result.tracks[0]!.videoId).toBe("second"); // the live one is skipped
  });

  it("honours MUSIC_SEARCH_PREFIX", async () => {
    process.env.MUSIC_SEARCH_PREFIX = "ytmsearch";
    ytdlpSearch.mockResolvedValue([entry()]);
    const { resolveQuery, searchPrefix } = await sources();
    expect(searchPrefix()).toBe("ytmsearch");
    await resolveQuery("the song", requestedBy, requestedByName, 250);
    expect(ytdlpSearch).toHaveBeenCalledWith("the song", 5, "ytmsearch");
  });

  it("ignores a search prefix it doesn't know", async () => {
    process.env.MUSIC_SEARCH_PREFIX = "spsearch";
    const { searchPrefix } = await sources();
    expect(searchPrefix()).toBe("ytsearch");
  });

  it("says when nothing matched", async () => {
    ytdlpSearch.mockResolvedValue([]);
    const { resolveQuery } = await sources();
    await expect(resolveQuery("asdkjhaskjdh", requestedBy, requestedByName, 250)).rejects.toThrow(/No track matched/);
  });

  it("refuses an empty query", async () => {
    const { resolveQuery } = await sources();
    await expect(resolveQuery("   ", requestedBy, requestedByName, 250)).rejects.toThrow(/Tell me what to play/);
    expect(ytdlpSearch).not.toHaveBeenCalled();
  });
});

describe("search targets", () => {
  it("composes the search key, the count and the phrase exactly once", () => {
    expect(searchTarget("Never Gonna Give You Up", 5)).toBe("ytsearch5:Never Gonna Give You Up");
    expect(searchTarget("Never Gonna Give You Up", 5, "ytmsearch")).toBe(
      "ytmsearch5:Never Gonna Give You Up",
    );
    // A doubled key (`ytsearch5:ytsearch:…`) makes YouTube search for the
    // literal words "ytsearch:…" — that is the bug this pins shut.
    expect(searchTarget("a song", 5, "ytsearch")).not.toContain("ytsearch:ytsearch");
    expect(searchTarget("x", 500, "scsearch")).toBe("scsearch20:x"); // clamped
  });

  it("falls back to a plain YouTube search for a key it doesn't know", () => {
    expect(normalizeSearchKey("ytsearch:")).toBe("ytsearch");
    expect(normalizeSearchKey("YTSEARCH")).toBe("ytsearch");
    expect(normalizeSearchKey("spsearch")).toBe("ytsearch");
    expect(normalizeSearchKey(null)).toBe("ytsearch");
  });

  it("calls a search yt-dlp reports as failed a downloader problem, not a missing song", () => {
    // What a blocked network looks like: exit 0, `entries: [null]`, the reason
    // on stderr only.
    const stderr =
      'ERROR: [youtube:search] query "the song": Unable to download API page: TLS/SSL connection has been closed (EOF) (_ssl.c:992)';
    expect(searchFailure(stderr)).toMatch(/couldn't reach the source/);
    expect(searchFailure("")).toBeNull();
    expect(searchFailure("[youtube] Downloading 1 format(s)")).toBeNull();
  });

  it("names the backend it actually searched", () => {
    expect(searchLabel("ytsearch")).toBe("YouTube");
    expect(searchLabel("ytmsearch")).toBe("YouTube Music");
    expect(searchLabel("scsearch")).toBe("SoundCloud");
  });
});

describe("other sources yt-dlp can load", () => {
  it("plays a link the classifier doesn't know by handing it to the downloader", async () => {
    ytdlpJson
      .mockResolvedValueOnce(entry({ _type: "video" })) // the flat probe
      .mockResolvedValueOnce(
        entry({
          id: "sc1",
          title: "SoundCloud thing",
          extractor: "soundcloud",
          ie_key: "Soundcloud",
          webpage_url: "https://soundcloud.com/artist/track",
        }),
      );
    const { resolveQuery } = await sources();

    const result = await resolveQuery("https://soundcloud.com/artist/track", requestedBy, requestedByName, 250);

    expect(ytdlpJson).toHaveBeenNthCalledWith(1, "https://soundcloud.com/artist/track", { flat: true, limit: 250 });
    expect(result.tracks[0]).toMatchObject({ sourceKind: "other", sourceName: "soundcloud", title: "SoundCloud thing" });
  });

  it("expands a link that turns out to be a playlist", async () => {
    ytdlpJson.mockResolvedValue({ _type: "playlist", entries: [entry()] });
    ytdlpPlaylist.mockResolvedValue({ _type: "playlist", title: "A list", entries: [entry({ id: "one" }), entry({ id: "two" })] });
    const { resolveQuery } = await sources();

    const result = await resolveQuery("https://example.com/mystery-list", requestedBy, requestedByName, 250);

    expect(result.origin).toBe("A list");
    expect(result.tracks).toHaveLength(2);
  });

  it("falls back to searching when the downloader can't load that link", async () => {
    ytdlpJson.mockRejectedValue(new YtdlpError("That link isn't something the downloader supports."));
    ytdlpSearch.mockResolvedValue([entry({ id: "searched", webpage_url: "https://www.youtube.com/watch?v=searched" })]);
    const { resolveQuery } = await sources();

    const result = await resolveQuery("https://example.com/mystery", requestedBy, requestedByName, 250);

    expect(ytdlpSearch).toHaveBeenCalledWith("https://example.com/mystery", 5, "ytsearch");
    expect(result.tracks[0]!.videoId).toBe("searched");
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

    // No downloader call at queue time — that's the whole point of the lazy match.
    expect(ytdlpSearch).not.toHaveBeenCalled();
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
    expect(result.tracks[0]!.sourceUrl).toBeUndefined();

    ytdlpSearch.mockResolvedValue([entry({ id: "matched", duration: 250 })]);
    const playable = await ensurePlayable(result.tracks[0]!);
    expect(ytdlpSearch).toHaveBeenCalledWith("Muharrem Ahmeti – Viti Ri Gon Kalaja", 5, "ytsearch");
    expect(playable.sourceUrl).toBe("https://www.youtube.com/watch?v=matched");
    expect(playable.videoId).toBe("matched");
    // The user-facing link stays the Spotify one; only the audio is YouTube's.
    expect(playable.url).toBe("https://open.spotify.com/track/abc123abc123abc1");
  });

  it("keeps the Spotify metadata when the match has none", async () => {
    stubSpotify({ "/tracks/abc123abc123abc1": spotifyTrackPayload });
    const { resolveQuery, ensurePlayable } = await sources();
    const result = await resolveQuery("spotify:track:abc123abc123abc1", requestedBy, requestedByName, 250);

    ytdlpSearch.mockResolvedValue([entry({ id: "m", thumbnail: null, duration: null, title: "Whatever" })]);
    const playable = await ensurePlayable(result.tracks[0]!);
    expect(playable.durationMs).toBe(253_000); // Spotify's, not the downloader's unknown
    expect(playable.thumbnail).toBe("https://i.scdn.co/large.jpg");
    expect(playable.title).toBe("Muharrem Ahmeti – Viti Ri Gon Kalaja");
  });

  it("says what it searched when every match was unplayable", async () => {
    stubSpotify({ "/tracks/abc123abc123abc1": spotifyTrackPayload });
    const { resolveQuery, ensurePlayable } = await sources();
    const result = await resolveQuery("spotify:track:abc123abc123abc1", requestedBy, requestedByName, 250);

    ytdlpSearch.mockResolvedValue([]); // the search worked; nothing was playable
    await expect(ensurePlayable(result.tracks[0]!)).rejects.toThrow(
      /isn't on YouTube in a form I can play — I searched for “Muharrem Ahmeti – Viti Ri Gon Kalaja”/,
    );
  });

  it("refuses to replay a track with nothing to play", async () => {
    const { ensurePlayable, SourceError } = await sources();
    await expect(ensurePlayable({ id: "x", title: "X" } as never)).rejects.toThrow(SourceError);
    await expect(ensurePlayable({ id: "x", title: "X" } as never)).rejects.toThrow(/don't know how to play/);
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
    expect(ytdlpSearch).not.toHaveBeenCalled();
  });

  // The bug report: a full playlist answering "has no playable tracks". Since
  // February 2026 every row carries its payload under `item` while the old
  // `track` key is still there as a boolean, so a parser that reads `track`
  // first finds no tracks in a playlist that is full of them.
  it("imports a whole playlist when every row's `track` is a boolean", async () => {
    const rows = [playlistRow("One", "one", { track: true }), playlistRow("Two", "two", { track: true })];
    stubSpotify({
      [`/playlists/${playlistId}`]: {
        name: "Phonk",
        items: { total: rows.length, next: null, items: rows },
        tracks: { total: rows.length, next: null, items: rows }, // deprecated alias, still sent
      },
    });
    const { resolveQuery } = await sources();

    const result = await resolveQuery(
      `https://open.spotify.com/playlist/${playlistId}?si=ic1sSfbCR7-HiH5tFYkMew&utm_source=copy-link`,
      requestedBy,
      requestedByName,
      250,
    );

    expect(result.kind).toBe("spotify-playlist");
    expect(result.origin).toBe("Phonk");
    expect(result.tracks.map((t) => t.title)).toEqual(["Muharrem Ahmeti – One", "Muharrem Ahmeti – Two"]);
    expect(result.tracks[0]!.youtubeSearch).toBe("Muharrem Ahmeti – One");
    expect(result.skipped).toBe(0);
  });

  it("imports a playlist that only carries the renamed `items` field", async () => {
    stubSpotify({
      [`/playlists/${playlistId}`]: {
        name: "Phonk",
        items: { total: 1, next: null, items: [playlistRow("One", "one")] },
      },
    });
    const { resolveQuery } = await sources();

    const result = await resolveQuery(`https://open.spotify.com/playlist/${playlistId}`, requestedBy, requestedByName, 250);

    expect(result.tracks.map((t) => t.title)).toEqual(["Muharrem Ahmeti – One"]);
  });

  it("reads the playlist rows from whichever spelling still holds them", async () => {
    stubSpotify({
      [`/playlists/${playlistId}`]: {
        name: "Phonk",
        // The renamed field arrived empty for this app; the legacy alias kept
        // the rows, so that is what gets read.
        items: { total: 1, next: null, items: [] },
        tracks: { total: 1, next: null, items: [{ track: playlistRow("One", "one").item }] },
      },
    });
    const { resolveQuery } = await sources();

    const result = await resolveQuery(`https://open.spotify.com/playlist/${playlistId}`, requestedBy, requestedByName, 250);

    expect(result.tracks.map((t) => t.title)).toEqual(["Muharrem Ahmeti – One"]);
  });

  it("walks a legacy cursor on the renamed endpoint and keeps what it already read", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("accounts.spotify.com")) {
          return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) } as Response;
        }
        // Spotify's legacy `/tracks` cursor is dead: the endpoint answers 403.
        if (url.includes("offset=1")) return { ok: false, status: 403, json: async () => ({}) } as unknown as Response;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: "Long list",
            tracks: {
              total: 3,
              next: `https://api.spotify.com/v1/playlists/${playlistId}/tracks?offset=1`,
              items: [{ track: playlistRow("One", "one").item }],
            },
          }),
        } as Response;
      }),
    );
    const { resolveQuery } = await sources();

    const result = await resolveQuery(`https://open.spotify.com/playlist/${playlistId}`, requestedBy, requestedByName, 250);

    expect(calls).toContain(`https://api.spotify.com/v1/playlists/${playlistId}/items?offset=1`);
    expect(result.tracks.map((t) => t.title)).toEqual(["Muharrem Ahmeti – One"]);
    // The two tracks the dead page never delivered are reported as left out.
    expect(result.skipped).toBe(2);
  });

  it("falls back to the public embed page when Spotify withholds the tracks", async () => {
    const fetchMock = stubSpotifyAndEmbed(
      // What a Development Mode app gets for a playlist it doesn't own: a name,
      // a count, and no rows.
      { [`/playlists/${playlistId}`]: { name: "Phonk", items: { total: 137, next: null, items: [] } } },
      embedPlaylistHtml("Phonk", [
        { id: "one", title: "One", subtitle: "Artist A", duration: 180_000 },
        { id: "two", title: "Two", subtitle: "Artist B", duration: 200_000 },
        { uri: "spotify:episode:cast", id: "cast", title: "A podcast episode", subtitle: "Some show", duration: 600_000 },
      ]),
    );
    const { resolveQuery } = await sources();

    const result = await resolveQuery(`https://open.spotify.com/playlist/${playlistId}`, requestedBy, requestedByName, 250);

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
      `https://open.spotify.com/embed/playlist/${playlistId}`,
    );
    expect(result.origin).toBe("Phonk");
    expect(result.tracks.map((t) => t.title)).toEqual(["Artist A – One", "Artist B – Two"]);
    expect(result.tracks[0]).toMatchObject({
      url: "https://open.spotify.com/track/one",
      durationMs: 180_000,
      youtubeSearch: "Artist A – One",
      sourceKind: "spotify",
    });
    // 137 listed by the API, two of them readable from the embed.
    expect(result.skipped).toBe(135);
  });

  it("rescues a playlist the API refuses outright (404 on Spotify's own playlists)", async () => {
    stubSpotifyAndEmbed(
      // Spotify's editorial playlists have answered 404 here for years.
      { [`/playlists/${playlistId}`]: { error: { status: 404, message: "Not found" } } },
      embedPlaylistHtml("Phonk", [{ id: "one", title: "One", subtitle: "Artist A", duration: 180_000 }]),
    );
    const { resolveQuery } = await sources();

    const result = await resolveQuery(`https://open.spotify.com/playlist/${playlistId}`, requestedBy, requestedByName, 250);

    expect(result.origin).toBe("Phonk");
    expect(result.tracks.map((t) => t.title)).toEqual(["Artist A – One"]);
  });

  it("treats rows that carry no readable payload as withheld, not as an empty playlist", async () => {
    stubSpotifyAndEmbed(
      // Nothing but the boolean stub under the old key — a shape rename that a
      // lenient reader would let pass as "this playlist is empty".
      { [`/playlists/${playlistId}`]: { name: "Phonk", tracks: { total: 2, next: null, items: [{ track: true }, { track: true }] } } },
      embedPlaylistHtml("Phonk", [{ id: "one", title: "One", subtitle: "Artist A", duration: 180_000 }]),
    );
    const { resolveQuery } = await sources();

    const result = await resolveQuery(`https://open.spotify.com/playlist/${playlistId}`, requestedBy, requestedByName, 250);

    expect(result.tracks.map((t) => t.title)).toEqual(["Artist A – One"]);
  });

  it("says why when Spotify withholds a playlist's tracks", async () => {
    stubSpotifyAndEmbed(
      { [`/playlists/${playlistId}`]: { name: "Phonk", items: { total: 137, next: null, items: [] } } },
      null, // private playlist: the embed page isn't readable either
    );
    const { resolveQuery } = await sources();

    const error = (await resolveQuery(
      `https://open.spotify.com/playlist/${playlistId}`,
      requestedBy,
      requestedByName,
      250,
    ).catch((thrown: unknown) => thrown)) as Error;

    expect(error.message).toMatch(/an app can only read playlists it owns itself/);
    expect(error.message).toMatch(/137 listed/);
    // The old wording blamed the playlist — it was never the empty one.
    expect(error.message).not.toMatch(/no playable tracks/);
  });

  it("treats a playlist response with no contents field at all the same way", async () => {
    stubSpotifyAndEmbed({ [`/playlists/${playlistId}`]: { name: "Phonk", tracks: { total: 12 } } }, null);
    const { resolveQuery } = await sources();

    await expect(resolveQuery(`https://open.spotify.com/playlist/${playlistId}`, requestedBy, requestedByName, 250))
      .rejects.toThrow(/12 listed/);
  });

  it("doesn't reach for the embed page when the API already answered", async () => {
    const fetchMock = stubSpotifyAndEmbed(
      { [`/playlists/${playlistId}`]: { name: "Phonk", items: { total: 1, next: null, items: [playlistRow("One", "one")] } } },
      embedPlaylistHtml("Phonk", [{ id: "stale", title: "Stale", subtitle: "Old", duration: 1_000 }]),
    );
    const { resolveQuery } = await sources();

    const result = await resolveQuery(`https://open.spotify.com/playlist/${playlistId}`, requestedBy, requestedByName, 250);

    expect(result.tracks.map((t) => t.title)).toEqual(["Muharrem Ahmeti – One"]);
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes("/embed/"))).toBe(false);
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
    expect(ytdlpSearch).not.toHaveBeenCalled();
  });

  it("tells the user what to do when Spotify search isn't configured", async () => {
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
    const { resolveQuery } = await sources();
    await expect(resolveQuery("viti ri gon kalaja", requestedBy, requestedByName, 250, "spotify"))
      .rejects.toThrow(/SPOTIFY_CLIENT_ID/);
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
