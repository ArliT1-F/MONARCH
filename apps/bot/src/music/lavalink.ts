import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { createLogger } from "@monarch/shared";

/**
 * Lavalink v4 client — Monarch's only audio path.
 *
 * Lavalink is a standalone node (Java) that talks to Discord's voice servers
 * over UDP and does the source extraction (YouTube & friends) itself. This
 * module is the whole protocol surface the bot needs:
 *
 * - **WebSocket** (`/v4/websocket`) is *receive-only* in v4: the node pushes
 *   `ready`, `playerUpdate`, `stats` and `event` frames. Sending anything on
 *   it makes the node answer "Lavalink v4 does not support websocket
 *   messages", so every command is a REST call.
 * - **REST** (`/v4/loadtracks`, `/v4/sessions/{id}/players/{guildId}`) loads
 *   tracks and drives the player: what plays, pause, volume, position, and the
 *   Discord voice credentials (`voice: {token, endpoint, sessionId}`) the node
 *   needs to reach the voice server.
 * - **Discord's gateway** stays ours: the bot joins a channel with op 4 and
 *   forwards the resulting VOICE_STATE_UPDATE / VOICE_SERVER_UPDATE payloads to
 *   the node. The bot never opens a voice connection of its own — two clients
 *   in one voice session is exactly how audio dies mid-song.
 *
 * Nothing here imports discord.js: {@link MusicManager} owns the Discord side,
 * this file owns the node side, and both stay testable in isolation.
 */

const log = createLogger("bot.music.lavalink");

/** Lavalink's own default; `docker/lavalink/application.yml` uses the same. */
export const DEFAULT_LAVALINK_PASSWORD = "youshallnotpass";
export const DEFAULT_LAVALINK_PORT = 2333;
export const DEFAULT_LAVALINK_CLIENT_NAME = "monarch-bot/0.1.0";
/** How long the node keeps our players alive (and playing!) across a WS drop. */
export const DEFAULT_RESUME_TIMEOUT_SECONDS = 60;

// ── protocol types (v4) ────────────────────────────────────────────────

export interface LavalinkTrackInfo {
  identifier: string;
  isSeekable: boolean;
  author: string;
  /** Length in ms; 0 for streams and unknown lengths. */
  length: number;
  isStream: boolean;
  position: number;
  title: string;
  uri: string | null;
  artworkUrl: string | null;
  isrc: string | null;
  sourceName: string;
}

export interface LavalinkTrack {
  encoded: string;
  info: LavalinkTrackInfo;
  pluginInfo?: Record<string, unknown>;
  userData?: Record<string, unknown>;
}

export interface LavalinkException {
  message: string | null;
  severity: "common" | "suspicious" | "fault";
  cause: string;
  causeStackTrace?: string;
}

export type LavalinkLoadResult =
  | { loadType: "track"; data: LavalinkTrack }
  | { loadType: "playlist"; data: { info: { name: string; selectedTrack: number }; pluginInfo?: Record<string, unknown>; tracks: LavalinkTrack[] } }
  | { loadType: "search"; data: LavalinkTrack[] }
  | { loadType: "empty"; data: null }
  | { loadType: "error"; data: LavalinkException };

export interface LavalinkPlayerState {
  time: number;
  position: number;
  connected: boolean;
  ping: number;
}

export interface LavalinkVoiceState {
  token: string;
  endpoint: string;
  sessionId: string;
  channelId?: string | null;
}

export interface LavalinkFrameStats {
  sent: number;
  nulled: number;
  deficit: number;
}

export interface LavalinkStats {
  players: number;
  playingPlayers: number;
  uptime: number;
  memory: { free: number; used: number; allocated: number; reservable: number };
  cpu: { cores: number; systemLoad: number; lavalinkLoad: number };
  frameStats?: LavalinkFrameStats | null;
}

/** `PATCH /v4/sessions/{sessionId}/players/{guildId}` body. */
export interface PlayerUpdatePayload {
  /** `{ encoded: null }` stops the current track. */
  track?: { encoded?: string | null; identifier?: string; userData?: Record<string, unknown> } | null;
  position?: number;
  endTime?: number | null;
  volume?: number;
  paused?: boolean;
  voice?: LavalinkVoiceState;
  filters?: Record<string, unknown>;
}

