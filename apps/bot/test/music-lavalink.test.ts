import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LAVALINK_PASSWORD,
  LavalinkError,
  LavalinkManager,
  lavalinkNodesFromEnv,
  parseLavalinkNode,
  usingDefaultPassword,
  type SocketLike,
} from "../src/music/lavalink.js";

/**
 * Protocol tests for the Lavalink client. Both transports are injected: a fake
 * socket (so the v4 receive-only WebSocket contract is driven by hand) and a
 * fake `fetch` (so every REST call's URL, method and body is asserted).
 */

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: string[] = [];
  closedWith: [number | undefined, string | undefined] | null = null;
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = [code, reason];
    this.emit("close", code ?? 1000, reason ?? "");
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (...args: unknown[]) => void);
    this.listeners.set(event, set);
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  /** The node answers us: push a frame the way the real server would. */
  server(payload: unknown): void {
    this.emit("message", JSON.stringify(payload));
  }

  /** The node drops the connection (crash, restart, network). */
  drop(code = 1006, reason = "gone"): void {
    this.emit("close", code, reason);
  }
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

function jsonResponse(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function setup(env: Record<string, string> = {}) {
  const sockets: FakeSocket[] = [];
  const requests: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const responses: FakeResponse[] = [];

  const manager = new LavalinkManager({
    nodes: lavalinkNodesFromEnvWith(env),
    userId: "bot-user",
    socketFactory: (url, options) => {
      const socket = new FakeSocket(url, options.headers);
      sockets.push(socket);
      return socket;
    },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return responses.shift() ?? jsonResponse(204, null);
    }) as unknown as typeof fetch,
  });

  return { manager, sockets, requests, responses };
}

