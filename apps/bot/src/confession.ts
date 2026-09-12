import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
  type ButtonInteraction,
  type GuildTextBasedChannel,
  type ModalSubmitInteraction,
} from "discord.js";

/**
 * Confessions — an anonymous confession channel per guild.
 *
 * `/monarch confession setup [channel] [logs]` (apps/bot/src/monarch-commands.ts)
 * stores the channels through the dashboard's internal API (this module's
 * {@link ConfessionRegistry}, same pattern as the command prefix in
 * ./prefix/registry.ts) and posts a "starter" confession. From then on every
 * confession embed carries a **Confess** button; clicking it opens a modal
 * and the submitted text is posted:
 *
 * 1. **publicly** — to the confession channel as a fully anonymous embed:
 *    no username, no avatar, no user id, no timestamp anyone can correlate;
 * 2. **to staff** — to the optional log channel with everything: who, when,
 *    the full text, and a link to the public message.
 *
 * The confessor's id is otherwise never stored anywhere: outside the log
 * channel a confession is untraceable by design.
 */

// ── component ids and limits ────────────────────────────────────────

export const CONFESS_BUTTON_ID = "monarch:confession:confess";
export const CONFESS_MODAL_ID = "monarch:confession:modal";
export const CONFESS_TEXT_ID = "monarch:confession:text";

/** The form enforces this; embed description (4096) still has headroom. */
export const MAX_CONFESSED_LENGTH = 2000;
const MIN_CONFESSED_LENGTH = 3;

const GOLD = 0xf5c542;
const LOG_RED = 0xed4245;

// ── the persisted configuration ─────────────────────────────────────

/** Both null = confessions are off for this guild. */
export interface ConfessionChannels {
  channelId: string | null;
  logChannelId: string | null;
}

const EMPTY: ConfessionChannels = { channelId: null, logChannelId: null };

const SNOWFLAKE = /^\d{15,25}$/;

/** The bot-facing seam over `GET|PUT /api/internal/guilds/:id/confession`. */
export interface ConfessionStore {
  load(guildId: string): Promise<ConfessionChannels>;
  save(guildId: string, channels: ConfessionChannels): Promise<void>;
}

export interface ConfessionRegistryOptions {
  /** Where the channels are persisted; null = confessions can't be set up. */
  store?: ConfessionStore | null;
  ttlMs?: number;
  now?: () => number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Per-guild confession channels with a short TTL cache.
 *
 * Button clicks and modal submissions arrive without the configuration, so
 * every one of them resolves the guild's channels here. Reading the internal
 * API on each click would be fine for a quiet channel but not for a busy
 * one, so the answer is cached like the command prefix — and an unreachable
 * dashboard is cached too, degrading to "confessions off" (the safe answer:
 * nobody confesses into the void).
 */
export class ConfessionRegistry {
  private readonly cache = new Map<string, { channels: ConfessionChannels; expiresAt: number }>();
  private readonly store: ConfessionStore | null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly log: ConfessionRegistryOptions["log"];