export type TrackEndReason = "finished" | "loadFailed" | "stopped" | "replaced" | "cleanup";

// ── configuration ──────────────────────────────────────────────────────

export interface LavalinkNodeConfig {
  /** Stable label for logs, and the key that pins a guild to one node. */
  name: string;
  host: string;
  port: number;
  password: string;
  /** wss/https instead of ws/http (a node behind TLS). */
  secure: boolean;
  /** Optional hint for future region-aware routing. */
  region?: string;
}

export interface LavalinkOptions {
  nodes: LavalinkNodeConfig[];
  /** The bot's own user id — required by the WS handshake headers. */
  userId: string;
  clientName?: string;
  resumeTimeoutSeconds?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Injectable for tests: opens the socket to a node. */
  socketFactory?: SocketFactory;
  /** Injectable for tests: REST transport. */
  fetchImpl?: typeof fetch;
}

function boolEnv(name: string, fallback = false): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  return !(raw === "0" || raw === "false" || raw === "no");
}

function intEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Parse one `LAVALINK_NODES` entry: `[name@][ws|wss|http|https://]host[:port]`.
 *
 * ```
 * LAVALINK_NODES=ws://localhost:2333
 * LAVALINK_NODES=eu@lavalink-eu.example:2333,us@https://lavalink-us.example
 * ```
 */
export function parseLavalinkNode(raw: string, password: string, index: number): LavalinkNodeConfig | null {
  let text = raw.trim();
  if (!text) return null;

  let name: string | null = null;
  const at = text.indexOf("@");
  if (at > 0) {
    name = text.slice(0, at).trim();
    text = text.slice(at + 1).trim();
  }

  let secure = boolEnv("LAVALINK_SECURE", false);
  const scheme = text.match(/^(wss|ws|https|http):\/\//i);
  if (scheme) {
    const protocol = scheme[1]!.toLowerCase();
    secure = protocol === "wss" || protocol === "https";
    text = text.slice(scheme[0].length);
  }
  text = text.split("/")[0] ?? text; // only host[:port] is meaningful here

  let host = text;
  let port = intEnv("LAVALINK_PORT", DEFAULT_LAVALINK_PORT);
  const hostPort = text.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? text.match(/^([^:]+)(?::(\d+))?$/);
  if (hostPort?.[1]) {
    host = hostPort[1];
    if (hostPort[2]) port = Number.parseInt(hostPort[2], 10);
  }
  if (!host) return null;

  return { name: name && name.length > 0 ? name : `node-${index + 1}`, host, port, password, secure };
}

/** Every configured node, from `LAVALINK_NODES` (or the LAVALINK_HOST trio). */
export function lavalinkNodesFromEnv(): LavalinkNodeConfig[] {
  const password = process.env.LAVALINK_PASSWORD?.trim() || DEFAULT_LAVALINK_PASSWORD;
  const port = intEnv("LAVALINK_PORT", DEFAULT_LAVALINK_PORT);
  const secure = boolEnv("LAVALINK_SECURE", false);

  const configured = (process.env.LAVALINK_NODES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (configured.length > 0) {
    const nodes: LavalinkNodeConfig[] = [];
    configured.forEach((entry, index) => {
      const node = parseLavalinkNode(entry, password, index);
      if (node) nodes.push(node);
    });
    if (nodes.length > 0) return nodes;
  }

  // No LAVALINK_NODES → the single-node shorthand. Defaults match the bundled
  // node (docker/docker-compose.yml, deploy/laptop-install.sh): localhost:2333.
  const host = process.env.LAVALINK_HOST?.trim() || "localhost";
  return [{ name: "node-1", host, port, password, secure }];
}

/** True when an operator left the node password at Lavalink's public default. */
export function usingDefaultPassword(nodes: readonly LavalinkNodeConfig[]): boolean {
  return nodes.some((node) => node.password === DEFAULT_LAVALINK_PASSWORD);
}

// ── socket abstraction (so tests can drive the protocol) ────────────────

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: never[]) => void): void;
  removeAllListeners(): void;
}

export type SocketFactory = (url: string, options: { headers: Record<string, string> }) => SocketLike;

const defaultSocketFactory: SocketFactory = (url, options) =>
  new WebSocket(url, options) as unknown as SocketLike;

