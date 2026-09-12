import { MessageFlags, TextInputStyle } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONFESS_BUTTON_ID,
  CONFESS_MODAL_ID,
  CONFESS_TEXT_ID,
  MAX_CONFESSED_LENGTH,
  ConfessionRegistry,
  confessionEmbed,
  confessionLogEmbed,
  confessionModal,
  confessButtonRow,
  handleConfessButton,
  handleConfessSubmit,
  starterEmbed,
  type ConfessionStore,
} from "../src/confession.js";

const GUILD_ID = "800000000000000001";
const CHANNEL_ID = "500000000000000001";
const LOG_CHANNEL_ID = "400000000000000001";
const USER_ID = "700000000000000001";

/** A fake in-memory ConfessionStore. */
function fakeStore(initial: Record<string, { channelId: string | null; logChannelId: string | null }> = {}) {
  const data: Record<string, { channelId: string | null; logChannelId: string | null }> = { ...initial };
  return {
    data,
    load: vi.fn(async (guildId: string) => data[guildId] ?? { channelId: null, logChannelId: null }),
    save: vi.fn(async (guildId: string, channels: { channelId: string | null; logChannelId: string | null }) => {
      data[guildId] = channels;
    }),
  };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// ── the registry ────────────────────────────────────────────────────

describe("ConfessionRegistry", () => {
  it("is not persistent without a store and reports nothing", async () => {
    const registry = new ConfessionRegistry();
    expect(registry.persistent).toBe(false);
    expect(await registry.config(GUILD_ID)).toEqual({ channelId: null, logChannelId: null });
    const outcome = await registry.configure(GUILD_ID, { channelId: CHANNEL_ID, logChannelId: null });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("INTERNAL_API_TOKEN");
  });

  it("loads, caches and expires like the prefix registry", async () => {
    const store = fakeStore({ [GUILD_ID]: { channelId: CHANNEL_ID, logChannelId: LOG_CHANNEL_ID } });
    let now = 1_000;
    const registry = new ConfessionRegistry({ store, now: () => now, ttlMs: 60_000 });

    expect(await registry.config(GUILD_ID)).toEqual({ channelId: CHANNEL_ID, logChannelId: LOG_CHANNEL_ID });
    expect(store.load).toHaveBeenCalledOnce();

    now += 30_000; // within the TTL
    await registry.config(GUILD_ID);
    expect(store.load).toHaveBeenCalledOnce(); // served from the cache

    now += 30_001; // past the TTL
    await registry.config(GUILD_ID);
    expect(store.load).toHaveBeenCalledTimes(2);
  });

  it("degrades to off when the store is unreachable, and caches the miss", async () => {
    const store: ConfessionStore = {
      load: vi.fn(async () => {
        throw new Error("dashboard down");
      }),
      save: vi.fn(),
    };
    let now = 1_000;
    const registry = new ConfessionRegistry({ store, now: () => now, ttlMs: 60_000, log });

    expect(await registry.config(GUILD_ID)).toEqual({ channelId: null, logChannelId: null });
    expect(log.warn).toHaveBeenCalled();

    now += 1_000;
    await registry.config(GUILD_ID);
    expect(store.load).toHaveBeenCalledOnce(); // the miss is cached too
  });

  it("treats a stored value that is not a snowflake as absent", async () => {
    const store = fakeStore({ [GUILD_ID]: { channelId: "not-a-snowflake", logChannelId: LOG_CHANNEL_ID } });
    const registry = new ConfessionRegistry({ store });
    expect(await registry.config(GUILD_ID)).toEqual({ channelId: null, logChannelId: LOG_CHANNEL_ID });
  });

  it("refuses to save invalid or self-contradictory configurations", async () => {
    const store = fakeStore();
    const registry = new ConfessionRegistry({ store });

    const badId = await registry.configure(GUILD_ID, { channelId: "nope", logChannelId: null });
    expect(badId.ok).toBe(false);

    const sameChannel = await registry.configure(GUILD_ID, { channelId: CHANNEL_ID, logChannelId: CHANNEL_ID });
    expect(sameChannel.ok).toBe(false);
    if (!sameChannel.ok) expect(sameChannel.message).toContain("different");

    expect(store.save).not.toHaveBeenCalled();
  });

  it("saves, seeds the cache and reports success", async () => {
    const store = fakeStore();
    const registry = new ConfessionRegistry({ store });

    const outcome = await registry.configure(GUILD_ID, { channelId: CHANNEL_ID, logChannelId: LOG_CHANNEL_ID });
    expect(outcome).toEqual({ ok: true });
    expect(store.save).toHaveBeenCalledOnce();
    expect(store.load).not.toHaveBeenCalled(); // the cache is seeded by the write

    // A second worker (fresh registry, same store) reads the persisted value.
    const fresh = new ConfessionRegistry({ store });
    expect(await fresh.config(GUILD_ID)).toEqual({ channelId: CHANNEL_ID, logChannelId: LOG_CHANNEL_ID });
  });

  it("disables with both ids null", async () => {
    const store = fakeStore({ [GUILD_ID]: { channelId: CHANNEL_ID, logChannelId: LOG_CHANNEL_ID } });
    const registry = new ConfessionRegistry({ store });

    expect(await registry.configure(GUILD_ID, { channelId: null, logChannelId: null })).toEqual({ ok: true });
    expect(store.data[GUILD_ID]).toEqual({ channelId: null, logChannelId: null });
  });
});

// ── embeds and components ───────────────────────────────────────────

describe("confession embeds", () => {
  it("the public embed carries no identifying data at all", () => {
    const embed = confessionEmbed("I ate their snack.");
    expect(embed.title).toContain("Confession");
    expect(embed.description).toBe("I ate their snack.");
    // Anonymity: nothing the client could use to trace the confessor.
    expect(embed.author).toBeUndefined();
    expect(embed.user).toBeUndefined();
    expect(embed.username).toBeUndefined();
    expect(embed.timestamp).toBeUndefined();
    expect(JSON.stringify(embed)).not.toContain("@"); // no mentions
  });

  it("the starter explains the feature", () => {
    const embed = starterEmbed();
    expect(embed.title).toContain("Confessions");
    expect(embed.description).toContain("anonymously");
  });

  it("the log embed has everything the public one must not", () => {
    const at = Date.UTC(2026, 8, 12, 12, 0, 0);
    const embed = confessionLogEmbed({
      userId: USER_ID,
      text: "I ate their snack.",
      publicChannelId: CHANNEL_ID,
      publicMessageUrl: "https://discord.com/channels/g/c/m",
      at,
    });
    expect(embed.description).toBe("I ate their snack.");
    const fields = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields["From"]).toBe(`<@${USER_ID}>`);
    expect(fields["When"]).toBe(`<t:${Math.floor(at / 1000)}:F>`);
    expect(fields["Public post"]).toContain("<https://discord.com/channels/g/c/m>");
    expect(fields["Public post"]).toContain(`<#${CHANNEL_ID}>`);
  });

  it("every confession carries the Confess button", () => {
    const row = confessButtonRow();
    expect(row.type).toBe(1);
    const button = row.components[0]!;
    expect(button.label).toBe("Confess");
    expect(button.custom_id).toBe(CONFESS_BUTTON_ID);
  });

  it("the modal has one paragraph input capped at the max length", () => {
    const modal = confessionModal().toJSON();
    expect(modal.custom_id).toBe(CONFESS_MODAL_ID);
    const input = modal.components[0]!.components[0]!;
    expect(input.custom_id).toBe(CONFESS_TEXT_ID);
    expect(input.style).toBe(TextInputStyle.Paragraph);
    expect(input.max_length).toBe(MAX_CONFESSED_LENGTH);
  });
});

