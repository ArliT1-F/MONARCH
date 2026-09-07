import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type Message,
  type Webhook,
} from "discord.js";
import { createLogger } from "@monarch/shared";
import { DESIGN_PERMISSIONS, JAIL_PERMISSIONS, monarchCommandJSON, renderHelp } from "./commands.js";
import { formatDuration, parseDuration, toGalactic } from "./galactic.js";
import { JailRegistry } from "./jail.js";

/**
 * Monarch bot — deliberately lightweight.
 *
 * The web dashboard is the product; the bot is the integration layer.
 * Commands provide quick actions and dashboard links. Structural changes
 * are executed by the API layer through @monarch/discord (REST), not by
 * this process. The one thing the bot does on its own is the jail gag,
 * because it needs live message events (gateway only).
 *
 * Note on interactions: replies always go to the interaction's own context
 * (Discord requires this). Only *generated content* (tests, publishes) uses
 * Monarch's Target Resolver — and that happens in the API layer: the bot
 * calls the dashboard's /api/internal/* routes with INTERNAL_API_TOKEN.
 */
const log = createLogger("bot");

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const appUrl = process.env.APP_URL ?? "http://localhost:3000";
const internalToken = process.env.INTERNAL_API_TOKEN;

if (!token) {
  log.warn("DISCORD_BOT_TOKEN is not set — bot not started. (Dashboard demo mode does not need the bot.)");
  process.exit(0);
}

/**
 * Intents: Guilds for slash commands; GuildMessages + MessageContent so the
 * jail can read and relay messages. MessageContent is a *privileged* intent
 * — enable it under Bot → Privileged Gateway Intents in the developer
 * portal (free under 100 servers, verification required above that). If it
 * is not enabled Discord refuses the connection, so `start()` falls back to
 * Guilds-only with the jail disabled instead of crash-looping the worker.
 */
const FULL_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];
const BASIC_INTENTS = [GatewayIntentBits.Guilds];

let jailEnabled = true;
let client = createClient(FULL_INTENTS);

const jail = new JailRegistry((entry) => {
  log.info("jail expired", { guildId: entry.guildId, userId: entry.userId });
});

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

// ── jail relay ───────────────────────────────────────────────────────

const WEBHOOK_NAME = "Monarch Jail";
const webhookCache = new Map<string, Webhook>();

/** One webhook per channel, created lazily and reused (Discord caps them at 15/channel). */
async function jailWebhook(message: Message<true>): Promise<Webhook | null> {
  const channel = message.channel;
  // Threads post through their parent's webhook with `threadId`.
  const host = channel.isThread() ? channel.parent : channel;
  if (!host || !("fetchWebhooks" in host)) return null;
  const cached = webhookCache.get(host.id);
  if (cached) return cached;
  const me = message.guild.members.me;
  if (!me || !host.permissionsFor(me).has(PermissionFlagsBits.ManageWebhooks)) return null;
  const hooks = await host.fetchWebhooks();
  let hook = hooks.find((h) => h.owner?.id === client.user?.id && h.name === WEBHOOK_NAME && h.token);
  if (!hook) {
    hook = await host.createWebhook({ name: WEBHOOK_NAME, reason: "Monarch jail relay" });
  }
  webhookCache.set(host.id, hook);
  return hook;
}

async function onMessage(message: Message) {
  try {
    if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return;
    if (!jail.isJailed(message.guildId, message.author.id)) return;

    const me = message.guild.members.me;
    const channelPerms = me ? message.channel.permissionsFor(me) : null;
    if (!channelPerms?.has(PermissionFlagsBits.ManageMessages)) {
      log.warn("jailed message left alone — missing Manage Messages", {
        guildId: message.guildId,
        channelId: message.channelId,
      });
      return;
    }

    const content = toGalactic(message.content ?? "");
    const files = message.attachments.map((a) => a.url);
    const stickers = message.stickers.map((s) => s.name);
    const body = [content, stickers.length ? `*(sticker: ${stickers.join(", ")})*` : ""].filter(Boolean).join("\n");
    if (!body && files.length === 0) {
      await message.delete().catch(() => {});
      return;
    }

    const member = message.member;
    const displayName = member?.displayName ?? message.author.displayName ?? message.author.username;
    const avatarURL = member?.displayAvatarURL({ size: 256 }) ?? message.author.displayAvatarURL({ size: 256 });

    // Relay first (attachments are re-uploaded from the original's CDN
    // URLs, which must still exist), then delete. The overlap is a few
    // milliseconds; the delete happens even if the relay failed so the jail
    // always holds.
    try {
      const hook = await jailWebhook(message);
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
      log.warn("jail relay failed — original still deleted", { error: String(e) });
    }
    await message.delete().catch((e) => log.warn("could not delete jailed message", { error: String(e) }));
  } catch (e) {
    log.error("jail relay failed", { error: String(e) });
  }
}

// ── slash commands ───────────────────────────────────────────────────

async function onInteraction(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "monarch") return;

  const sub = interaction.options.getSubcommand(false);
  const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  const guildName = interaction.guild?.name ?? "your server";
  try {
    switch (sub) {
      case "help": {
        await reply(renderHelp(appUrl));
        break;
      }
      case "dashboard": {
        const url = interaction.guildId ? `${appUrl}/s/${interaction.guildId}` : appUrl;
        await reply(`👑 Design **${guildName}** in the Monarch studio:\n${url}`);
        break;
      }
      case "status": {
        const jailed = interaction.guildId ? jail.list(interaction.guildId).length : 0;
        await reply(
          [
            "**Monarch** — Design your Discord.",
            `• Server: ${interaction.guild?.name ?? "—"}`,
            `• Dashboard: ${appUrl}`,
            `• Jailed members: ${jailed}`,
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
  const commands = [monarchCommandJSON()];
  try {
    await new REST({ version: "10" }).setToken(botToken).put(Routes.applicationCommands(clientId), {
      body: commands,
    });
    log.info("registered slash commands", { count: commands.length });
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
      "Message Content intent is not enabled for this application — /monarch jail is disabled. " +
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
