import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { DEFAULT_COMMAND_PREFIX } from "@monarch/shared";
import { BurgRegistry } from "../src/burg.js";
import { JailRegistry } from "../src/jail.js";
import { MonarchCommands } from "../src/monarch-commands.js";
import { formatDuration, toGalactic } from "../src/galactic.js";
import type { MusicCommands } from "../src/music/commands.js";
import { handlePrefixMessage, type PrefixDispatcherDeps } from "../src/prefix/dispatch.js";
import { PrefixRegistry } from "../src/prefix/registry.js";

/**
 * End-to-end tests for the prefix surface: a fake gateway message goes into
 * `handlePrefixMessage` and the real handlers (MonarchCommands + the real
 * jail/burg registries) run against it. The point is the *wiring* — that the
 * text surface reaches the same code as the slash surface with the same
 * permission checks, and that ordinary messages are left alone.
 */

const BOT_ID = "900000000000000001";
const GUILD_ID = "800000000000000001";
const MOD_ID = "700000000000000001";
const TARGET_ID = "600000000000000001";

const ADMIN = PermissionFlagsBits.Administrator;
const KICK = PermissionFlagsBits.KickMembers;
const NOTHING = 0n;

interface FakeOptions {
  content?: string;
  authorId?: string;
  /** Permission bits for the invoking member. */
  perms?: bigint;
  /** Permission bits Monarch itself holds in this guild. */
  botPerms?: bigint;
  /** Highest-role position of the (fake) target member. */
  targetPosition?: number;
  /** Highest-role position of the invoking member. */
  invokerPosition?: number;
  inVoice?: boolean;
}

/**
 * A stand-in for a discord.js GuildMember: it carries its User (handlers read
 * `member.user.bot`) and a real PermissionsBitField (handlers call
 * `permissions.has(...)`, which is where Discord's "Administrator implies
 * everything" rule lives).
 */
function memberFor(id: string, perms: bigint, extra: Record<string, unknown> = {}) {
  return {
    id,
    permissions: new PermissionsBitField(perms),
    roles: { highest: { position: id === TARGET_ID ? 0 : 5 } },
    displayName: `member-${id}`,
    user: { id, bot: false, username: `user-${id}`, displayName: `member-${id}` },
    voice: { channel: null },
    ...extra,
  };
}

function fakeMessage(options: FakeOptions = {}) {
  const authorId = options.authorId ?? MOD_ID;
  const perms = options.perms ?? ADMIN;
  const channel = {
    id: "500000000000000001",
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    send: vi.fn(async () => ({ id: "m1", edit: vi.fn(async () => ({})) })),
  };
  const target = memberFor(TARGET_ID, NOTHING, {
    roles: { highest: { position: options.targetPosition ?? 0 } },
  });
  const mentions = new Map<string, unknown>();
  for (const id of options.content?.match(/<@!?(\d{15,25})>/g)?.map((m) => m.replace(/\D/g, "")) ?? []) {
    mentions.set(id, id === TARGET_ID ? target : memberFor(id, NOTHING));
  }
  const guild = {
    id: GUILD_ID,
    name: "Test Guild",
    ownerId: "111111111111111111",
    members: {
      me: memberFor(BOT_ID, options.botPerms ?? ADMIN | PermissionFlagsBits.ManageMessages),
      cache: new Map([[TARGET_ID, target]]),
      fetch: vi.fn(async (id: string) => {
        if (id !== TARGET_ID) throw new Error("Unknown Member");
        return target;
      }),
    },
    channels: { cache: new Map([[channel.id, channel]]) },
  };
  const author = { id: authorId, bot: false, displayName: "Invoker", username: "invoker" };
  const message = {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    content: options.content ?? "",
    guildId: GUILD_ID,
    channelId: channel.id,
    author,
    member: memberFor(authorId, perms, {
      roles: { highest: { position: options.invokerPosition ?? 5 } },
      voice: { channel: options.inVoice ? { id: "voice-1", name: "Stage" } : null },
    }),
    guild,
    channel,
    mentions: {
      users: { first: () => (mentions.size > 0 ? { id: [...mentions.keys()][0] } : null) },
      members: {
        first: () => (mentions.size > 0 ? mentions.get([...mentions.keys()][0]!) : null),
        get: (id: string) => mentions.get(id) ?? null,
      },
      channels: { first: () => null },
    },
    attachments: [],
    stickers: [],
    webhookId: null,
    system: false,
    inGuild: () => true,
    delete: vi.fn(async () => ({})),
  };
  return message as never;
}