  constructor(options: ConfessionRegistryOptions = {}) {
    this.store = options.store ?? null;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  /** Can this instance remember a confession setup at all? */
  get persistent(): boolean {
    return this.store !== null;
  }

  /**
   * The confession channels for this guild. Never throws: an unreachable
   * store (or a stored value that isn't a snowflake) degrades to "off".
   */
  async config(guildId: string): Promise<ConfessionChannels> {
    const hit = this.cache.get(guildId);
    if (hit && hit.expiresAt > this.now()) return hit.channels;
    if (!this.store) return EMPTY;
    try {
      const loaded = await this.store.load(guildId);
      const channels = {
        channelId: SNOWFLAKE.test(loaded.channelId ?? "") ? (loaded.channelId as string) : null,
        logChannelId: SNOWFLAKE.test(loaded.logChannelId ?? "") ? (loaded.logChannelId as string) : null,
      };
      this.cache.set(guildId, { channels, expiresAt: this.now() + this.ttlMs });
      return channels;
    } catch (e) {
      // Cache the miss too — a dead dashboard must not cost a fetch per click.
      this.cache.set(guildId, { channels: EMPTY, expiresAt: this.now() + this.ttlMs });
      this.log?.warn("couldn't load the confession channels — treating as off", {
        guildId,
        error: String(e),
      });
      return EMPTY;
    }
  }

  /**
   * Fully (re)configure or — with both ids null — disable confessions for
   * this guild. Returns a user-presentable result instead of throwing.
   */
  async configure(
    guildId: string,
    channels: ConfessionChannels,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const channelId = SNOWFLAKE.test(channels.channelId ?? "") ? (channels.channelId as string) : null;
    const logChannelId = SNOWFLAKE.test(channels.logChannelId ?? "") ? (channels.logChannelId as string) : null;
    if (channels.channelId !== null && channelId === null) {
      return { ok: false, message: "❌ That confession channel id isn't a valid Discord channel." };
    }
    if (channels.logChannelId !== null && logChannelId === null) {
      return { ok: false, message: "❌ That log channel id isn't a valid Discord channel." };
    }
    // The log channel names names — pointing it at the public channel would
    // leak every confessor to everyone.
    if (channelId !== null && channelId === logChannelId) {
      return {
        ok: false,
        message:
          "❌ The log channel must be different from the confession channel — the log entries say who confessed, so keep them in a staff-only channel.",
      };
    }
    if (!this.store) {
      return {
        ok: false,
        message:
          "❌ Confession setup is saved through the Monarch dashboard, and this bot can't reach it — " +
          "set `INTERNAL_API_TOKEN` in the dashboard and bot environments, then try again.",
      };
    }
    try {
      await this.store.save(guildId, { channelId, logChannelId });
    } catch (e) {
      const detail = apiMessage(e);
      return { ok: false, message: `❌ Couldn't save the confession setup.${detail ? `\n${detail}` : ""}` };
    }
    this.cache.set(guildId, {
      channels: { channelId, logChannelId },
      expiresAt: this.now() + this.ttlMs,
    });
    this.log?.info("confession channels configured", { guildId, channelId, logChannelId });
    return { ok: true };
  }

  /** Seed the cache (used by tests and after a successful write). */
  remember(guildId: string, channels: ConfessionChannels): void {
    this.cache.set(guildId, { channels, expiresAt: this.now() + this.ttlMs });
  }

  clear(): void {
    this.cache.clear();
  }
}

function apiMessage(e: unknown): string {
  const message = (e as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.length > 0 && message.length <= 300) return message;
  return "";
}

/** The internal-API-backed store the worker uses. */
export function internalConfessionStore(appUrl: string, token: string): ConfessionStore {
  const url = (guildId: string) => `${appUrl}/api/internal/guilds/${guildId}/confession`;
  return {
    async load(guildId) {
      const res = await fetch(url(guildId), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`confession lookup failed (${res.status})`);
      const data = (await res.json()) as { channelId?: string | null; logChannelId?: string | null };
      return {
        channelId: typeof data.channelId === "string" ? data.channelId : null,
        logChannelId: typeof data.logChannelId === "string" ? data.logChannelId : null,
      };
    },
    async save(guildId, channels) {
      const res = await fetch(url(guildId), {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ channelId: channels.channelId, logChannelId: channels.logChannelId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string; fix?: string } | null;
        throw new Error(data?.message ?? `confession update failed (${res.status})`);
      }
    },
  };
}

// ── embeds and components ───────────────────────────────────────────

/** The first confession posted by setup — it explains the feature. */
export function starterEmbed(): APIEmbed {
  return {
    color: GOLD,
    title: "🤫 Confessions",
    description:
      "Confess anything — **anonymously**.\n" +
      "Press **Confess** below and tell us what you've been keeping secret. It gets posted here " +
      "with no name, no avatar, no id — nobody can trace it back to you.",
    footer: { text: "Anonymous by design · set up with /monarch confession setup" },
  };
}

/**
 * A public confession — deliberately without any identifying data: no
 * author, no username, no avatar, and no timestamp to correlate against.
 */
export function confessionEmbed(text: string): APIEmbed {
  return {
    color: GOLD,
    title: "🤫 Confession",
    description: text,
    footer: { text: "Anonymous — no one knows who posted this." },
  };
}

/**
 * The staff log entry — the exact opposite: everything that identifies the
 * confessor, for the staff-only log channel.
 */
export function confessionLogEmbed(input: {
  userId: string;
  text: string;
  publicChannelId: string;
  publicMessageUrl: string;
  at: number;
}): APIEmbed {
  return {
    color: LOG_RED,
    title: "🤫 Confession logged",
    description: input.text,
    fields: [
      { name: "From", value: `<@${input.userId}>`, inline: true },
      { name: "When", value: `<t:${Math.floor(input.at / 1000)}:F>`, inline: true },
      { name: "Public post", value: `<#${input.publicChannelId}> · <${input.publicMessageUrl}>`, inline: true },
    ],
    footer: { text: "Staff only — never out a confessor." },
  };
}

/** The "Confess" button row that rides under every confession embed. */
export function confessButtonRow(): ReturnType<ActionRowBuilder["toJSON"]> {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(CONFESS_BUTTON_ID)
        .setLabel("Confess")
        .setEmoji("🤫")
        .setStyle(ButtonStyle.Secondary),
    )
    .toJSON();
}

/** The form the Confess button opens. */
export function confessionModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(CONFESS_MODAL_ID)
    .setTitle("Confess")
    .addComponents(
      new TextInputBuilder()
        .setCustomId(CONFESS_TEXT_ID)
        .setStyle(TextInputStyle.Paragraph)
        .setLabel("Your confession")
        .setPlaceholder("What have you been keeping secret?")
        .setMinLength(MIN_CONFESSED_LENGTH)
        .setMaxLength(MAX_CONFESSED_LENGTH),
    );
}