/** Raised for anything a node refused, or that couldn't reach it at all. */
export class LavalinkError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly nodeName?: string,
  ) {
    super(message);
    this.name = "LavalinkError";
  }
}

// ── a single node ──────────────────────────────────────────────────────

export class LavalinkNode extends EventEmitter {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;

  sessionId: string | null = null;
  connected = false;
  /** True while a reconnect backoff is pending. */
  reconnecting = false;
  stats: LavalinkStats | null = null;
  /** Guilds this worker plays through this node. */
  assignedGuilds = new Set<string>();

  private socket: SocketLike | null = null;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private readonly socketFactory: SocketFactory;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly resumeTimeoutSeconds: number;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closedByUs = false;
  private userId = "";
  private clientName = DEFAULT_LAVALINK_CLIENT_NAME;

  constructor(config: LavalinkNodeConfig, options: Omit<LavalinkOptions, "nodes">) {
    super();
    this.name = config.name;
    this.host = config.host;
    this.port = config.port;
    this.secure = config.secure;
    this.password = config.password;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.reconnectMinMs = options.reconnectMinMs ?? 1_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.resumeTimeoutSeconds = options.resumeTimeoutSeconds ?? DEFAULT_RESUME_TIMEOUT_SECONDS;
  }

  get restUrl(): string {
    return `${this.secure ? "https" : "http"}://${this.host}:${this.port}`;
  }

  get wsUrl(): string {
    return `${this.secure ? "wss" : "ws"}://${this.host}:${this.port}/v4/websocket`;
  }

  /** Lavalink's documented node-selection penalty — lower wins. */
  get penalty(): number {
    const stats = this.stats;
    if (!stats) return Number.POSITIVE_INFINITY;
    let value = stats.players;
    if (stats.frameStats) {
      value += stats.frameStats.deficit;
      value += stats.frameStats.nulled * 2;
    }
    value += Math.pow(1.05, 100 * stats.cpu.systemLoad) * 10 - 10;
    return value;
  }

  // ── websocket ────────────────────────────────────────────────────────

  /** Open the socket (or leave it alone if one is already open). */
  connect(userId: string, clientName = DEFAULT_LAVALINK_CLIENT_NAME): void {
    this.userId = userId;
    this.clientName = clientName;
    this.closedByUs = false;
    if (this.socket) return;

    const headers: Record<string, string> = {
      Authorization: this.password,
      "User-Id": userId,
      "Client-Name": clientName,
    };
    // Resume an interrupted session: playback keeps running across a blip and
    // the events we missed are replayed to us when the socket comes back.
    if (this.sessionId) headers["Session-Id"] = this.sessionId;

    let socket: SocketLike;
    try {
      socket = this.socketFactory(this.wsUrl, { headers });
    } catch (error) {
      log.warn("lavalink socket could not be created", { node: this.name, error: String(error) });
      this.emit("error", { node: this, error });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on("open", () => {
      this.connected = true;
      log.info("lavalink socket open", { node: this.name, url: this.wsUrl });
    });

    socket.on("message", (data: unknown) => this.handleMessage(data));

    socket.on("close", (code: unknown, reason: unknown) => {
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      log.warn("lavalink socket closed", {
        node: this.name,
        code: typeof code === "number" ? code : undefined,
        reason: reason ? String(reason) : undefined,
        wasConnected,
        byUs: this.closedByUs,
      });
      this.emit("disconnect", { node: this, code, reason });
      if (!this.closedByUs) this.scheduleReconnect();
    });

    socket.on("error", (error: unknown) => {
      // `close` follows and owns the reconnect; this is only the log line.
      log.warn("lavalink socket error", { node: this.name, error: String(error).slice(0, 300) });
      this.emit("error", { node: this, error });
    });

    socket.on("unexpected-response", (...args: unknown[]) => {
      const status = (args[1] as { statusCode?: number } | undefined)?.statusCode;
      log.warn("lavalink handshake refused", { node: this.name, status });
      this.emit("error", {
        node: this,
        error: new LavalinkError(`handshake refused (HTTP ${status ?? "?"}) — wrong LAVALINK_PASSWORD?`, status, this.name),
      });
    });
  }

  /** Stop for good (worker shutdown). No reconnect afterwards. */
  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (socket) {
      try {
        socket.removeAllListeners();
        socket.close(1000, "shutdown");
      } catch {
        // already gone
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUs || this.reconnectTimer) return;
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    // Exponential backoff with jitter: a restarting node shouldn't be hammered
    // by every worker at the same instant.
    const base = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** (this.reconnectAttempts - 1));
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    log.info("lavalink reconnect scheduled", { node: this.name, attempt: this.reconnectAttempts, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnecting = false;
      if (this.closedByUs || !this.userId) return;
      this.connect(this.userId, this.clientName);
    }, delay);
    // A pending reconnect must never hold the event loop open on shutdown.
    this.reconnectTimer.unref?.();
  }

