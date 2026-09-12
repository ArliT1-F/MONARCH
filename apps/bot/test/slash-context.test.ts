import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { DEFAULT_COMMAND_PREFIX, buildBotInviteUrl } from "@monarch/shared";
import { BurgRegistry } from "../src/burg.js";
import { MonarchCommands } from "../src/monarch-commands.js";
import { PrefixRegistry } from "../src/prefix/registry.js";
import { SlashCommandContext } from "../src/slash-context.js";
import type { ChatInputCommandInteraction } from "discord.js";

/**
 * The slash surface after the prefix-command refactor.
 *
 * The point of these tests is parity: `/burg` and `!burg` must land in
 * the same registry with the same checks, and the slash-only behaviours
 * (ephemeral replies, `deferReply` → `editReply`) must have survived the move
 * from a 500-line switch in index.ts into MonarchCommands + a context adapter.
 */

const GUILD_ID = "800000000000000001";
const CLIENT_ID = "123456789012345678";
const MOD_ID = "700000000000000001";
const TARGET_ID = "600000000000000001";

const member = (id: string, position: number, bits: bigint = PermissionFlagsBits.Administrator) => ({
  id,
  permissions: new PermissionsBitField(bits),
  roles: { highest: { position } },
  user: { id, bot: false, username: `user-${id}`, displayName: `member-${id}` },
  displayName: `member-${id}`,
  voice: { channel: null },
});

/** Typed read of a `vi.fn()` payload — discord.js reply options in, assertions out. */
type ReplyPayload = {
  content?: string;
  embeds?: { description: string }[];
  files?: unknown[];
  flags?: number;
  allowedMentions?: { parse: string[] };
};
function payloadAt(spy: { mock: { calls: unknown[][] } }, index = 0): ReplyPayload {
  const call = spy.mock.calls[index];
  if (!call) throw new Error(`expected a reply #${index}, got none`);
  return call[0] as ReplyPayload;
}

function fakeInteraction(options: Record<string, unknown> = {}) {
  const guild = {
    id: GUILD_ID,
    name: "Test Guild",
    ownerId: "111111111111111111",
    members: { me: member("bot", 9), cache: new Map(), fetch: vi.fn() },
    channels: { cache: new Map() },
  };
  const interaction = {
    guildId: GUILD_ID,
    channelId: "500000000000000001",
    guild,
    member: member(MOD_ID, 5),
    user: { id: MOD_ID, displayName: "Invoker", username: "invoker" },
    memberPermissions: new PermissionsBitField(
      (options.perms as bigint | undefined) ?? PermissionFlagsBits.Administrator,
    ),
    inCachedGuild: () => true,
    deferred: false,
    replied: false,
    options: {
      getString: (name: string) => (options[name] as string | undefined) ?? null,
      getInteger: (name: string) => (options[name] as number | undefined) ?? null,
      getUser: (name: string) => (options[name] as { id: string } | undefined) ?? null,
      getMember: (name: string) => (name === "user" ? member(TARGET_ID, 0, 0n) : null),
      getChannel: (name: string) => (options[name] as { id: string } | undefined) ?? null,
      getSubcommand: () => options.sub ?? null,
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => ({})),
    reply: vi.fn(async () => {
      interaction.replied = true;
      return {};
    }),
  };
  return interaction;
}

let burg: BurgRegistry;
let prefixes: PrefixRegistry;
let monarch: MonarchCommands;
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

function context(interaction: ReturnType<typeof fakeInteraction>, prefix = "!") {
  return new SlashCommandContext(
    interaction as unknown as ChatInputCommandInteraction<"cached">,
    prefix,
  );
}

beforeEach(() => {
  vi.useRealTimers();
  burg = new BurgRegistry();
  prefixes = new PrefixRegistry();
  log = { info: vi.fn(), warn: vi.fn() };
  monarch = new MonarchCommands({
    appUrl: "https://monarch.example",
    burg,
    prefixes,
    burgEnabled: () => true,
    clientId: CLIENT_ID,
    log,
  });
});

