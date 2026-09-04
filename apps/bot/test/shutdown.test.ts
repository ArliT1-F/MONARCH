import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bot entry point runs its startup sequence at import time, so every test
 * here loads a fresh copy of it with discord.js stubbed out. What is under test
 * is the real src/index.ts: the signal handlers it registers on `process`, the
 * shutdown path they take, and the startup sequence they guard.
 */
const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  login: vi.fn(),
  put: vi.fn(),
  clientOn: vi.fn(),
  clientOnce: vi.fn(),
}));

vi.mock("discord.js", () => {
  const builder = () => ({
    setName: () => builder(),
    setDescription: () => builder(),
    addSubcommand: () => builder(),
    toJSON: () => ({ name: "monarch" }),
  });
  return {
    Client: vi.fn(() => ({ destroy: mocks.destroy, login: mocks.login, on: mocks.clientOn, once: mocks.clientOnce })),
    Events: { ClientReady: "ready", InteractionCreate: "interactionCreate", Error: "error" },
    GatewayIntentBits: { Guilds: 1 },
    MessageFlags: { Ephemeral: 64 },
    REST: vi.fn(() => ({ setToken: () => ({ put: mocks.put }) })),
    Routes: { applicationCommands: (id: string) => `/applications/${id}/commands` },
    SlashCommandBuilder: vi.fn(() => builder()),
  };
});

type LogLine = { stream: string; msg: string; [k: string]: unknown };

/** Thrown by the stubbed process.exit to mimic the process actually stopping. */
class ExitCalled extends Error {
  constructor(readonly code?: number) {
    super(`process.exit(${code})`);
  }
}

const originalOn = process.on.bind(process);
const signalEvents = new Set(["SIGTERM", "SIGINT"]);

let handlers: Map<string, Array<() => void>>;
let exitSpy: ReturnType<typeof stubExit>;
let lines: LogLine[];

/** process.exit must actually stop control flow, or the tests would run on. */
function stubExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
}

/** Import src/index.ts, intercepting the signal handlers it registers. */
async function boot(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  handlers = new Map();
  lines = [];

  process.env.DISCORD_BOT_TOKEN = "test-token";
  process.env.DISCORD_CLIENT_ID = "4242";
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  // Record SIGTERM/SIGINT handlers instead of attaching them to the test
  // worker, and let every other listener through untouched.
  vi.spyOn(process, "on").mockImplementation(((event: string, fn: () => void) => {
    if (signalEvents.has(event)) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
      return process;
    }
    return originalOn(event as never, fn as never);
  }) as never);

  exitSpy = stubExit();

  const capture = (stream: string) => (line: string) => lines.push({ stream, ...JSON.parse(line) });
  vi.spyOn(console, "log").mockImplementation(capture("log") as never);
  vi.spyOn(console, "warn").mockImplementation(capture("warn") as never);
  vi.spyOn(console, "error").mockImplementation(capture("error") as never);

  // An exit during module evaluation is expected on some startup paths.
  try {
    await import("../src/index.js");
  } catch (e) {
    if (!(e instanceof ExitCalled)) throw e;
  }
  await Promise.resolve(); // let registerCommands().then(login) settle
}

/** Invoke a registered signal handler the way the kernel would. */
function signal(name: "SIGTERM" | "SIGINT") {
  try {
    handlers.get(name)![0]!();
  } catch (e) {
    if (!(e instanceof ExitCalled)) throw e;
  }
}
const find = (msg: string) => lines.find((l) => l.msg === msg);

beforeEach(() => {
  mocks.destroy.mockReset();
  mocks.login.mockReset().mockResolvedValue("test-token");
  mocks.put.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  process.on = originalOn as never;
});

describe("bot startup", () => {
  it("registers slash commands, then logs in", async () => {
    await boot();

    expect(mocks.put).toHaveBeenCalledOnce();
    expect(mocks.login).toHaveBeenCalledWith("test-token");
    expect(find("registered slash commands")).toMatchObject({ level: "info", count: 1 });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("still logs in when slash command registration fails", async () => {
    mocks.put.mockRejectedValue(new Error("503: discord is having a day"));
    await boot();

    expect(find("slash command registration failed — continuing with existing commands")).toBeDefined();
    expect(mocks.login).toHaveBeenCalledWith("test-token");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits 0 when the bot token is missing (dashboard demo mode needs no bot)", async () => {
    await boot({ DISCORD_BOT_TOKEN: undefined });

    expect(mocks.login).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe("graceful shutdown", () => {
  it("registers handlers for both SIGTERM and SIGINT", async () => {
    await boot();

    expect(handlers.get("SIGTERM")).toHaveLength(1);
    expect(handlers.get("SIGINT")).toHaveLength(1);
  });

  it("closes the gateway session and exits 0 on SIGTERM", async () => {
    await boot();
    signal("SIGTERM");

    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(find("shutting down")).toMatchObject({ level: "info", signal: "SIGTERM" });
  });

  it("shuts down once when the runtime signals twice", async () => {
    await boot();
    signal("SIGTERM");
    signal("SIGINT");

    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it("still exits 0 when closing the gateway throws", async () => {
    await boot();
    mocks.destroy.mockImplementationOnce(() => {
      throw new Error("socket already gone");
    });
    signal("SIGTERM");

    expect(find("gateway close failed")).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