function lavalinkNodesFromEnvWith(env: Record<string, string>) {
  const restore: Record<string, string | undefined> = {};
  for (const key of ["LAVALINK_NODES", "LAVALINK_HOST", "LAVALINK_PORT", "LAVALINK_PASSWORD", "LAVALINK_SECURE"]) {
    restore[key] = process.env[key];
    if (key in env) process.env[key] = env[key];
    else delete process.env[key];
  }
  const nodes = lavalinkNodesFromEnv();
  for (const [key, value] of Object.entries(restore)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return nodes;
}

/** Bring a node up the way the real one does: socket open, then `ready`. */
function bringUp(socket: FakeSocket, sessionId = "s1"): void {
  socket.emit("open");
  socket.server({ op: "ready", resumed: false, sessionId });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("node configuration", () => {
  it("defaults to the bundled node on localhost:2333", () => {
    const nodes = lavalinkNodesFromEnvWith({});
    expect(nodes).toEqual([
      { name: "node-1", host: "localhost", port: 2333, password: DEFAULT_LAVALINK_PASSWORD, secure: false },
    ]);
    expect(usingDefaultPassword(nodes)).toBe(true);
  });

  it("reads a single node from LAVALINK_HOST / PORT / PASSWORD", () => {
    const nodes = lavalinkNodesFromEnvWith({
      LAVALINK_HOST: "lavalink.internal",
      LAVALINK_PORT: "2334",
      LAVALINK_PASSWORD: "s3cret",
      LAVALINK_SECURE: "1",
    });
    expect(nodes).toEqual([
      { name: "node-1", host: "lavalink.internal", port: 2334, password: "s3cret", secure: true },
    ]);
    expect(usingDefaultPassword(nodes)).toBe(false);
  });

  it("parses several named nodes, with or without a scheme", () => {
    const nodes = lavalinkNodesFromEnvWith({
      LAVALINK_NODES: "eu@ws://lavalink-eu:2333,us@https://lavalink-us.example, plain-host:2333 ",
      LAVALINK_PASSWORD: "pw",
    });
    expect(nodes.map((n) => [n.name, n.host, n.port, n.secure])).toEqual([
      ["eu", "lavalink-eu", 2333, false],
      ["us", "lavalink-us.example", 2333, true],
      ["node-3", "plain-host", 2333, false],
    ]);
  });

  it("parses one entry", () => {
    expect(parseLavalinkNode("name@wss://node.example:8443", "pw", 0)).toEqual({
      name: "name",
      host: "node.example",
      port: 8443,
      password: "pw",
      secure: true,
    });
    expect(parseLavalinkNode("   ", "pw", 0)).toBeNull();
  });
});

describe("websocket handshake (receive-only in v4)", () => {
  it("sends the auth headers and never a client frame", () => {
    const { manager, sockets } = setup({ LAVALINK_PASSWORD: "pw" });
    manager.start("bot-user");
    const socket = sockets[0]!;
    expect(socket.url).toBe("ws://localhost:2333/v4/websocket");
    expect(socket.headers).toMatchObject({
      Authorization: "pw",
      "User-Id": "bot-user",
      "Client-Name": expect.stringContaining("monarch-bot"),
    });

    socket.server({ op: "ready", resumed: false, sessionId: "abc123" });
    expect(manager.nodes[0]!.sessionId).toBe("abc123");
    expect(manager.nodes[0]!.connected).toBe(true);
    // v4 rejects inbound frames: the client must stay silent on the socket.
    expect(socket.sent).toEqual([]);
  });

  it("asks for a resuming session so playback survives a socket drop", () => {
    const { manager, sockets, requests } = setup();
    manager.start("bot-user");
    bringUp(sockets[0]!, "abc123");
    expect(requests[0]).toMatchObject({
      method: "PATCH",
      url: "http://localhost:2333/v4/sessions/abc123",
      body: { resuming: true, timeout: 60 },
    });
  });

  it("reconnects with the Session-Id header after the node drops us", () => {
    const { manager, sockets } = setup();
    manager.start("bot-user");
    bringUp(sockets[0]!, "abc123");

    sockets[0]!.drop(1006, "node restarted");
    expect(manager.nodes[0]!.connected).toBe(false);

    vi.advanceTimersByTime(60_000); // past any backoff
    expect(sockets.length).toBe(2);
    expect(sockets[1]!.headers["Session-Id"]).toBe("abc123");
  });

  it("does not reconnect after a deliberate close", () => {
    const { manager, sockets } = setup();
    manager.start("bot-user");
    bringUp(sockets[0]!);
    manager.stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets.length).toBe(1);
  });

  it("maps node events onto typed manager events", () => {
    const { manager, sockets } = setup();
    manager.start("bot-user");
    const seen: string[] = [];
    manager.on("trackEnd", (payload) => seen.push(`end:${payload.reason}:${payload.guildId}`));
    manager.on("trackException", (payload) => seen.push(`exception:${payload.exception.message}`));
    manager.on("trackStuck", () => seen.push("stuck"));
    manager.on("playerUpdate", (payload) => seen.push(`update:${payload.state.position}`));
    manager.on("voiceSocketClosed", (payload) => seen.push(`voiceClosed:${payload.code}`));

    bringUp(sockets[0]!, "s1");
    const socket = sockets[0]!;
    socket.server({ op: "event", type: "TrackStartEvent", guildId: "g1", track: { encoded: "e", info: {} } });
    socket.server({ op: "event", type: "TrackEndEvent", guildId: "g1", track: { encoded: "e", info: {} }, reason: "finished" });
    socket.server({ op: "event", type: "TrackEndEvent", guildId: "g1", track: null, reason: "loadFailed" });
    socket.server({
      op: "event",
      type: "TrackExceptionEvent",
      guildId: "g1",
      track: { encoded: "e", info: {} },
      exception: { message: "Video unavailable", severity: "common", cause: "…" },
    });
    socket.server({ op: "event", type: "TrackStuckEvent", guildId: "g1", track: null, thresholdMs: 10_000 });
    socket.server({ op: "event", type: "WebSocketClosedEvent", guildId: "g1", code: 4006, reason: "session", byRemote: true });
    socket.server({ op: "playerUpdate", guildId: "g1", state: { time: 1, position: 42_000, connected: true, ping: 10 } });
    socket.server({ op: "stats", players: 2, playingPlayers: 1, uptime: 1, memory: {}, cpu: { cores: 4, systemLoad: 0.1, lavalinkLoad: 0.1 } });

    expect(seen).toEqual([
      "end:finished:g1",
      "end:loadFailed:g1",
      "exception:Video unavailable",
      "stuck",
      "voiceClosed:4006",
      "update:42000",
    ]);
    expect(manager.nodes[0]!.stats?.playingPlayers).toBe(1);
  });
});

describe("REST player API", () => {
  it("loads tracks with the identifier encoded and the password header set", async () => {
    const { manager, sockets, requests, responses } = setup({ LAVALINK_PASSWORD: "pw" });
    manager.start("bot-user");
    bringUp(sockets[0]!, "s1");
    responses.push(jsonResponse(200, { loadType: "search", data: [{ encoded: "e", info: { title: "Song" } }] }));

    const result = await manager.loadTracks("ytsearch:never gonna give you up");
    expect(result.loadType).toBe("search");
    expect(requests[1]).toMatchObject({
      method: "GET",
      url: "http://localhost:2333/v4/loadtracks?identifier=ytsearch%3Anever%20gonna%20give%20you%20up",
      headers: { Authorization: "pw" },
    });
  });

  it("plays a track with volume and userData for event correlation", async () => {
    const { manager, sockets, requests } = setup();
    manager.start("bot-user");
    bringUp(sockets[0]!, "s1");

    await manager.play("guild-1", "encoded-track", { volume: 120, userData: { id: "track-uuid" } });
    expect(requests.at(-1)).toMatchObject({
      method: "PATCH",
      url: "http://localhost:2333/v4/sessions/s1/players/guild-1?noReplace=false",
      body: { track: { encoded: "encoded-track", userData: { id: "track-uuid" } }, paused: false, position: 0, volume: 120 },
    });
  });

  it("hands over Discord voice credentials", async () => {
    const { manager, sockets, requests } = setup();
    manager.start("bot-user");
    bringUp(sockets[0]!, "s1");

    await manager.updateVoice("guild-1", {
      token: "tok",
      endpoint: "voice.discord.gg",
      sessionId: "discord-session",
      channelId: "chan",
    });
    expect(requests.at(-1)).toMatchObject({
      method: "PATCH",
      url: "http://localhost:2333/v4/sessions/s1/players/guild-1?noReplace=false",
      body: { voice: { token: "tok", endpoint: "voice.discord.gg", sessionId: "discord-session", channelId: "chan" } },
    });
  });

  it("stops a track without destroying the player, and destroys on request", async () => {
    const { manager, sockets, requests } = setup();
    manager.start("bot-user");
    bringUp(sockets[0]!, "s1");

    await manager.stopTrack("guild-1");
    expect(requests.at(-1)).toMatchObject({ body: { track: { encoded: null } } });

    await manager.destroyPlayer("guild-1");
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: "http://localhost:2333/v4/sessions/s1/players/guild-1",
    });
    expect(manager.nodeOf("guild-1")).toBeNull();
  });

  it("refuses player updates before the node has a session", async () => {
    const { manager, sockets } = setup();
    manager.start("bot-user");
    await expect(manager.pause("guild-1", true)).rejects.toThrow(LavalinkError);
  });

  it("turns a node error body into a readable failure", async () => {
    const { manager, sockets, responses } = setup();
    manager.start("bot-user");
    bringUp(sockets[0]!, "s1");
    responses.push(jsonResponse(404, { status: 404, error: "Not Found", message: "Session not found" }));
    await expect(manager.pause("guild-1", true)).rejects.toThrow(/Session not found/);
  });

  it("names an unreachable node instead of throwing a bare network error", async () => {
    const { manager, sockets } = setup();
    manager.start("bot-user");
    bringUp(sockets[0]!, "s1");
    (manager.nodes[0] as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:2333");
    }) as unknown as typeof fetch;
    await expect(manager.pause("guild-1", true)).rejects.toThrow(/Couldn't reach the Lavalink node/);
  });
});