// ── the button → modal → post flow ──────────────────────────────────

export interface ConfessFlowDeps {
  registry: ConfessionRegistry;
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

async function ephemeral(interaction: ButtonInteraction | ModalSubmitInteraction, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
}

/** The "Confess" button was pressed → open the modal (when confessions are on). */
export async function handleConfessButton(interaction: ButtonInteraction, deps: ConfessFlowDeps): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await ephemeral(interaction, "❌ Run this inside a server.");
    return;
  }
  const config = await deps.registry.config(interaction.guildId);
  if (!config.channelId) {
    await ephemeral(
      interaction,
      "🤫 Confessions aren't set up in this server yet — an admin can run `/monarch confession setup`.",
    );
    return;
  }
  await interaction.showModal(confessionModal());
}

/** The modal was submitted → anonymous embed in the public channel + staff log. */
export async function handleConfessSubmit(interaction: ModalSubmitInteraction, deps: ConfessFlowDeps): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await ephemeral(interaction, "❌ Confess from inside a server.");
    return;
  }
  const text = interaction.fields.getTextInputValue(CONFESS_TEXT_ID).trim();
  if (text.length < MIN_CONFESSED_LENGTH) {
    await ephemeral(interaction, "❌ That's too short to count as a confession — tell us a bit more.");
    return;
  }

  const config = await deps.registry.config(interaction.guildId);
  if (!config.channelId) {
    await ephemeral(
      interaction,
      "🤫 Confessions are no longer set up in this server — an admin can run `/monarch confession setup`.",
    );
    return;
  }

  // Post publicly first: the staff log entry links to the public message.
  const publicChannel = await usableChannel(interaction, config.channelId);
  if (!publicChannel) {
    await ephemeral(
      interaction,
      "❌ Monarch can't post in the confession channel right now — an admin should re-run `/monarch confession setup`.",
    );
    return;
  }

  let publicMessage: { url: string };
  try {
    publicMessage = await publicChannel.send({
      embeds: [confessionEmbed(text)],
      components: [confessButtonRow()],
      allowedMentions: { parse: [] },
    });
  } catch (e) {
    deps.log.error("confession post failed", { guildId: interaction.guildId, error: String(e) });
    await ephemeral(interaction, "❌ I couldn't post your confession — try again in a moment.");
    return;
  }
  deps.log.info("confession posted", { guildId: interaction.guildId, channelId: publicChannel.id });

  // The staff log is best-effort: a broken log channel must never eat the
  // confession itself.
  let logFailed = false;
  if (config.logChannelId) {
    const logChannel = await usableChannel(interaction, config.logChannelId);
    if (logChannel) {
      try {
        await logChannel.send({
          embeds: [
            confessionLogEmbed({
              userId: interaction.user.id,
              text,
              publicChannelId: publicChannel.id,
              publicMessageUrl: publicMessage.url,
              at: Date.now(),
            }),
          ],
          allowedMentions: { parse: [] },
        });
      } catch (e) {
        logFailed = true;
        deps.log.warn("confession log entry failed", { guildId: interaction.guildId, error: String(e) });
      }
    } else {
      logFailed = true;
      deps.log.warn("confession log channel unreachable — log entry skipped", {
        guildId: interaction.guildId,
        logChannelId: config.logChannelId,
      });
    }
  }

  await ephemeral(
    interaction,
    `🤫 Your confession is live in **${publicChannel.name}** — it's anonymous, nobody can trace it back to you.` +
      (logFailed ? " (Heads up: I couldn't write the staff log entry for this one.)" : ""),
  );
}

/**
 * A guild text channel the bot can actually view and post in, or null.
 * The interaction's own guild and user are used — both are cached for
 * guild interactions.
 */
async function usableChannel(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  channelId: string,
): Promise<GuildTextBasedChannel | null> {
  let channel: unknown;
  try {
    channel = await interaction.client.channels.fetch(channelId);
  } catch {
    return null;
  }
  if (!channel || !(channel as { isTextBased?: () => boolean }).isTextBased?.()) return null;
  const textBased = channel as GuildTextBasedChannel;
  if (textBased.guild && textBased.guild.id !== interaction.guildId) return null;
  const me = interaction.client.user;
  if (!me) return null;
  const perms = textBased.permissionsFor(me);
  return perms?.has(PermissionFlagsBits.ViewChannel) && perms?.has(PermissionFlagsBits.SendMessages)
    ? textBased
    : null;
}