describe("slash surface", () => {
  it("reports itself as the slash surface and quotes the guild's prefix", async () => {
    const interaction = fakeInteraction();
    const ctx = context(interaction, "m!");
    expect(ctx.surface).toBe("slash");
    expect(ctx.commandPrefix).toBe("m!");
    expect(ctx.args).toEqual([]); // slash options are typed; there's no free text
    await monarch.run(ctx, "status");
    const payload = payloadAt(interaction.reply);
    expect(payload.content).toContain("Prefix: `m!`");
    expect(payload.content).toContain("m!prefix set <new>");
  });

  it("replies ephemerally for invoker-only answers", async () => {
    const interaction = fakeInteraction();
    await monarch.run(context(interaction), "dashboard");
    const payload = payloadAt(interaction.reply);
    expect(payload.flags).toBe(64); // MessageFlags.Ephemeral
    expect(payload.allowedMentions).toEqual({ parse: [] }); // user text can never mass-ping
    expect(payload.content).toContain(`https://monarch.example/s/${GUILD_ID}`);
  });

  it("burgs through the same registry the prefix surface uses", async () => {
    // Frozen clock: the reply quotes the time left, not the time requested.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    const interaction = fakeInteraction({
      user: { id: TARGET_ID },
      duration: "10m",
      style: "cat",
      reason: "being silly",
    });
    await monarch.burg(context(interaction));

    expect(burg.isBurg(GUILD_ID, TARGET_ID)).toBe(true);
    const entry = burg.get(GUILD_ID, TARGET_ID)!;
    expect(entry.burgedBy).toBe(MOD_ID);
    expect(entry.style).toBe("cat");
    expect(entry.until).toBe(Date.now() + 10 * 60 * 1000);
    const payload = payloadAt(interaction.reply);
    expect(payload.content).toContain("burg'd for **10m**");
    expect(payload.content).toContain("being silly");
    expect(payload.flags).toBe(64);

    // …and the prefix surface sees exactly the same state.
    expect(burg.list(GUILD_ID)).toHaveLength(1);
  });

  it("keeps the moderation checks", async () => {
    const interaction = fakeInteraction({ user: { id: TARGET_ID } });
    interaction.memberPermissions = new PermissionsBitField(0n);
    await monarch.burg(context(interaction));
    expect(burg.isBurg(GUILD_ID, TARGET_ID)).toBe(false);
    expect(payloadAt(interaction.reply, 0).content).toContain("Kick Members");
  });

  it("toggles burg off for a member it already holds", async () => {
    burg.burg({ guildId: GUILD_ID, userId: TARGET_ID, until: null, burgedBy: MOD_ID, style: "cat" });
    const interaction = fakeInteraction({ user: { id: TARGET_ID } });
    await monarch.burg(context(interaction));
    expect(burg.isBurg(GUILD_ID, TARGET_ID)).toBe(false);
    expect(payloadAt(interaction.reply, 0).content).toContain("no longer burg'd");
  });

  it("updates the entry when re-run with options instead of toggling off", async () => {
    burg.burg({ guildId: GUILD_ID, userId: TARGET_ID, until: null, burgedBy: MOD_ID, style: "soft" });
    const interaction = fakeInteraction({ user: { id: TARGET_ID }, duration: "10m" });
    await monarch.burg(context(interaction));
    expect(burg.isBurg(GUILD_ID, TARGET_ID)).toBe(true); // still on
    expect(burg.get(GUILD_ID, TARGET_ID)?.style).toBe("soft"); // untouched
    expect(burg.get(GUILD_ID, TARGET_ID)?.until).not.toBeNull(); // now timed
    expect(payloadAt(interaction.reply, 0).content).toContain("Updated");
  });

  it("lists burg'd members through /monarch burged", async () => {
    burg.burg({ guildId: GUILD_ID, userId: TARGET_ID, until: null, burgedBy: MOD_ID, style: "soft" });
    const interaction = fakeInteraction({});
    await monarch.run(context(interaction), "burged");
    const payload = payloadAt(interaction.reply, 0);
    expect(payload.content).toContain(`<@${TARGET_ID}>`);
    expect(payload.content).toContain("until toggled off");
    expect(payload.flags).toBe(64);
  });

  it("defers, then edits — never replies twice", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, snapshot: { name: "Backup" }, categoryCount: 2, channelCount: 9 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    monarch = new MonarchCommands({
      appUrl: "https://monarch.example",
      internalToken: "token",
      burg,
      prefixes,
      burgEnabled: () => true,
      log,
    });

    const interaction = fakeInteraction({ name: "before cleanup" });
    await monarch.run(context(interaction), "backup");

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledOnce();
    const edited = payloadAt(interaction.editReply);
    // The reply names the snapshot the API says it saved.
    expect(edited.content).toContain("Backup **Backup** saved — 2 categories, 9 channels");
    const call = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(call[1]).toMatchObject({ method: "POST" });
    expect(call[0]).toContain(`/api/internal/guilds/${GUILD_ID}/backup`);
    expect(call[1].body).toContain("before cleanup");
    vi.unstubAllGlobals();
  });

  it("shows the prefix subcommand's current value and refuses without Manage Server", async () => {
    const show = fakeInteraction();
    await monarch.run(context(show), "prefix");
    expect(payloadAt(show.reply, 0).content).toContain("(the default)");

    const change = fakeInteraction({ prefix: "?" });
    change.memberPermissions = new PermissionsBitField(0n);
    await monarch.run(context(change), "prefix");
    expect(payloadAt(change.reply, 0).content).toContain("Manage Server");
  });

  it("saves a new prefix from the slash surface too", async () => {
    const save = vi.fn(async () => {});
    prefixes = new PrefixRegistry({ store: { load: vi.fn(async () => null), save } });
    monarch = new MonarchCommands({
      appUrl: "https://monarch.example",
      internalToken: "token",
      burg,
      prefixes,
      burgEnabled: () => true,
      log,
    });

    const interaction = fakeInteraction({ prefix: ">>" });
    await monarch.run(context(interaction), "prefix");
    expect(save).toHaveBeenCalledWith(GUILD_ID, ">>");
    expect(payloadAt(interaction.reply, 0).content).toContain("now `>>`");
    expect(await prefixes.get(GUILD_ID)).toBe(">>");
  });

  it("answers an unknown subcommand instead of throwing", async () => {
    const interaction = fakeInteraction();
    await monarch.run(context(interaction), "frobnicate");
    const payload = payloadAt(interaction.reply);
    expect(payload.content).toContain("I don't know `frobnicate`");
    expect(payload.flags).toBe(64);
  });

  it("posts the help embed with the prefix line and the guild's own prefix", async () => {
    const interaction = fakeInteraction();
    await monarch.run(context(interaction, "?"), "help");
    const payload = payloadAt(interaction.reply);
    expect(payload.embeds).toHaveLength(1);
    const description = payload.embeds?.[0]?.description ?? "";
    expect(description).toContain("?help");
    expect(description).toContain("?prefix set <new>");
    expect(payload.flags).toBe(64);
  });
});