describe("node selection", () => {
  it("keeps a guild on its node while that node is up", async () => {
    const { manager, sockets } = setup({ LAVALINK_NODES: "a@ws://a:2333,b@ws://b:2333" });
    manager.start("bot-user");
    bringUp(sockets[0]!, "sa");
    sockets[1]!.emit("open");
    sockets[1]!.server({ op: "ready", resumed: false, sessionId: "sb" });

    const first = manager.nodeFor("guild-1");
    expect(manager.nodeFor("guild-1")).toBe(first);
    await manager.play("guild-1", "e");
    expect(first.assignedGuilds.has("guild-1")).toBe(true);
  });

  it("prefers the node with the lower penalty", () => {
    const { manager, sockets } = setup({ LAVALINK_NODES: "busy@ws://busy:2333,free@ws://free:2333" });
    manager.start("bot-user");
    bringUp(sockets[0]!, "s-busy");
    sockets[1]!.emit("open");
    sockets[1]!.server({ op: "ready", resumed: false, sessionId: "s-free" });

    manager.nodes[0]!.stats = {
      players: 40,
      playingPlayers: 40,
      uptime: 1,
      memory: { free: 1, used: 1, allocated: 1, reservable: 1 },
      cpu: { cores: 4, systemLoad: 0.9, lavalinkLoad: 0.9 },
      frameStats: { sent: 1, nulled: 10, deficit: 100 },
    };
    manager.nodes[1]!.stats = {
      players: 1,
      playingPlayers: 0,
      uptime: 1,
      memory: { free: 1, used: 1, allocated: 1, reservable: 1 },
      cpu: { cores: 4, systemLoad: 0.05, lavalinkLoad: 0.01 },
    };

    expect(manager.nodeFor("guild-new").name).toBe("free");
  });

  it("waits for a node instead of playing into the void", async () => {
    const { manager, sockets } = setup();
    manager.start("bot-user");
    const waiting = manager.whenReady(5_000);
    sockets[0]!.emit("open");
    sockets[0]!.server({ op: "ready", resumed: false, sessionId: "s1" });
    await expect(waiting).resolves.toMatchObject({ sessionId: "s1" });
  });

  it("says what to check when no node answers", async () => {
    const { manager } = setup();
    manager.start("bot-user");
    // Caught up front: an unhandled rejection here would fail the whole run.
    const pending = manager.whenReady(500).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(600);
    const error = await pending;
    expect(error).toBeInstanceOf(LavalinkError);
    expect(String(error)).toMatch(/Is the node running/);
  });
});
