import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  type APIEmbed,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type Message,
  type VoiceState,
  type Webhook,
} from "discord.js";
import { createLogger } from "@monarch/shared";
import {
  BURG_PERMISSIONS,
  DESIGN_PERMISSIONS,
  JAIL_PERMISSIONS,
  burgCommandJSON,
  monarchCommandJSON,
  renderHelpEmbeds,
} from "./commands.js";
import { BurgRegistry, toBurg, type BurgStyle } from "./burg.js";
import { formatDuration, parseDuration, toGalactic } from "./galactic.js";
import { JailRegistry } from "./jail.js";
import { handleMusicCommand, musicCommandJSON, spotifyStatusLine } from "./music/commands.js";
import { MusicManager } from "./music/player.js";

/**
 * Monarch bot — deliberately lightweight.
 *
 * The web dashboard is the product; the bot is the integration layer.
 * Commands provide quick actions and dashboard links. Structural changes
 * are executed by the API layer through @monarch/discord (REST), not by
 * this process. The live message gags (jail and burg) run here because they
 * need gateway message events; the rest of the design work stays in the API.
 *
 * Note on interactions: replies always go to the interaction's own context
 * (Discord requires this). Only *generated content* (tests, publishes) uses
 * Monarch's Target Resolver — and that happens in the API layer: the bot
 * calls the dashboard's /api/internal/* routes with INTERNAL_API_TOKEN.
 */
const log = createLogger("bot");

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildIdForCommands = process.env.DISCORD_GUILD_ID?.trim();
const appUrl = process.env.APP_URL ?? "http://localhost:3000";
const internalToken = process.env.INTERNAL_API_TOKEN;

if (!token) {
  log.warn("DISCORD_BOT_TOKEN is not set — bot not started. (Dashboard demo mode does not need the bot.)");
  process.exit(0);
}

/**
 * Intents: Guilds for slash commands; GuildVoiceStates for the music player;
 * GuildMessages + MessageContent so the jail and burg relays can read and
 * re-post messages.
 * MessageContent is a *privileged* intent — enable it under Bot → Privileged
 * Gateway Intents in the developer portal (free under 100 servers,
 * verification required above that). If it is not enabled Discord refuses
 * the connection, so `start()` falls back to Guilds + VoiceStates with the
 * both message gags disabled instead of crash-looping the worker.
 */
const FULL_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
];
const BASIC_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];

let jailEnabled = true;
let client = createClient(FULL_INTENTS);

const jail = new JailRegistry((entry) => {
  log.info("jail expired", { guildId: entry.guildId, userId: entry.userId });
});

const burg = new BurgRegistry((entry) => {
  log.info("burg expired", { guildId: entry.guildId, userId: entry.userId, style: entry.style });
});

// ── music player ─────────────────────────────────────────────────────

/**
 * The music manager owns one voice connection per guild. It's created lazily
 * on the first `/music` command so the bot still boots (and message gags work)
 * even if the voice stack is unhappy. Announcements are posted to the text
 * channel where the last music command ran.
 */
let music: MusicManager | null = null;

function getMusic(): MusicManager {
  music ??= new MusicManager(client, (guildId, embed: APIEmbed, content?: string) => {
    const channelId = music?.announcementChannelId(guildId);
    if (!channelId) return;
    void client.channels
      .fetch(channelId)
      .then(async (channel) => {
        if (channel?.isSendable()) await channel.send({ embeds: [embed], content });
      })
      .catch((e) => log.warn("music announcement failed", { guildId, error: String(e) }));
  });
  return music;
}

function createClient(intents: number[]): Client {
  const c = new Client({ intents });
  c.once(Events.ClientReady, (ready) => {
    log.info("bot ready", { user: ready.user.tag, guilds: ready.guilds.cache.size, jail: jailEnabled });
  });
  // Surface gateway trouble instead of letting an EventEmitter "error" event
  // take the whole worker down (discord.js reconnects on its own).
  c.on(Events.Error, (e) => {
    log.error("gateway error", { error: String(e) });
  });
  c.on(Events.MessageCreate, onMessage);
  c.on(Events.InteractionCreate, onInteraction);
  c.on(Events.VoiceStateUpdate, (old: VoiceState, next: VoiceState) => {
    music?.handleVoiceStateUpdate(old, next);
  });
  return c;
}