  private handleMessage(data: unknown): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(typeof data === "string" ? data : String(data)) as Record<string, unknown>;
    } catch {
      log.warn("lavalink sent a non-JSON frame", { node: this.name });
      return;
    }

    switch (payload.op) {
      case "ready": {
        const sessionId = String(payload.sessionId ?? "");
        const resumed = Boolean(payload.resumed);
        this.connected = true;
        this.reconnectAttempts = 0;
        this.sessionId = sessionId;
        log.info("lavalink ready", { node: this.name, sessionId, resumed });
        this.emit("ready", { node: this, sessionId, resumed });
        // Ask the node to keep our players alive (and playing) while our socket
        // is down, so a worker restart or a network blip doesn't cut a song off.
        if (!resumed) void this.updateSession({ resuming: true, timeout: this.resumeTimeoutSeconds });
        return;
      }
      case "stats": {
        this.stats = payload as unknown as LavalinkStats;
        this.emit("stats", { node: this, stats: this.stats });
        return;
      }
      case "playerUpdate": {
        this.emit("playerUpdate", {
          node: this,
          guildId: String(payload.guildId ?? ""),
          state: payload.state as LavalinkPlayerState,
        });
        return;
      }
      case "event": {
        this.emit("event", { node: this, payload });
        return;
      }
      default:
        log.info("lavalink op ignored", { node: this.name, op: payload.op });
    }
  }

  // ── REST ─────────────────────────────────────────────────────────────

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.restUrl}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: this.password,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const hint =
        this.host === "localhost" || this.host === "127.0.0.1" || this.host === "lavalink"
          ? ` Start it with: docker compose -f docker/docker-compose.yml up -d lavalink (repo root) or deploy/laptop-install.sh. Check curl http://localhost:${this.port}/version and docker logs monarch-lavalink.`
          : ` Check that ${this.host}:${this.port} is reachable and LAVALINK_PASSWORD matches its application.yml.`;
      throw new LavalinkError(
        `Couldn't reach the Lavalink node at ${this.host}:${this.port} (${String(error).slice(0, 120)}).${hint}`,
        undefined,
        this.name,
      );
    }

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const error = (await response.json()) as { message?: string; error?: string };
        message = error.message || error.error || message;
      } catch {
        // non-JSON error body
      }
      throw new LavalinkError(`Lavalink ${method} ${path} failed: ${message}`, response.status, this.name);
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  /** `GET /v4/loadtracks?identifier=…` */
  loadTracks(identifier: string): Promise<LavalinkLoadResult> {
    return this.request<LavalinkLoadResult>("GET", `/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`);
  }

  /** `PATCH /v4/sessions/{sessionId}/players/{guildId}` */
  updatePlayer(guildId: string, payload: PlayerUpdatePayload, noReplace = false): Promise<unknown> {
    return this.request("PATCH", `/v4/sessions/${this.requireSession()}/players/${guildId}?noReplace=${noReplace}`, payload);
  }

  /** `DELETE /v4/sessions/{sessionId}/players/{guildId}` — stop and disconnect. */
  destroyPlayer(guildId: string): Promise<void> {
    const path = `/v4/sessions/${this.requireSession()}/players/${guildId}`;
    this.assignedGuilds.delete(guildId);
    return this.request<void>("DELETE", path);
  }

  /** `PATCH /v4/sessions/{sessionId}` — the session resuming window. */
  updateSession(payload: { resuming: boolean; timeout: number }): Promise<unknown> {
    return this.request("PATCH", `/v4/sessions/${this.requireSession()}`, payload);
  }

  /** `GET /v4/stats` — for health checks and node selection. */
  fetchStats(): Promise<LavalinkStats> {
    return this.request<LavalinkStats>("GET", "/v4/stats");
  }

  /** `GET /v4/info` — what the node can do; used by the preflight check. */
  fetchInfo(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/v4/info");
  }

  private requireSession(): string {
    if (!this.sessionId) {
      throw new LavalinkError(
        `The Lavalink node ${this.name} (${this.host}:${this.port}) has no session yet — it isn't connected.`,
        undefined,
        this.name,
      );
    }
    return this.sessionId;
  }
}