describe("the no-danger commands are open to everybody", () => {
  /** View Channel only — no Manage Server, no Administrator, no moderation. */
  const PLAIN = PermissionFlagsBits.ViewChannel;

  it("/monarch invite answers a permissionless member with an install link", async () => {
    const interaction = fakeInteraction({ sub: "invite", perms: PLAIN });
    await monarch.run(context(interaction), "invite");

    const payload = payloadAt(interaction.reply);
    expect(payload.flags).toBe(64); // still invoker-only, like every other reply
    const url = new URL(payload.content!.match(/https:\/\/discord\.com\/oauth2\/authorize\?\S+/)![0]);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    // No pre-selected server: the point is installing it somewhere else.
    expect(url.searchParams.get("guild_id")).toBeNull();
    expect(url.searchParams.get("disable_guild_select")).toBeNull();
    expect(BigInt(url.searchParams.get("permissions")!) & 0b1000n).toBe(0n); // never Administrator
  });

  it("posts byte-for-byte the same link as !invite (one builder, two surfaces)", async () => {
    const interaction = fakeInteraction({ sub: "invite", perms: PLAIN });
    await monarch.run(context(interaction), "invite");
    const slashUrl = payloadAt(interaction.reply).content!.match(/https:\/\/discord\.com\/oauth2\/authorize\?\S+/)![0];

    // The text surface runs the same handler through the real tokenizer.
    const { PrefixCommandContext } = await import("../src/prefix/context.js");
    const { extractPrefixCommand, matchCommand } = await import("../src/prefix/parse.js");
    const message = fakePrefixMessage("!invite");
    const invocation = extractPrefixCommand(message.content, ["!"], CLIENT_ID)!;
    const match = matchCommand(invocation);
    expect(match).toMatchObject({ kind: "command", surface: "monarch", sub: "invite" });
    const ctx = new PrefixCommandContext(
      message as never,
      invocation,
      DEFAULT_COMMAND_PREFIX,
      match.kind === "command" ? match.args : [],
    );
    await monarch.run(ctx, "invite");
    const prefixReply = payloadAt(message.channel.send as unknown as { mock: { calls: unknown[][] } });
    const prefixUrl = prefixReply.content!.match(/https:\/\/discord\.com\/oauth2\/authorize\?\S+/)![0];

    expect(prefixUrl).toBe(slashUrl);
    // …and both are exactly what the shared builder — the dashboard's invite
    // button included — produces.
    expect(slashUrl).toBe(buildBotInviteUrl({ clientId: CLIENT_ID }));
  });

  it("/monarch status and /monarch dashboard stay open too", async () => {
    for (const sub of ["status", "dashboard", "help"]) {
      const interaction = fakeInteraction({ sub, perms: PLAIN });
      await monarch.run(context(interaction), sub);
      const payload = payloadAt(interaction.reply);
      expect(payload.content ?? payload.embeds?.[0]?.description, sub).toBeTruthy();
    }
  });

  it("points at the dashboard when no application id is known", async () => {
    const orphan = new MonarchCommands({
      appUrl: "https://monarch.example",
      burg,
      prefixes,
      burgEnabled: () => true,
      clientId: null,
      log,
    });
    const interaction = fakeInteraction({ sub: "invite", perms: PLAIN });
    await orphan.run(context(interaction), "invite");
    const payload = payloadAt(interaction.reply);
    expect(payload.content).toContain("DISCORD_CLIENT_ID");
    expect(payload.content).toContain("https://monarch.example");
    expect(payload.content).not.toContain("discord.com/oauth2/authorize");
  });
});