// ── the button → modal → post flow ──────────────────────────────────

function fakeChannel(id: string, name: string, opts: { send?: boolean } = {}) {
  return {
    id,
    name,
    guild: { id: GUILD_ID },
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: vi.fn(
      async () =>
        opts.send === false
          ? Promise.reject(new Error("cannot send"))
          : { id: `m-${Math.random()}`, url: `https://discord.com/channels/${GUILD_ID}/${id}/m1` },
    ),
  };
}

function fakeInteraction(kind: "button" | "modal", extra: Record<string, unknown> = {}) {
  return {
    inCachedGuild: () => true,
    inGuild: () => true,
    guildId: GUILD_ID,
    user: { id: USER_ID, username: "era" },
    member: { displayName: "Era" },
    replied: false,
    deferred: false,
    reply: vi.fn(async () => ({ id: "r1" })),
    showModal: vi.fn(async () => ({})),
    fields: kind === "modal" ? { getTextInputValue: (id: string) => (extra["text"] as string) ?? "" } : undefined,
    client: {
      user: { id: "900000000000000001", username: "monarch" },
      channels: { fetch: vi.fn(async (id: string) => (extra["channels"] as Record<string, unknown>)[id] ?? null) },
    },
    ...extra,
  } as never as Parameters<typeof handleConfessButton>[0];
}