function isDisallowedIntents(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "DisallowedIntents" || /disallowed intents|privileged intent/i.test(String(e));
}

/**
 * Graceful shutdown.
 *
 * The container runtime signals PID 1 on every redeploy and SIGKILLs whatever
 * is still alive after the grace period. Without a handler the bot is killed
 * mid-session: Discord keeps the dead gateway session until its heartbeat
 * times out, and the deploy log ends in a non-zero exit that reads like a
 * crash. Handlers only help if the signal actually reaches *this* process, so
 * the image must exec node directly (see docker/bot.Dockerfile) instead of
 * wrapping it in `npm run` — npm absorbs SIGTERM, exits 143 and never
 * forwards it.
 */
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  try {
    client.destroy(); // closes the gateway session cleanly
  } catch (e) {
    log.warn("gateway close failed", { error: String(e) });
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// A stray rejection must not kill a worker that is otherwise serving guilds.
process.on("unhandledRejection", (e) => {
  log.error("unhandled rejection", { error: String(e) });
});

function internalHeaders(): Record<string, string> | undefined {
  return internalToken ? { Authorization: `Bearer ${internalToken}` } : undefined;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type ApiError = { message: string; reason?: string; fix?: string };

function describeApiError(e: ApiError | undefined, fallback: string): string {
  if (!e) return `❌ ${fallback}`;
  return `❌ ${e.message}\n${[e.reason, e.fix].filter(Boolean).join("\n")}`.trim();
}

/** Does the invoking member hold any of these permission bits? */
function memberHasAny(interaction: ChatInputCommandInteraction, bits: readonly bigint[]): boolean {
  const perms = interaction.memberPermissions;
  if (!perms) return false;
  return bits.some((bit) => perms.has(bit));
}

// ── live message relays (jail + burg) ────────────────────────────────

const JAIL_WEBHOOK_NAME = "Monarch Jail";
const BURG_WEBHOOK_NAME = "Monarch Burg";
const jailWebhookCache = new Map<string, Webhook>();
const burgWebhookCache = new Map<string, Webhook>();

/** One webhook per channel, created lazily and reused (Discord caps them at 15/channel). */
async function relayWebhook(
  message: Message<true>,
  name: string,
  reason: string,
  cache: Map<string, Webhook>,
): Promise<Webhook | null> {
  const channel = message.channel;
  // Threads post through their parent's webhook with `threadId`.
  const host = channel.isThread() ? channel.parent : channel;
  if (!host || !("fetchWebhooks" in host)) return null;
  const cached = cache.get(host.id);
  if (cached) return cached;
  const me = message.guild.members.me;
  if (!me || !host.permissionsFor(me).has(PermissionFlagsBits.ManageWebhooks)) return null;
  const hooks = await host.fetchWebhooks();
  let hook = hooks.find(
    (candidate) => candidate.owner?.id === client.user?.id && candidate.name === name && candidate.token,
  );
  if (!hook) {
    hook = await host.createWebhook({ name, reason });
  }
  cache.set(host.id, hook);
  return hook;
}

async function jailWebhook(message: Message<true>): Promise<Webhook | null> {
  return relayWebhook(message, JAIL_WEBHOOK_NAME, "Monarch jail relay", jailWebhookCache);
}

async function burgWebhook(message: Message<true>): Promise<Webhook | null> {
  return relayWebhook(message, BURG_WEBHOOK_NAME, "Monarch burg relay", burgWebhookCache);
}

async function onMessage(message: Message) {
  try {
    if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return;

    // If someone has both gags enabled, jail wins. More importantly, only one
    // handler ever deletes the source message, so the two relays cannot race.
    const jailed = jail.isJailed(message.guildId, message.author.id);
    const burgEntry = jailed ? null : burg.get(message.guildId, message.author.id);
    if (!jailed && !burgEntry) return;
    const mode = jailed ? "jail" : "burg";

    const me = message.guild.members.me;
    const channelPerms = me ? message.channel.permissionsFor(me) : null;
    if (!channelPerms?.has(PermissionFlagsBits.ManageMessages)) {
      log.warn(`${mode}ged message left alone — missing Manage Messages`, {
        guildId: message.guildId,
        channelId: message.channelId,
      });
      return;
    }

    const plainContent = message.content ?? "";
    const content = jailed ? toGalactic(plainContent) : toBurg(plainContent, burgEntry!.style);
    const files = message.attachments.map((a) => a.url);
    const stickers = message.stickers.map((s) => s.name);
    const stickerText = stickers.length
      ? jailed
        ? `*(sticker: ${stickers.join(", ")})*`
        : toBurg(`*(sticker: ${stickers.join(", ")})*`, burgEntry!.style)
      : "";
    const body = [content, stickerText].filter(Boolean).join("\n");
    if (!body && files.length === 0) {
      await message.delete().catch(() => {});
      return;
    }

    const member = message.member;
    const displayName = member?.displayName ?? message.author.displayName ?? message.author.username;
    const avatarURL = member?.displayAvatarURL({ size: 256 }) ?? message.author.displayAvatarURL({ size: 256 });

    // Relay first (attachments are re-uploaded from the original's CDN
    // URLs, which must still exist), then delete. The delete happens even if
    // the relay failed so the gag always holds.
    try {
      const hook = jailed ? await jailWebhook(message) : await burgWebhook(message);
      if (hook) {
        await hook.send({
          content: truncate(body, 2000) || undefined,
          files: files.slice(0, 10),
          username: truncate(displayName, 80),
          avatarURL,
          threadId: message.channel.isThread() ? message.channel.id : undefined,
          allowedMentions: { parse: [] },
        });
      } else {
        await message.channel.send({
          content: truncate(`**${displayName}**: ${body}`, 2000),
          files: files.slice(0, 10),
          allowedMentions: { parse: [] },
        });
      }
    } catch (e) {
      log.warn(`${mode} relay failed — original still deleted`, { error: String(e) });
    }
    await message.delete().catch((e) => log.warn(`could not delete ${mode}ged message`, { error: String(e) }));
  } catch (e) {
    log.error("message relay failed", { error: String(e) });
  }
}

// ── slash commands ───────────────────────────────────────────────────

async function handleBurgCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: "Run this command inside a server.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!memberHasAny(interaction, BURG_PERMISSIONS)) {
    await interaction.reply({
      content: "❌ Only administrators and roles with **Kick Members** can use /burg.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const targetUser = interaction.options.getUser("user", true);
  const existing = burg.get(interaction.guildId, targetUser.id);
  if (existing) {
    // /burg is deliberately a toggle: no second command name to remember.
    burg.release(interaction.guildId, targetUser.id);
    log.info("member unburged", { guildId: interaction.guildId, userId: targetUser.id, by: interaction.user.id });
    await interaction.reply({
      content: `🧁 ${targetUser} is no longer burg'd — their messages are back to normal.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { users: [] },
    });
    return;
  }

  if (!jailEnabled) {
    await interaction.reply({
      content:
        "❌ /burg is disabled on this Monarch instance: the **Message Content** intent isn't enabled for the bot application. " +
        "The host must turn it on under Bot → Privileged Gateway Intents and restart the bot.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const target = interaction.options.getMember("user") as GuildMember | null;
  if (!target) {
    await interaction.reply({ content: "❌ That user isn't in this server.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (target.id === interaction.user.id) {
    await interaction.reply({ content: "You can't burg yourself — nice try.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (target.user.bot) {
    await interaction.reply({ content: "❌ Bots can't be burg'd.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (target.id === interaction.guild.ownerId) {
    await interaction.reply({ content: "❌ The server owner can't be burg'd.", flags: MessageFlags.Ephemeral });
    return;
  }

  const invoker = interaction.member;
  const invokerIsOwner = interaction.guild.ownerId === invoker.id;
  if (!invokerIsOwner && target.roles.highest.position >= invoker.roles.highest.position) {
    await interaction.reply({
      content: "❌ You can only burg members whose highest role is below yours.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (target.permissions.has(PermissionFlagsBits.Administrator) && !invokerIsOwner) {
    await interaction.reply({
      content: "❌ Administrators can only be burg'd by the server owner.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (jail.isJailed(interaction.guildId, target.id)) {
    await interaction.reply({
      content: "❌ That member is already in the Galactic jail. Release them first, then use /burg.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const me = interaction.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({
      content:
        "❌ Monarch needs the **Manage Messages** permission to delete and re-post burg'd messages.\n" +
        `Re-invite it from ${appUrl} or grant the permission in Server Settings → Roles, then try again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!me.permissions.has(PermissionFlagsBits.ManageWebhooks)) {
    log.warn("burg without Manage Webhooks — relaying as plain bot messages", { guildId: interaction.guildId });
  }

  const durationRaw = interaction.options.getString("duration");
  const reason = interaction.options.getString("reason");
  const styleRaw = interaction.options.getString("style") ?? "random";
  const style: BurgStyle =
    styleRaw === "soft" || styleRaw === "cat" || styleRaw === "chaotic" ? styleRaw : "random";
  let until: number | null = null;
  if (durationRaw) {
    const ms = parseDuration(durationRaw);
    if (ms === null) {
      await interaction.reply({
        content: "❌ I didn't understand that duration. Use `30s`, `10m`, `2h`, `1d` or `1h30m`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    until = Date.now() + ms;
  }

  burg.burg({
    guildId: interaction.guildId,
    userId: target.id,
    until,
    burgedBy: interaction.user.id,
    style,
  });
  log.info("member burged", {
    guildId: interaction.guildId,
    userId: target.id,
    by: interaction.user.id,
    until,
    style,
  });
  const when = until
    ? `for **${formatDuration(until - Date.now())}** (until <t:${Math.floor(until / 1000)}:f>)`
    : "**until toggled off** with `/burg @user`";
  const styleLabel = style === "random" ? "a random cute style" : `the **${style}** style`;
  await interaction.reply({
    content:
      `🧁 ${targetUser} is burg'd ${when}${reason ? ` — ${reason}` : ""}.\n` +
      `Their messages will be re-posted as ${styleLabel}, e.g. ${toBurg("hello there", style)} under their name and avatar.\n` +
      "Use `/burg` on them again to turn it off.",
    flags: MessageFlags.Ephemeral,
    allowedMentions: { users: [] },
  });
}

async function onInteraction(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "music") {
    try {
      await handleMusicCommand(interaction, getMusic());
    } catch (e) {
      log.error("music command failed", { error: String(e) });
      const msg = "❌ Something went wrong with that music command.";
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
        else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      } catch {

      }
    }
    return;
  }
  if (interaction.commandName === "burg") {
    try {
      await handleBurgCommand(interaction);
    } catch (e) {
      log.error("burg command failed", { error: String(e) });
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply("❌ Something went wrong running /burg.");
        else await interaction.reply({ content: "❌ Something went wrong running /burg.", flags: MessageFlags.Ephemeral });
      } catch {
        // interaction already timed out — nothing more to do
      }
    }
    return;
  }
  if (interaction.commandName !== "monarch") return;

  const sub = interaction.options.getSubcommand(false);
  const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  const guildName = interaction.guild?.name ?? "your server";
  try {
    switch (sub) {
      case "help": {
        await interaction.reply({
          embeds: renderHelpEmbeds(appUrl, interaction.guildId ?? undefined),
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      case "dashboard": {
        const url = interaction.guildId ? `${appUrl}/s/${interaction.guildId}` : appUrl;
        await reply(`👑 Design **${guildName}** in the Monarch studio:\n${url}`);
        break;
      }
      case "status": {
        const jailed = interaction.guildId ? jail.list(interaction.guildId).length : 0;
        const burged = interaction.guildId ? burg.list(interaction.guildId).length : 0;
        await reply(
          [
            "**Monarch** — Design your Discord.",
            `• Server: ${interaction.guild?.name ?? "—"}`,
            `• Dashboard: ${appUrl}`,
            `• Jailed members: ${jailed}`,
            `• Burg'd members: ${burged}`,
            "• All design changes are previewed and applied from the dashboard.",
            "• `/monarch help` lists every command.",
          ].join("\n"),
        );
        break;
      }
      case "backup": {
        if (!interaction.guildId) {
          await reply("Run this command inside the server you want to back up.");
          break;
        }
        if (!memberHasAny(interaction, DESIGN_PERMISSIONS)) {
          await reply("❌ You need **Manage Server** or **Administrator** to back up this server.");
          break;
        }
        if (!internalToken) {
          await reply("❌ Backups need `INTERNAL_API_TOKEN` set in the dashboard and bot environments.");
          break;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const name = interaction.options.getString("name") ?? undefined;
        try {
          const res = await fetch(`${appUrl}/api/internal/guilds/${interaction.guildId}/backup`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...internalHeaders() },
            body: JSON.stringify({ name, userId: interaction.user.id }),
          });
          const data = (await res.json()) as {
            ok?: boolean;
            snapshot?: { name: string };
            categoryCount?: number;
            channelCount?: number;
            error?: ApiError;
          };
          if (res.ok && data.ok) {
            await interaction.editReply(
              `✅ Backup **${data.snapshot?.name}** saved — ${data.categoryCount} categories, ${data.channelCount} channels.\n` +
                `Restore it any time from ${appUrl}/s/${interaction.guildId}/history`,
            );
          } else {
            await interaction.editReply(describeApiError(data.error, "Monarch couldn't save the backup."));
          }
        } catch {
          await interaction.editReply("❌ Couldn't reach the Monarch dashboard.");
        }
        break;
      }
      case "export": {
        if (!interaction.guildId) {
          await reply("Run this command inside the server you want to export.");
          break;
        }
        if (!memberHasAny(interaction, DESIGN_PERMISSIONS)) {
          await reply("❌ You need **Manage Server** or **Administrator** to export this server.");
          break;
        }
        if (!internalToken) {
          await reply("❌ Export needs `INTERNAL_API_TOKEN` set in the dashboard and bot environments.");
          break;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const res = await fetch(`${appUrl}/api/internal/guilds/${interaction.guildId}/template`, {
            headers: internalHeaders(),
          });
          const data = (await res.json()) as {
            ok?: boolean;
            fileName?: string;
            template?: { data?: { categories?: unknown[]; channels?: unknown[] } };
            error?: ApiError;
          };
          if (res.ok && data.ok && data.template) {
            const file = new AttachmentBuilder(Buffer.from(JSON.stringify(data.template, null, 2), "utf8"), {
              name: data.fileName ?? "monarch-template.json",
            });
            const cats = data.template.data?.categories?.length ?? 0;
            const chans = data.template.data?.channels?.length ?? 0;
            await interaction.editReply({
              content:
                `📦 **${guildName}** exported — ${cats} categories, ${chans} channels.\n` +
                `Import it into any server at ${appUrl}/s/<server>/import-export.`,
              files: [file],
            });
          } else {
            await interaction.editReply(describeApiError(data.error, "Monarch couldn't export this server."));
          }
        } catch {
          await interaction.editReply("❌ Couldn't reach the Monarch dashboard.");
        }
        break;
      }
      case "embed": {
        if (!interaction.guildId) {
          await reply("Run this command inside the server you want to design.");
          break;
        }
        const url = `${appUrl}/s/${interaction.guildId}/embeds`;
        let info = "";
        if (!internalToken) {
          info = "\n\nℹ Tip: set `INTERNAL_API_TOKEN` in the dashboard and bot to see the saved embed here.";
        } else {
          try {
            const res = await fetch(`${appUrl}/api/internal/guilds/${interaction.guildId}/workspace`, {
              headers: internalHeaders(),
            });
            if (res.ok) {
              const data = (await res.json()) as {
                workspace?: { embed?: { title?: string; description?: string } };
              };
              const embed = data.workspace?.embed;
              info = embed
                ? `\n\nSaved embed: **${truncate(embed.title ?? embed.description ?? "untitled", 80)}**`
                : "\n\nNo embed saved yet — the builder starts fresh.";
            } else if (res.status === 503) {
              info = "\n\nℹ Set `INTERNAL_API_TOKEN` to enable saved-design previews.";
            }
          } catch {
            info = "\n\n(Monarch dashboard is not reachable right now.)";
          }
        }
        await reply(`👑 **Embed Builder** for **${guildName}**:\n${url}${info}`);
        break;
      }
      case "test": {
        if (!interaction.guildId) {
          await reply("Run this command inside the server you want to test.");
          break;
        }
        if (!memberHasAny(interaction, DESIGN_PERMISSIONS)) {
          await reply("❌ You need **Manage Server** or **Administrator** to send designs.");
          break;
        }
        if (!internalToken) {
          await reply(
            "❌ Can't reach Monarch's publish API — set `INTERNAL_API_TOKEN` in the dashboard and bot environments.",
          );
          break;
        }
        const kind = interaction.options.getString("kind", true);
        const mode = interaction.options.getString("mode") ?? "test";
        const channel = interaction.options.getChannel("channel");
        const target = channel
          ? { kind: "explicit", guildId: interaction.guildId, channelId: channel.id }
          : undefined;
        try {
          const res = await fetch(`${appUrl}/api/internal/guilds/${interaction.guildId}/workspace/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...internalHeaders() },
            body: JSON.stringify({ kind, mode, target }),
          });
          const data = (await res.json()) as { ok?: boolean; channelName?: string; error?: ApiError };
          if (res.ok && data.ok) {
            await reply(`✅ ${mode === "publish" ? "Published" : "Tested"} **${kind}** to #${data.channelName}.`);
          } else {
            await reply(describeApiError(data?.error, "Monarch couldn't send the design."));
          }
        } catch {
          await reply("❌ Couldn't reach the Monarch dashboard.");
        }
        break;
      }
      case "jail": {
        if (!interaction.inCachedGuild()) {
          await reply("Run this command inside a server.");
          break;
        }
        if (!memberHasAny(interaction, JAIL_PERMISSIONS)) {
          await reply("❌ Only administrators and roles with **Kick Members** can jail people.");
          break;
        }
        if (!jailEnabled) {
          await reply(
            "❌ The jail is disabled on this Monarch instance: the **Message Content** intent isn't enabled for the bot application. " +
              "The host must turn it on under Bot → Privileged Gateway Intents and restart the bot.",
          );
          break;
        }
        const target = interaction.options.getMember("user") as GuildMember | null;
        const targetUser = interaction.options.getUser("user", true);
        if (!target) {
          await reply("❌ That user isn't in this server.");
          break;
        }
        if (target.id === interaction.user.id) {
          await reply("You can't jail yourself — nice try.");
          break;
        }
        if (target.user.bot) {
          await reply("❌ Bots can't be jailed.");
          break;
        }
        if (target.id === interaction.guild.ownerId) {
          await reply("❌ The server owner can't be jailed.");
          break;
        }
        const invoker = interaction.member;
        const invokerIsOwner = interaction.guild.ownerId === invoker.id;
        if (!invokerIsOwner && target.roles.highest.position >= invoker.roles.highest.position) {
          await reply("❌ You can only jail members whose highest role is below yours.");
          break;
        }
        if (target.permissions.has(PermissionFlagsBits.Administrator) && !invokerIsOwner) {
          await reply("❌ Administrators can only be jailed by the server owner.");
          break;
        }
        const me = interaction.guild.members.me;
        if (!me?.permissions.has(PermissionFlagsBits.ManageMessages)) {
          await reply(
            "❌ Monarch needs the **Manage Messages** permission to delete and re-post jailed messages.\n" +
              `Re-invite it from ${appUrl} or grant the permission in Server Settings → Roles, then try again.`,
          );
          break;
        }
        if (!me.permissions.has(PermissionFlagsBits.ManageWebhooks)) {
          log.warn("jail without Manage Webhooks — relaying as plain bot messages", { guildId: interaction.guildId });
        }
        if (burg.isBurg(interaction.guildId, target.id)) {
          await reply("❌ That member is already burg'd. Turn /burg off for them first, then use the Galactic jail.");
          break;
        }

        const durationRaw = interaction.options.getString("duration");
        const reason = interaction.options.getString("reason");
        let until: number | null = null;
        if (durationRaw) {
          const ms = parseDuration(durationRaw);
          if (ms === null) {
            await reply("❌ I didn't understand that duration. Use `30s`, `10m`, `2h`, `1d` or `1h30m`.");
            break;
          }
          until = Date.now() + ms;
        }
        jail.jail({ guildId: interaction.guildId, userId: target.id, until, jailedBy: interaction.user.id });
        log.info("member jailed", {
          guildId: interaction.guildId,
          userId: target.id,
          by: interaction.user.id,
          until,
        });
        const when = until ? `for **${formatDuration(until - Date.now())}** (until <t:${Math.floor(until / 1000)}:f>)` : "**until released** with `/monarch unjail`";
        await interaction.reply({
          content:
            `🔒 ${targetUser} is jailed ${when}${reason ? ` — ${reason}` : ""}.\n` +
            `Everything they post will be re-posted as ${toGalactic("galactic")} under their name.`,
          allowedMentions: { users: [] },
        });
        break;
      }
      case "unjail": {
        if (!interaction.inCachedGuild()) {
          await reply("Run this command inside a server.");
          break;
        }
        if (!memberHasAny(interaction, JAIL_PERMISSIONS)) {
          await reply("❌ Only administrators and roles with **Kick Members** can release people.");
          break;
        }
        const user = interaction.options.getUser("user", true);
        const released = jail.release(interaction.guildId, user.id);
        if (!released) {
          await reply(`${user} isn't jailed.`);
          break;
        }
        log.info("member released", { guildId: interaction.guildId, userId: user.id, by: interaction.user.id });
        await interaction.reply({ content: `🔓 ${user} has been released.`, allowedMentions: { users: [] } });
        break;
      }
      case "jailed": {
        if (!interaction.inCachedGuild()) {
          await reply("Run this command inside a server.");
          break;
        }
        if (!memberHasAny(interaction, JAIL_PERMISSIONS)) {
          await reply("❌ Only administrators and roles with **Kick Members** can see the jail list.");
          break;
        }
        const entries = jail.list(interaction.guildId);
        if (entries.length === 0) {
          await reply("Nobody is jailed right now.");
          break;
        }
        await reply(
          [
            `🔒 **Jailed in ${guildName}** (${entries.length})`,
            ...entries.map(
              (e) =>
                `• <@${e.userId}> — ${e.until ? `until <t:${Math.floor(e.until / 1000)}:R>` : "until released"} · by <@${e.jailedBy}>`,
            ),
          ].join("\n"),
        );
        break;
      }
      default:
        await reply("Try `/monarch help` for the full list of commands.");
    }
  } catch (e) {
    log.error("interaction failed", { error: String(e) });
    const msg = "❌ Something went wrong running that command.";
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await reply(msg);
    } catch {
      // interaction already timed out — nothing more to do
    }
  }
}

async function registerCommands(botToken: string) {
  if (!clientId) {
    log.warn("DISCORD_CLIENT_ID is not set — slash commands were not registered");
    return;
  }
  const commands = [monarchCommandJSON(), burgCommandJSON(), musicCommandJSON()];
  const route = guildIdForCommands
    ? Routes.applicationGuildCommands(clientId, guildIdForCommands)
    : Routes.applicationCommands(clientId);
  try {
    await new REST({ version: "10" }).setToken(botToken).put(route, {
      body: commands,
    });
    log.info("registered slash commands", {
      count: commands.length,
      names: commands.map((command) => command.name),
      scope: guildIdForCommands ? "guild" : "global",
      ...(guildIdForCommands ? { guildId: guildIdForCommands } : {}),
    });
  } catch (e) {
    // Non-fatal: previously registered commands keep working, and crash-looping
    // the worker on a transient Discord REST error would take them offline too.
    log.error("slash command registration failed — continuing with existing commands", { error: String(e) });
  }
}

async function start(botToken: string) {
  await registerCommands(botToken);
  try {
    await client.login(botToken);
  } catch (e) {
    if (!isDisallowedIntents(e)) throw e;
    log.error(
      "Message Content intent is not enabled for this application — /monarch jail and /burg are disabled. " +
        "Enable it under Bot → Privileged Gateway Intents in the Discord developer portal, then restart.",
      { error: String(e) },
    );
    jailEnabled = false;
    try {
      client.destroy();
    } catch {
      // never connected
    }
    client = createClient(BASIC_INTENTS);
    await client.login(botToken);
  }
}

start(token).catch((e) => {
  log.error("bot startup failed", { error: String(e) });
  process.exit(1);
});