/** A minimal gateway message for the parity check above. */
function fakePrefixMessage(content: string) {
  const channel = {
    id: "500000000000000001",
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    send: vi.fn(async () => ({ id: "m1", edit: vi.fn(async () => ({})) })),
  };
  return {
    id: "msg-1",
    content,
    guildId: GUILD_ID,
    channelId: channel.id,
    author: { id: TARGET_ID, bot: false, displayName: "Plain", username: "plain" },
    member: {
      id: TARGET_ID,
      permissions: new PermissionsBitField(PermissionFlagsBits.ViewChannel),
      roles: { highest: { position: 0 } },
      displayName: "Plain",
      user: { id: TARGET_ID, bot: false, username: "plain", displayName: "Plain" },
      voice: { channel: null },
    },
    guild: {
      id: GUILD_ID,
      name: "Test Guild",
      ownerId: "111111111111111111",
      members: { me: { id: CLIENT_ID, permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) }, cache: new Map(), fetch: vi.fn() },
      channels: { cache: new Map([[channel.id, channel]]) },
    },
    channel,
    mentions: { users: { first: () => null }, members: { first: () => null, get: () => null }, channels: { first: () => null } },
    attachments: [],
    stickers: [],
    webhookId: null,
    system: false,
    inGuild: () => true,
    delete: vi.fn(async () => ({})),
  };
}