function sent(message: ReturnType<typeof fakeMessage>) {
  const channel = (message as unknown as { channel: { send: ReturnType<typeof vi.fn> } }).channel;
  return channel.send.mock.calls.map((call) => call[0] as { content?: string; embeds?: unknown[] });
}

function text(message: ReturnType<typeof fakeMessage>): string {
  return sent(message)
    .map((payload) => [payload.content ?? "", ...(payload.embeds ?? []).map(() => "[embed]")].join(" "))
    .join("\n");
}

let jail: JailRegistry;
let burg: BurgRegistry;
let prefixes: PrefixRegistry;
let musicStub: { run: ReturnType<typeof vi.fn> };
let deps: PrefixDispatcherDeps;
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

function setup(options: { internalToken?: string; enabled?: boolean; clientId?: string | null } = {}) {
  jail = new JailRegistry();
  burg = new BurgRegistry();
  prefixes = new PrefixRegistry();
  musicStub = { run: vi.fn(async () => {}) };
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  deps = {
    prefixes,
    monarch: new MonarchCommands({
      appUrl: "https://monarch.example",
      internalToken: options.internalToken,
      jail,
      burg,
      prefixes,
      messageGagsEnabled: () => options.enabled ?? true,
      // Omitted by default: `!invite` then falls back to the bot's own user id,
      // which is what a real worker does when DISCORD_CLIENT_ID is unset.
      clientId: options.clientId,
      log,
    }),
    music: () => musicStub as unknown as MusicCommands,
    botUserId: () => BOT_ID,
    enabled: () => options.enabled ?? true,
    log,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setup();
});