describe("confess flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("the button says confessions are off when nothing is set up", async () => {
    const registry = new ConfessionRegistry(); // no store
    const interaction = fakeInteraction("button");
    await handleConfessButton(interaction, { registry, log });
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
    const [payload] = interaction.reply.mock.calls[0]!;
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toContain("aren't set up");
  });

  it("the button opens the modal when a confession channel exists", async () => {
    const registry = new ConfessionRegistry({ store: fakeStore({ [GUILD_ID]: { channelId: CHANNEL_ID, logChannelId: null } }) });
    const interaction = fakeInteraction("button");
    await handleConfessButton(interaction, { registry, log });
    expect(interaction.showModal).toHaveBeenCalledOnce();
    expect(interaction.showModal.mock.calls[0]![0].toJSON().custom_id).toBe(CONFESS_MODAL_ID);
  });

  it("the modal posts the anonymous embed plus the Confess button", async () => {
    const channel = fakeChannel(CHANNEL_ID, "confessions");
    const registry = new ConfessionRegistry({ store: fakeStore({ [GUILD_ID]: { channelId: CHANNEL_ID, logChannelId: null } }) });
    const interaction = fakeInteraction("modal", {
      text: "I think I left the oven on.",
      channels: { [CHANNEL_ID]: channel },
    });
    await handleConfessSubmit(interaction, { registry, log });

    expect(channel.send).toHaveBeenCalledOnce();
    const [payload] = channel.send.mock.calls[0]!;
    expect(payload.embeds[0]!.description).toBe("I think I left the oven on.");
    expect(payload.embeds[0]!.author).toBeUndefined();
    expect(payload.components[0]!.components[0]!.custom_id).toBe(CONFESS_BUTTON_ID);
    expect(payload.allowedMentions).toEqual({ parse: [] });
    // And the confessor gets a private confirmation.
    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(interaction.reply.mock.calls[0]![0].content).toContain("Your confession is live");
    expect(interaction.reply.mock.calls[0]![0].content).toContain("confessions");
  });

  it("the modal also writes the staff log entry when a log channel is set", async () => {
    const channel = fakeChannel(CHANNEL_ID, "confessions");
    const logChannel = fakeChannel(LOG_CHANNEL_ID, "confession-logs");
    const registry = new ConfessionRegistry({
      store: fakeStore({ [GUILD_ID]: { channelId: CHANNEL_ID, logChannelId: LOG_CHANNEL_ID } }),
    });
    const interaction = fakeInteraction("modal", {
      text: "I told the secret.",
      channels: { [CHANNEL_ID]: channel, [LOG_CHANNEL_ID]: logChannel },
    });
    await handleConfessSubmit(interaction, { registry, log });

    expect(logChannel.send).toHaveBeenCalledOnce();
    const [payload] = logChannel.send.mock.calls[0]!;
    const embed = payload.embeds[0]!;
    expect(embed.title).toContain("logged");
    expect(embed.description).toBe("I told the secret.");
    const fields = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields["From"]).toBe(`<@${USER_ID}>`);
    expect(fields["Public post"]).toContain(channel && "<https://discord.com/channels/");
    // The public post happened first, and the log links to it.
    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(interaction.reply.mock.calls[0]![0].content).not.toContain("Heads up");
  });

  it("rejects an empty or too-short confession without posting", async () => {
    const channel = fakeChannel(CHANNEL_ID, "confessions");
    const registry = new ConfessionRegistry({ store: fakeStore({ [GUILD_ID]: { channelId: CHANNEL_ID, logChannelId: null } }) });
    const interaction = fakeInteraction("modal", { text: "  ", channels: { [CHANNEL_ID]: channel } });
    await handleConfessSubmit(interaction, { registry, log });
    expect(channel.send).not.toHaveBeenCalled();
    expect(interaction.reply.mock.calls[0]![0].content).toContain("too short");
  });

  it("gives up cleanly when the confession channel is gone", async () => {
    const registry = new ConfessionRegistry({ store: fakeStore({ [GUILD_ID]: { channelId: CHANNEL_ID, logChannelId: null } }) });
    const interaction = fakeInteraction("modal", {
      text: "a real confession",
      channels: {}, // fetch returns null
    });
    await handleConfessSubmit(interaction, { registry, log });
    expect(interaction.reply.mock.calls[0]![0].content).toContain("can't post");
  });

  it("still posts the confession when the log channel is broken", async () => {
    const channel = fakeChannel(CHANNEL_ID, "confessions");
    const registry = new ConfessionRegistry({
      store: fakeStore({ [GUILD_ID]: { channelId: CHANNEL_ID, logChannelId: LOG_CHANNEL_ID } }),
    });
    const interaction = fakeInteraction("modal", {
      text: "a real confession",
      channels: { [CHANNEL_ID]: channel }, // the log channel is gone
    });
    await handleConfessSubmit(interaction, { registry, log });

    expect(channel.send).toHaveBeenCalledOnce(); // the confession survives
    expect(log.warn).toHaveBeenCalled(); // …but the operator is told
    expect(interaction.reply.mock.calls[0]![0].content).toContain("Heads up");
  });
});