// ── the manager ────────────────────────────────────────────────────────

export interface LavalinkEventMap {
  nodeReady: { node: LavalinkNode; sessionId: string; resumed: boolean };
  nodeDisconnect: { node: LavalinkNode; code?: unknown; reason?: unknown };
  /** The socket came back. `resumed: false` means its players are gone. */
  nodeReconnect: { node: LavalinkNode; sessionId: string; resumed: boolean };
  nodeError: { node: LavalinkNode; error: unknown };
  trackStart: { guildId: string; track: LavalinkTrack; node: LavalinkNode };
  trackEnd: { guildId: string; track: LavalinkTrack | null; reason: TrackEndReason; node: LavalinkNode };
  trackException: { guildId: string; track: LavalinkTrack | null; exception: LavalinkException; node: LavalinkNode };
  trackStuck: { guildId: string; track: LavalinkTrack | null; thresholdMs: number; node: LavalinkNode };
  playerUpdate: { guildId: string; state: LavalinkPlayerState; node: LavalinkNode };
  voiceSocketClosed: { guildId: string; code: number; reason: string; byRemote: boolean; node: LavalinkNode };
}

export class LavalinkManager extends EventEmitter {
  readonly nodes: LavalinkNode[];
  private readonly guildNodes = new Map<string, LavalinkNode>();
  private readonly options: Omit<LavalinkOptions, "nodes">;
  private started = false;
  private userId = "";

  constructor(options: LavalinkOptions) {
    super();
    this.options = options;
    this.userId = options.userId;
    this.nodes = options.nodes.map((config) => new LavalinkNode(config, options));
    for (const node of this.nodes) this.wire(node);
  }

  /** Forward one node's events as the manager's typed events. */
  private wire(node: LavalinkNode): void {
    node.on("ready", (payload: LavalinkEventMap["nodeReady"]) => {
      this.emit("nodeReady", payload);
      this.emit("nodeReconnect", payload);
    });
    node.on("disconnect", (payload: LavalinkEventMap["nodeDisconnect"]) => {
      this.emit("nodeDisconnect", payload);
    });
    node.on("error", (payload: LavalinkEventMap["nodeError"]) => {
      this.emit("nodeError", payload);
    });
    node.on("playerUpdate", (payload: LavalinkEventMap["playerUpdate"]) => {
      this.emit("playerUpdate", payload);
    });
    node.on("event", (payload: { node: LavalinkNode; payload: Record<string, unknown> }) => {
      this.dispatchEvent(payload.node, payload.payload);
    });
  }