describe("dispatch: what counts as a command", () => {
  it("ignores ordinary conversation", async () => {
    const message = fakeMessage({ content: "anyone up for a game?" });
    expect(await handlePrefixMessage(message, deps)).toBe(false);
    expect(sent(message)).toHaveLength(0);
  });

  it("ignores another bot's prefix instead of answering it", async () => {
    const message = fakeMessage({ content: "!ban @someone" });
    expect(await handlePrefixMessage(message, deps)).toBe(false);
    expect(sent(message)).toHaveLength(0);
  });

  it("ignores a lone prefix but answers a lone mention", async () => {
    const bang = fakeMessage({ content: "!" });
    expect(await handlePrefixMessage(bang, deps)).toBe(false);
    expect(sent(bang)).toHaveLength(0);

    const mention = fakeMessage({ content: `<@${BOT_ID}>` });
    expect(await handlePrefixMessage(mention, deps)).toBe(true);
    expect(text(mention)).toContain("Monarch — Design your Discord");
    expect(text(mention)).toContain("!help");
  });

  it("answers an unknown command addressed to Monarch", async () => {
    const message = fakeMessage({ content: `<@${BOT_ID}> frobnicate` });
    expect(await handlePrefixMessage(message, deps)).toBe(true);
    expect(text(message)).toContain("isn't a Monarch command");
    expect(text(message)).toContain("!help");
  });

  it("does nothing at all when the Message Content intent is off", async () => {
    setup({ enabled: false });
    const message = fakeMessage({ content: "!help" });
    expect(await handlePrefixMessage(message, deps)).toBe(false);
    expect(sent(message)).toHaveLength(0);
  });

  it("stays quiet when Monarch can't send messages in that channel", async () => {
    const message = fakeMessage({ content: "!help" });
    (message as unknown as { channel: { permissionsFor: () => { has: () => boolean } } }).channel.permissionsFor =
      () => ({ has: () => false });
    expect(await handlePrefixMessage(message, deps)).toBe(true);
    expect(sent(message)).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("dispatch: general commands", () => {
  it("!help posts the catalog embed with the prefix line", async () => {
    const message = fakeMessage({ content: "!help" });
    expect(await handlePrefixMessage(message, deps)).toBe(true);
    const payload = sent(message)[0]!;
    expect(payload.embeds).toHaveLength(1);
    const embed = payload.embeds![0] as { description: string; fields: { value: string }[] };
    expect(embed.description).toContain("Prefix commands");
    expect(embed.fields.map((f) => f.value).join("\n")).toContain("/monarch jail");
    // A help reply must not ping anybody.
    expect(payload.content ?? "").toBe("");
    expect((payload as unknown as { allowedMentions: { parse: string[] } }).allowedMentions.parse).toEqual([]);
  });

  it("!commands is the same command", async () => {
    const message = fakeMessage({ content: "!commands" });
    expect(await handlePrefixMessage(message, deps)).toBe(true);
    expect(sent(message)[0]!.embeds).toHaveLength(1);
  });

  it("!dashboard and !status answer with the server's links and prefix", async () => {
    const dash = fakeMessage({ content: "!dashboard" });
    await handlePrefixMessage(dash, deps);
    expect(text(dash)).toContain(`https://monarch.example/s/${GUILD_ID}`);

    const status = fakeMessage({ content: "!monarch status" });
    await handlePrefixMessage(status, deps);
    expect(text(status)).toContain("Test Guild");
    expect(text(status)).toContain("Prefix: `!`");
  });

  it("!prefix shows the current prefix and how to change it", async () => {
    const message = fakeMessage({ content: "!prefix" });
    await handlePrefixMessage(message, deps);
    expect(text(message)).toContain("**Prefix in Test Guild**: `!` (the default)");
    expect(text(message)).toContain("!prefix set <new>");
  });

  it("!prefix set explains what's missing without INTERNAL_API_TOKEN", async () => {
    const message = fakeMessage({ content: "!prefix set ?" });
    await handlePrefixMessage(message, deps);
    expect(text(message)).toContain("INTERNAL_API_TOKEN");
    expect(text(message)).toContain("`!`");
  });

  it("!invite works for a member with no permissions at all", async () => {
    setup({ clientId: "123456789012345678" });
    const message = fakeMessage({
      content: "!invite",
      authorId: TARGET_ID,
      perms: NOTHING,
      invokerPosition: 0,
    });
    expect(await handlePrefixMessage(message, deps)).toBe(true);

    const reply = text(message);
    const url = new URL(reply.match(/https:\/\/discord\.com\/oauth2\/authorize\?\S+/)![0]);
    expect(url.searchParams.get("client_id")).toBe("123456789012345678");
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    // No guild_id: the link is for *another* server, so the dialog must stay open.
    expect(url.searchParams.get("guild_id")).toBeNull();
    expect(url.searchParams.get("disable_guild_select")).toBeNull();
    expect(BigInt(url.searchParams.get("permissions")!) & 0b1000n).toBe(0n); // never Administrator
    expect(reply).toContain("never Administrator");
  });

  it("!add and !monarch invite are the same command", async () => {
    setup({ clientId: "123456789012345678" });
    for (const content of ["!add", "!monarch invite", `<@${BOT_ID}> invite`]) {
      const message = fakeMessage({ content, perms: NOTHING, authorId: TARGET_ID });
      expect(await handlePrefixMessage(message, deps), content).toBe(true);
      expect(text(message), content).toContain("discord.com/oauth2/authorize");
    }
  });

  it("!invite falls back to the bot's own application id", async () => {
    setup(); // no clientId — a worker without DISCORD_CLIENT_ID still knows who it is
    const message = fakeMessage({ content: "!invite", perms: NOTHING, authorId: TARGET_ID });
    await handlePrefixMessage(message, deps);
    const url = new URL(text(message).match(/https:\/\/discord\.com\/oauth2\/authorize\?\S+/)![0]);
    expect(url.searchParams.get("client_id")).toBe(BOT_ID);
  });

  it("!invite quotes the server's own prefix, and says what's missing with no application id", async () => {
    setup({ clientId: "123456789012345678" });
    // A stored custom prefix needs a store; `set()` refuses without one.
    // Assigned *after* setup() because setup() rebinds both `prefixes` and `deps`.
    prefixes = new PrefixRegistry({ store: { load: vi.fn(async () => "?"), save: vi.fn(async () => {}) } });
    deps.prefixes = prefixes;
    const withPrefix = fakeMessage({ content: "?invite", perms: NOTHING, authorId: TARGET_ID });
    await handlePrefixMessage(withPrefix, deps);
    expect(text(withPrefix)).toContain("`?help`");
    expect(text(withPrefix)).toContain("`?prefix set <new>`");

    setup({ clientId: null });
    deps.botUserId = () => null;
    const noId = fakeMessage({ content: "!invite", perms: NOTHING, authorId: TARGET_ID });
    await handlePrefixMessage(noId, deps);
    expect(text(noId)).toContain("DISCORD_CLIENT_ID");
    expect(text(noId)).toContain("https://monarch.example"); // the dashboard's invite button
    expect(text(noId)).not.toContain("discord.com/oauth2/authorize");
  });

  it("!prefix set saves through the store and takes effect immediately", async () => {
    const save = vi.fn(async () => {});
    setup();
    prefixes = new PrefixRegistry({ store: { load: vi.fn(async () => null), save } });
    deps.prefixes = prefixes;
    deps.monarch = new MonarchCommands({
      appUrl: "https://monarch.example",
      internalToken: "token",
      jail,
      burg,
      prefixes,
      messageGagsEnabled: () => true,
      log,
    });

    const message = fakeMessage({ content: "!prefix set ?" });
    await handlePrefixMessage(message, deps);
    expect(save).toHaveBeenCalledWith(GUILD_ID, "?");
    expect(text(message)).toContain("now `?`");

    const next = fakeMessage({ content: "?help" });
    expect(await handlePrefixMessage(next, deps)).toBe(true);
    expect(sent(next)[0]!.embeds).toHaveLength(1);
    // …and the default prefix keeps working so nobody gets locked out.
    const fallback = fakeMessage({ content: "!status" });
    expect(await handlePrefixMessage(fallback, deps)).toBe(true);
    expect(text(fallback)).toContain("Prefix: `?`");
  });

  it("!prefix reset needs Manage Server and clears the stored value", async () => {
    const save = vi.fn(async () => {});
    prefixes = new PrefixRegistry({ store: { load: vi.fn(async () => "m!"), save } });
    prefixes.remember(GUILD_ID, "m!");
    deps.prefixes = prefixes;
    deps.monarch = new MonarchCommands({
      appUrl: "https://monarch.example",
      internalToken: "token",
      jail,
      burg,
      prefixes,
      messageGagsEnabled: () => true,
      log,
    });

    const pleb = fakeMessage({ content: "!prefix reset", authorId: TARGET_ID, perms: NOTHING });
    await handlePrefixMessage(pleb, deps);
    expect(text(pleb)).toContain("Manage Server");
    expect(save).not.toHaveBeenCalled();

    const mod = fakeMessage({ content: "m!prefix reset" });
    await handlePrefixMessage(mod, deps);
    expect(save).toHaveBeenCalledWith(GUILD_ID, null);
    expect(text(mod)).toContain("reset to the default");
  });

  it("rejects a prefix that would swallow ordinary words", async () => {
    prefixes = new PrefixRegistry({ store: { load: vi.fn(async () => null), save: vi.fn(async () => {}) } });
    deps.prefixes = prefixes;
    deps.monarch = new MonarchCommands({
      appUrl: "https://monarch.example",
      internalToken: "token",
      jail,
      burg,
      prefixes,
      messageGagsEnabled: () => true,
      log,
    });

    const message = fakeMessage({ content: "!prefix set hey" });
    await handlePrefixMessage(message, deps);
    expect(text(message)).toContain("punctuation");
  });
});

describe("dispatch: the jail gag runs the same checks as /monarch jail", () => {
  it("jails the mentioned member and says for how long", async () => {
    // The confirmation quotes whatever is left of the sentence, so pin the
    // clock: without this a slow machine renders "9m 59s" and the test lies.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    const message = fakeMessage({ content: `!jail <@${TARGET_ID}> 10m being silly` });
    await handlePrefixMessage(message, deps);
    expect(jail.isJailed(GUILD_ID, TARGET_ID)).toBe(true);
    const entry = jail.get(GUILD_ID, TARGET_ID)!;
    expect(entry.until).toBe(Date.now() + 10 * 60 * 1000); // exactly ten minutes
    expect(entry.jailedBy).toBe(MOD_ID);
    expect(text(message)).toContain(`is jailed for **${formatDuration(entry.until! - Date.now())}**`);
    expect(text(message)).toContain(`until <t:${Math.floor(entry.until! / 1000)}:f>`);
    expect(text(message)).toContain("being silly");
    // The galactic sample proves the relay is the Standard Galactic Alphabet.
    expect(text(message)).toContain(toGalactic("galactic"));
  });

  it("accepts a bare snowflake and the mirrored !monarch jail form", async () => {
    const byId = fakeMessage({ content: `!jail ${TARGET_ID}` });
    await handlePrefixMessage(byId, deps);
    expect(jail.isJailed(GUILD_ID, TARGET_ID)).toBe(true);
    expect(text(byId)).toContain("until released");

    jail.release(GUILD_ID, TARGET_ID);
    const mirrored = fakeMessage({ content: `!monarch jail <@${TARGET_ID}>` });
    await handlePrefixMessage(mirrored, deps);
    expect(jail.isJailed(GUILD_ID, TARGET_ID)).toBe(true);
    expect(jail.get(GUILD_ID, TARGET_ID)?.until).toBeNull();
    expect(text(byId)).toContain("!unjail"); // an open-ended sentence says how to end it
    expect(text(mirrored)).toContain("!unjail");
  });

  it("refuses without Kick Members, and says who can", async () => {
    const message = fakeMessage({ content: `!jail <@${TARGET_ID}>`, authorId: TARGET_ID, perms: NOTHING });
    await handlePrefixMessage(message, deps);
    expect(jail.isJailed(GUILD_ID, TARGET_ID)).toBe(false);
    expect(text(message)).toContain("Kick Members");
  });

  it("accepts Administrator as the wildcard it is on Discord", async () => {
    // JAIL_PERMISSIONS is literally [KickMembers]; an Administrator passes
    // because PermissionsBitField.has() short-circuits on Administrator —
    // the same rule the slash surface has always used.
    const message = fakeMessage({ content: `!jail <@${TARGET_ID}>`, perms: ADMIN });
    await handlePrefixMessage(message, deps);
    expect(jail.isJailed(GUILD_ID, TARGET_ID)).toBe(true);
  });

  it("refuses to jail yourself", async () => {
    const self = fakeMessage({ content: `!jail <@${MOD_ID}>` });
    await handlePrefixMessage(self, deps);
    expect(jail.isJailed(GUILD_ID, MOD_ID)).toBe(false);
    expect(text(self)).toContain("can't jail yourself");
  });

  it("refuses to jail someone whose highest role is above yours", async () => {
    const above = fakeMessage({
      content: `!jail <@${TARGET_ID}>`,
      authorId: "555555555555555555", // a moderator with a low role
      perms: KICK,
      invokerPosition: 1,
      targetPosition: 9,
    });
    await handlePrefixMessage(above, deps);
    expect(jail.isJailed(GUILD_ID, TARGET_ID)).toBe(false);
    expect(text(above)).toContain("highest role is below yours");
  });

  it("explains when the Message Content intent is off", async () => {
    setup({ enabled: false });
    deps.enabled = () => true; // the dispatcher runs; the gag itself is disabled
    const message = fakeMessage({ content: `!jail <@${TARGET_ID}>` });
    deps.monarch = new MonarchCommands({
      appUrl: "https://monarch.example",
      jail,
      burg,
      prefixes,
      messageGagsEnabled: () => false,
      log,
    });
    await handlePrefixMessage(message, deps);
    expect(jail.isJailed(GUILD_ID, TARGET_ID)).toBe(false);
    expect(text(message)).toContain("Message Content");
  });

  it("!unjail releases and !jailed lists", async () => {
    jail.jail({ guildId: GUILD_ID, userId: TARGET_ID, until: null, jailedBy: MOD_ID });

    const list = fakeMessage({ content: "!jailed" });
    await handlePrefixMessage(list, deps);
    expect(text(list)).toContain(`<@${TARGET_ID}>`);
    expect(text(list)).toContain("until released");

    const release = fakeMessage({ content: `!unjail <@${TARGET_ID}>` });
    await handlePrefixMessage(release, deps);
    expect(jail.isJailed(GUILD_ID, TARGET_ID)).toBe(false);
    expect(text(release)).toContain("has been released");

    const again = fakeMessage({ content: `!unjail <@${TARGET_ID}>` });
    await handlePrefixMessage(again, deps);
    expect(text(again)).toContain("isn't jailed");
  });

  it("refuses a duration it can't parse instead of jailing forever by accident", async () => {
    for (const content of [
      `!jail <@${TARGET_ID}> ten minutes`,
      `!jail <@${TARGET_ID}> 10 minutes`,
      `!jail <@${TARGET_ID}> 2 hours`,
      `!jail <@${TARGET_ID}> 0m`,
    ]) {
      jail.release(GUILD_ID, TARGET_ID);
      const message = fakeMessage({ content });
      await handlePrefixMessage(message, deps);
      expect(jail.isJailed(GUILD_ID, TARGET_ID), content).toBe(false);
      expect(text(message), content).toContain("didn't understand that duration");
    }
  });

  it("keeps ordinary reason words out of the duration slot", async () => {
    const message = fakeMessage({ content: `!jail <@${TARGET_ID}> spamming memes in general` });
    await handlePrefixMessage(message, deps);
    expect(jail.isJailed(GUILD_ID, TARGET_ID)).toBe(true);
    expect(jail.get(GUILD_ID, TARGET_ID)?.until).toBeNull(); // until released
    expect(text(message)).toContain("spamming memes in general");
  });
});

describe("dispatch: the burg gag", () => {
  it("toggles on and off with !burg", async () => {
    vi.useFakeTimers(); // the confirmation quotes time left, not time asked for
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    const on = fakeMessage({ content: `!burg <@${TARGET_ID}> 5m cat being cute` });
    await handlePrefixMessage(on, deps);
    expect(burg.isBurg(GUILD_ID, TARGET_ID)).toBe(true);
    expect(burg.get(GUILD_ID, TARGET_ID)?.style).toBe("cat");
    expect(text(on)).toContain("burg'd for **5m**");
    expect(text(on)).toContain("**cat** style");

    const off = fakeMessage({ content: `!burg <@${TARGET_ID}>` });
    await handlePrefixMessage(off, deps);
    expect(burg.isBurg(GUILD_ID, TARGET_ID)).toBe(false);
    expect(text(off)).toContain("no longer burg'd");
  });

  it("refuses to stack the two gags", async () => {
    jail.jail({ guildId: GUILD_ID, userId: TARGET_ID, until: null, jailedBy: MOD_ID });
    const message = fakeMessage({ content: `!burg <@${TARGET_ID}>` });
    await handlePrefixMessage(message, deps);
    expect(burg.isBurg(GUILD_ID, TARGET_ID)).toBe(false);
    expect(text(message)).toContain("already in the Galactic jail");
  });

  it("asks who to burg when no member is given", async () => {
    const message = fakeMessage({ content: "!burg" });
    await handlePrefixMessage(message, deps);
    expect(text(message)).toContain("Say who to burg");
  });
});

describe("dispatch: music commands", () => {
  it("routes !play with the whole search phrase as arguments", async () => {
    const message = fakeMessage({ content: "!play daft punk around the world" });
    await handlePrefixMessage(message, deps);
    expect(musicStub.run).toHaveBeenCalledOnce();
    const [ctx, sub] = musicStub.run.mock.calls[0]!;
    expect(sub).toBe("play");
    expect(ctx.args).toEqual(["daft", "punk", "around", "the", "world"]);
    expect(ctx.surface).toBe("prefix");
    expect(ctx.commandPrefix).toBe(DEFAULT_COMMAND_PREFIX);
    expect(ctx.guildId).toBe(GUILD_ID);
  });

  it("routes the mirrored form, aliases and numeric arguments", async () => {
    const mirrored = fakeMessage({ content: "!music play https://youtu.be/xyz" });
    await handlePrefixMessage(mirrored, deps);
    expect(musicStub.run.mock.calls.at(-1)![1]).toBe("play");

    const np = fakeMessage({ content: "!np" });
    await handlePrefixMessage(np, deps);
    expect(musicStub.run.mock.calls.at(-1)![1]).toBe("nowplaying");

    const queue = fakeMessage({ content: "!q 2" });
    await handlePrefixMessage(queue, deps);
    const [ctx, sub] = musicStub.run.mock.calls.at(-1)!;
    expect(sub).toBe("queue");
    expect(ctx.args).toEqual(["2"]);

    const stop = fakeMessage({ content: "!leave" });
    await handlePrefixMessage(stop, deps);
    expect(musicStub.run.mock.calls.at(-1)![1]).toBe("stop");
  });

  it("answers an unknown music subcommand instead of throwing", async () => {
    musicStub.run.mockRejectedValue(new Error("boom"));
    const message = fakeMessage({ content: "!play something" });
    await handlePrefixMessage(message, deps);
    expect(log.error).toHaveBeenCalled();
    expect(text(message)).toContain("Something went wrong");
  });
});

describe("dispatch: the jail relay still gets non-command messages", () => {
  it("returns false so a jailed member's ordinary message is relayed", async () => {
    jail.jail({ guildId: GUILD_ID, userId: TARGET_ID, until: null, jailedBy: MOD_ID });
    const message = fakeMessage({ content: "hello everyone", authorId: TARGET_ID, perms: NOTHING });
    expect(await handlePrefixMessage(message, deps)).toBe(false);
  });

  it("runs a jailed member's command as a command, not as a relay", async () => {
    jail.jail({ guildId: GUILD_ID, userId: MOD_ID, until: null, jailedBy: TARGET_ID });
    const message = fakeMessage({ content: "!jailed", authorId: MOD_ID });
    expect(await handlePrefixMessage(message, deps)).toBe(true);
    expect(text(message)).toContain("Jailed in Test Guild");
  });
});