  private dispatchEvent(node: LavalinkNode, payload: Record<string, unknown>): void {
    const guildId = String(payload.guildId ?? "");
    const track = (payload.track as LavalinkTrack | undefined) ?? null;
    switch (payload.type) {
      case "TrackStartEvent":
        this.emit("trackStart", { guildId, track: track as LavalinkTrack, node });
        return;
      case "TrackEndEvent":
        this.emit("trackEnd", { guildId, track, reason: (payload.reason as TrackEndReason) ?? "finished", node });
        return;
      case "TrackExceptionEvent":
        this.emit("trackException", { guildId, track, exception: payload.exception as LavalinkException, node });
        return;
      case "TrackStuckEvent":
        this.emit("trackStuck", { guildId, track, thresholdMs: Number(payload.thresholdMs ?? 0), node });
        return;
      case "WebSocketClosedEvent":
        this.emit("voiceSocketClosed", {
          guildId,
          code: Number(payload.code ?? 0),
          reason: String(payload.reason ?? ""),
          byRemote: Boolean(payload.byRemote),
          node,
        });
        return;
      default:
        log.info("lavalink event ignored", { node: node.name, type: payload.type, guildId });
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  /** Open every node's socket. Idempotent. */
  start(userId?: string): void {
    if (userId) this.userId = userId;
    if (this.started || !this.userId) return;
    this.started = true;
    log.info("lavalink connecting", { userId: this.userId, nodes: this.describe() });
    for (const node of this.nodes) node.connect(this.userId, this.options.clientName);
  }

  /** Close every socket and forget the guild→node map (worker shutdown). */
  stop(): void {
    this.started = false;
    for (const node of this.nodes) node.close();
    this.guildNodes.clear();
  }

  get isStarted(): boolean {
    return this.started;
  }

  get connectedNodes(): LavalinkNode[] {
    return this.nodes.filter((node) => node.connected && node.sessionId !== null);
  }

  /**
   * Resolve when at least one node has a session, so playback doesn't race the
   * handshake right after boot. Rejects with a message worth showing a user.
   */
  whenReady(timeoutMs = 10_000): Promise<LavalinkNode> {
    const existing = this.connectedNodes[0];
    if (existing) return Promise.resolve(existing);
    return new Promise<LavalinkNode>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("nodeReady", onReady);
        const hint =
          this.nodes.some((n) => n.host === "localhost" || n.host === "127.0.0.1" || n.host === "lavalink") ||
          this.nodes.length === 0
            ? " Start it: docker compose -f docker/docker-compose.yml up -d lavalink (repo root) or ./deploy/laptop-install.sh. Then curl http://localhost:2333/version and check docker logs monarch-lavalink / journalctl -u monarch-lavalink. Also verify LAVALINK_PASSWORD matches docker/lavalink/application.yml."
            : " Check LAVALINK_NODES / LAVALINK_PASSWORD and that the node is reachable.";
        reject(
          new LavalinkError(
            `No Lavalink node answered within ${Math.round(timeoutMs / 1000)}s (${this.describe()}).` + hint,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      const onReady = (payload: LavalinkEventMap["nodeReady"]) => {
        clearTimeout(timer);
        this.off("nodeReady", onReady as never);
        resolve(payload.node);
      };
      this.on("nodeReady", onReady);
    });
  }

  /**
   * The node this guild plays through. A guild stays on its node while that
   * node is up (moving players mid-song is how songs restart), and stays put
   * during a full outage so its session can resume where it was.
   */
  nodeFor(guildId: string): LavalinkNode {
    const existing = this.guildNodes.get(guildId);
    const connected = this.connectedNodes;
    if (existing && (existing.connected || connected.length === 0)) return existing;

    const candidates = connected.length > 0 ? connected : this.nodes;
    const chosen = candidates.reduce<LavalinkNode | null>(
      (winner, node) => (!winner || node.penalty < winner.penalty ? node : winner),
      null,
    );
    if (!chosen) {
      throw new LavalinkError("No Lavalink node is configured — set LAVALINK_NODES (see .env.example).");
    }
    this.guildNodes.set(guildId, chosen);
    return chosen;
  }

  /** Forget a guild's assignment (its player was destroyed). */
  release(guildId: string): void {
    this.guildNodes.get(guildId)?.assignedGuilds.delete(guildId);
    this.guildNodes.delete(guildId);
  }

  /** The node a guild is pinned to, if any. */
  nodeOf(guildId: string): LavalinkNode | null {
    return this.guildNodes.get(guildId) ?? null;
  }

  // ── track + player API ───────────────────────────────────────────────

  /** Resolve an identifier (URL, `ytsearch:…`, bare video id) into tracks. */
  loadTracks(identifier: string, guildId?: string): Promise<LavalinkLoadResult> {
    const node = guildId ? this.nodeFor(guildId) : this.pickForLoading();
    return node.loadTracks(identifier);
  }

  private pickForLoading(): LavalinkNode {
    const candidates = this.connectedNodes.length > 0 ? this.connectedNodes : this.nodes;
    const node = candidates.reduce<LavalinkNode | null>(
      (winner, candidate) => (!winner || candidate.penalty < winner.penalty ? candidate : winner),
      null,
    );
    if (!node) throw new LavalinkError("No Lavalink node is configured — set LAVALINK_NODES (see .env.example).");
    return node;
  }

  async updatePlayer(guildId: string, payload: PlayerUpdatePayload, noReplace = false): Promise<unknown> {
    const node = this.nodeFor(guildId);
    node.assignedGuilds.add(guildId);
    return node.updatePlayer(guildId, payload, noReplace);
  }

  /** Hand the node Discord's voice credentials so it can join the voice server. */
  updateVoice(guildId: string, voice: LavalinkVoiceState): Promise<unknown> {
    return this.updatePlayer(guildId, { voice });
  }

  /**
   * Play an already-loaded track. The node resolves the actual audio when
   * playback starts, which is why queuing is instant and why a track that
   * fails there answers as `TrackEndEvent(loadFailed)`.
   *
   * `userData` is echoed back on every event for this track, so the caller can
   * tell a late event for an old track from one about the current track.
   */
  play(guildId: string, encoded: string, options: { volume?: number; userData?: Record<string, unknown> } = {}): Promise<unknown> {
    return this.updatePlayer(guildId, {
      track: { encoded, ...(options.userData ? { userData: options.userData } : {}) },
      paused: false,
      position: 0,
      ...(options.volume === undefined ? {} : { volume: options.volume }),
    });
  }

  /** Stop the current track, keeping the player (and the voice link) alive. */
  stopTrack(guildId: string): Promise<unknown> {
    return this.updatePlayer(guildId, { track: { encoded: null } });
  }

  pause(guildId: string, paused: boolean): Promise<unknown> {
    return this.updatePlayer(guildId, { paused });
  }

  setVolume(guildId: string, volume: number): Promise<unknown> {
    return this.updatePlayer(guildId, { volume });
  }

  seek(guildId: string, positionMs: number): Promise<unknown> {
    return this.updatePlayer(guildId, { position: positionMs });
  }

  /** Stop, disconnect from voice and free the node's resources for this guild. */
  async destroyPlayer(guildId: string): Promise<void> {
    const node = this.nodeOf(guildId);
    this.release(guildId);
    if (!node?.sessionId) return;
    try {
      await node.destroyPlayer(guildId);
    } catch (error) {
      log.warn("lavalink destroyPlayer failed", { guildId, node: node.name, error: String(error).slice(0, 200) });
    }
  }

  /** One line for logs and status output. */
  describe(): string {
    return this.nodes
      .map((node) =>
        `${node.name}(${node.host}:${node.port}) ${node.connected ? `ready:${node.sessionId}` : node.reconnecting ? "reconnecting" : "down"}`,
      )
      .join(", ");
  }

  // Typed event surface, so strict-mode call sites can't typo an event name.
  override on<K extends keyof LavalinkEventMap>(event: K, listener: (payload: LavalinkEventMap[K]) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof LavalinkEventMap>(event: K, listener: (payload: LavalinkEventMap[K]) => void): this;
  override off(event: string, listener: (...args: never[]) => void): this;
  override off(event: string, listener: (...args: never[]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  override once<K extends keyof LavalinkEventMap>(event: K, listener: (payload: LavalinkEventMap[K]) => void): this;
  override once(event: string, listener: (...args: never[]) => void): this;
  override once(event: string, listener: (...args: never[]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof LavalinkEventMap>(event: K, payload: LavalinkEventMap[K]): boolean;
  override emit(event: string, ...args: unknown[]): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
}

// ── process-wide instance ──────────────────────────────────────────────

let shared: LavalinkManager | null = null;

/** The worker's single Lavalink manager, built from `.env` on first use. */
export function getLavalink(userId = ""): LavalinkManager {
  if (!shared) {
    const nodes = lavalinkNodesFromEnv();
    if (usingDefaultPassword(nodes)) {
      log.warn("using Lavalink's default node password", {
        hint: "set LAVALINK_PASSWORD here and in the node's application.yml",
      });
    }
    shared = new LavalinkManager({
      nodes,
      userId,
      clientName: process.env.LAVALINK_CLIENT_NAME?.trim() || DEFAULT_LAVALINK_CLIENT_NAME,
      resumeTimeoutSeconds: intEnv("LAVALINK_RESUME_SECONDS", DEFAULT_RESUME_TIMEOUT_SECONDS),
      reconnectMinMs: intEnv("LAVALINK_RECONNECT_MIN_MS", 1_000),
      reconnectMaxMs: intEnv("LAVALINK_RECONNECT_MAX_MS", 30_000),
    });
    log.info("lavalink configured", { nodes: shared.describe() });
  }
  return shared;
}

/** Replace (or clear) the shared manager — used by tests and worker boot. */
export function setLavalink(manager: LavalinkManager | null): void {
  shared = manager;
}
