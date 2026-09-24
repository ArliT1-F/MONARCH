import os from "node:os";
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  type APIEmbed,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type VoiceState,
  type Webhook,
  type WebhookMessageCreateOptions,
} from "discord.js";
import { createLogger } from "@monarch/shared";
import { burgCommandJSON, monarchCommandJSON } from "./commands.js";
import { BurgRegistry, toBurg } from "./burg.js";
import {
  CONFESS_BUTTON_ID,
  CONFESS_MODAL_ID,
  ConfessionRegistry,
  handleConfessButton,
  handleConfessSubmit,
  internalConfessionStore,
} from "./confession.js";
import { ConfessionCooldowns, internalConfessionCooldownStore } from "./confession-cooldown.js";
import { MonarchCommands } from "./monarch-commands.js";
import { MusicCommands, musicCommandJSON } from "./music/commands.js";
import { MusicManager } from "./music/player.js";
import { DebugFlags, clampDebugText, type DebugReporter } from "./debug.js";
import { ensureYtdlp } from "./music/ytdlp.js";
import { resolveFfmpegPath } from "./music/audio.js";
import { handlePrefixMessage, type PrefixDispatcherDeps } from "./prefix/dispatch.js";
import { internalPrefixStore, PrefixRegistry } from "./prefix/registry.js";
import { postAsEraPersona, resolveEraPersona } from "./era-relay.js";
import { applyHelpStatus, BOT_STATUS_TEXT, helpCommandPresence } from "./presence.js";
import { SlashCommandContext } from "./slash-context.js";

/**
 * Monarch bot — deliberately lightweight.
 *
 * The web dashboard is the product; the bot is the integration layer.
 * Commands provide quick actions and dashboard links. Structural changes
 * are executed by the API layer through @monarch/discord (REST), not by
 * this process. The live burg gag runs here becuase it
 * need gateway message events; the rest of the design work stays in the API.
 *
 * Every command answers to both surfaces: slash (`/burg`,
 * `/music play`) and text prefixes (`!burg`, `!play`, `@Monarch help`) with a
 * per-server prefix. Both are thin adapters over the same handlers, so they
 * cannot drift — see ./prefix/ and ./context.ts.
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
// User id of the Discord account that owns this application (not the server owner).
const ownerUserId = process.env.MONARCH_OWNER_USER_ID?.trim() || null;

if (!token) {
  log.warn(
    "DISCORD_BOT_TOKEN is not set — bot not started. (Dashboard demo mode does not need the bot.)",
  );
  process.exit(0);
}

// The uno-reverse only exists when the worker knows who the application owner
// is. A missing id fails *open* (the owner can be burg'd like anyone else),
// so say so loudly at boot instead of letting it look like a burg bug —
// especially when two workers share a token and only one of them has it set.
if (!ownerUserId) {
  log.warn(
    "MONARCH_OWNER_USER_ID is not set — the application owner can be burg'd and the uno-reverse is off. " +
      "Set it to your Discord user id to protect yourself.",
  );
}

/**
 * Intents: Guilds for slash commands; GuildVoiceStates for the music player
 * (the bot joins voice channels itself and streams audio in-process — see
 * apps/bot/src/music/audio.ts);
 * GuildMessages + MessageContent so the burg relay can read and
 * re-post messages, and so prefix (text) commands can be seen at all.
 * MessageContent is a *privileged* intent — enable it under Bot → Privileged
 * Gateway Intents in the developer portal (free under 100 servers,
 * verification required above that). If it is not enabled Discord refuses
 * the connection, so `start()` falls back to Guilds + VoiceStates with the
 * message features (the burg relay *and* prefix commands) disabled instead of
 * crash-looping the worker — slash commands keep working.
 */
const FULL_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
];
const BASIC_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];

let messageContentEnabled = true;
let client = createClient(FULL_INTENTS);

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

/**
 * Owner-only debugging (`/monarch debug on`). Off unless the bot's owner asks
 * for it, and memory-only: a restart puts it back to off. When it is on, raw
 * failure detail (yt-dlp's stderr, stack traces) is posted next to the
 * human-readable line in the same channel music announcements go to.
 */
const debugFlags = new DebugFlags();

const debugReporter: DebugReporter = {
  enabled: () => debugFlags.enabled,
  post: (guildId, text) => {
    const channelId = music?.announcementChannelId(guildId);
    if (!channelId) return;
    void client.channels
      .fetch(channelId)
      .then(async (channel) => {
        if (channel?.isSendable()) {
          await channel.send({ content: `\`\`\`\n${clampDebugText(text)}\n\`\`\`` });
        }
      })
      .catch((e) => log.warn("debug report failed", { guildId, error: String(e) }));
  },
};

function getMusic(): MusicManager {
  music ??= new MusicManager(
    client,
    (guildId, embed: APIEmbed, content?: string) => {
      const channelId = music?.announcementChannelId(guildId);
      if (!channelId) return;
      void client.channels
        .fetch(channelId)
        .then(async (channel) => {
          if (channel?.isSendable()) await channel.send({ embeds: [embed], content });
        })
        .catch((e) => log.warn("music announcement failed", { guildId, error: String(e) }));
    },
    undefined,
    undefined,
    debugReporter,
  );
  return music;
}

/** One line describing the audio path, for the boot log. */
function describeAudio(): string {
  const ffmpeg = resolveFfmpegPath();
  return ffmpeg
    ? `yt-dlp + ffmpeg (${ffmpeg})`
    : "yt-dlp (Opus passthrough — no ffmpeg, volume is fixed)";
}

/**
 * Music doctor, run at boot: probes yt-dlp (downloading the official build on
 * first use) and reports what the audio pipeline will be. Errors are logged,
 * never thrown — a machine without yt-dlp still runs every other feature, and
 * `/music play` will say the same thing in Discord.
 */
async function checkMusicReady(): Promise<void> {
  const probe = await ensureYtdlp();
  if (probe.available) {
    log.info("music ready", {
      ytdlp: probe.version,
      source: probe.source,
      bin: probe.bin,
      ffmpeg: resolveFfmpegPath() ?? null,
    });
    return;
  }
  log.error("music is unavailable", {
    detail: probe.detail,
    hint:
      "Install yt-dlp (https://github.com/yt-dlp/yt-dlp#installation), set YTDLP_PATH to an existing " +
      "binary, or let the bot fetch the official build itself — that happens on the first /music play " +
      "unless YTDLP_AUTO_DOWNLOAD=0 (a read-only filesystem or a blocked GitHub is what stops it). " +
      "`npm run music:setup` does the download up front; see docs/troubleshooting-music.md.",
  });
}

function createClient(intents: number[]): Client {
  // Presence rides the identify payload, so the status is the help command
  // the moment the gateway session opens — including after a reconnect.
  const c = new Client({ intents, presence: helpCommandPresence() });
  c.once(Events.ClientReady, (ready) => {
    // Identify carries the presence, but a custom status set only there is
    // dropped by some gateway sessions. Setting it again once the user
    // exists is what actually sticks. A failure here must not skip the
    // ready log or the music warmup.
    const statusSet = applyHelpStatus(ready.user);
    if (!statusSet) log.warn("could not set help-command status");
    log.info("bot ready", {
      user: ready.user.tag,
      // Which machine/container this is: two workers sharing one token each
      // log a ready line, and the hostname tells them apart.
      instance: os.hostname(),
      guilds: ready.guilds.cache.size,
      status: BOT_STATUS_TEXT,
      burg: messageContentEnabled,
      // The same flag gates the relay and text commands: both need to read
      // other people's message content.
      prefixCommands: messageContentEnabled,
      // The backend knows which pipeline it will actually use (transcode vs
      // Opus passthrough); describeAudio() is the fallback before it exists.
      audio: music?.audioDescription() ?? describeAudio(),
    });

    // Warm the music pipeline up in the background: the first /music play
    // shouldn't be the thing that discovers yt-dlp isn't installed yet (or
    // downloads it). Failures are logged with the fix, never fatal — every
    // other feature keeps working without yt-dlp.
    void checkMusicReady();
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

/** Resolve when `p` settles, or after `ms` — whichever happens first. */
function capWait(p: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  try {
    // Stops playback and closes every voice connection (so no guild is left
    // with a silent bot in its voice channel). Awaited — the disconnects are
    // gateway frames, and exiting first would drop them — but capped well
    // inside systemd's TimeoutStopSec / the container's grace period, so a
    // wedged download cannot hold the worker up.
    await capWait(music?.shutdown() ?? Promise.resolve(), 2_000);
  } catch (e) {
    log.warn("music shutdown failed", { error: String(e) });
  }
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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── live message relay (burg) ────────────────────────────────────────

const BURG_WEBHOOK_NAME = "Monarch Burg";
const burgWebhookCache = new Map<string, Webhook>();

/** One webhook per channel, created lazily and reused (Discord caps them at 15/channel). */
async function burgWebhook(message: Message<true>): Promise<Webhook | null> {
  const channel = message.channel;
  // Threads post through their parent's webhook with `threadId`.
  const host = channel.isThread() ? channel.parent : channel;
  if (!host || !("fetchWebhooks" in host)) return null;
  const cached = burgWebhookCache.get(host.id);
  if (cached) return cached;
  const me = message.guild.members.me;
  if (!me || !host.permissionsFor(me).has(PermissionFlagsBits.ManageWebhooks)) return null;
  const hooks = await host.fetchWebhooks();
  let hook = hooks.find(
    (candidate) =>
      candidate.owner?.id === client.user?.id &&
      candidate.name === BURG_WEBHOOK_NAME &&
      candidate.token,
  );
  if (!hook) {
    hook = await host.createWebhook({ name: BURG_WEBHOOK_NAME, reason: "Monarch burg relay" });
  }
  burgWebhookCache.set(host.id, hook);
  return hook;
}

/** Drop a cached webhook so the next relay re-fetches (or recreates) it. */
function evictWebhookCache(hook: Webhook): void {
  for (const [channelId, cached] of burgWebhookCache) {
    if (cached.id === hook.id) burgWebhookCache.delete(channelId);
  }
}

function isUnknownWebhook(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 10015;
}

/**
 * Webhook display names may not contain "discord" (Discord rejects the send,
 * which would delete the original with nothing re-posted), so swap one
 * character for a lookalike instead of failing the whole relay.
 */
function sanitizeRelayUsername(displayName: string, fallback: string): string {
  const cleaned = displayName
    .replace(/discord/gi, "d\u0456scord")
    .replace(/clyde/gi, "\u0441lyde")
    .trim();
  const name = cleaned.length > 0 ? cleaned : fallback;
  // Truncate by code point so a trailing emoji isn't sliced in half (Discord
  // caps webhook usernames at 80 characters).
  return Array.from(name).slice(0, 80).join("");
}

// Relay sends for one channel run in order: without this, two quick messages
// race their webhook posts and arrive swapped. The stored promise never
// rejects, so one failed relay can't wedge the channel behind it.
const relayChains = new Map<string, Promise<void>>();

function serializeRelay(channelId: string, task: () => Promise<void>): Promise<void> {
  const previous = relayChains.get(channelId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const stored = current.catch(() => {});
  relayChains.set(channelId, stored);
  const cleanup = () => {
    if (relayChains.get(channelId) === stored) relayChains.delete(channelId);
  };
  current.then(cleanup, cleanup);
  return current;
}

async function onMessage(message: Message) {
  if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return;

  // 1) Text commands. Only when the MessageContent intent is on (without it
  // `message.content` is empty for other people's messages), and never for
  // the bot's own output — relays post through webhooks anyway.
  try {
    const handled = await handlePrefixMessage(message, prefixDeps);
    if (handled) return;
  } catch (e) {
    log.error("prefix command dispatch failed", { error: String(e) });
    return;
  }

  // 2) The burg relay.
  try {
    const burgEntry = burg.get(message.guildId, message.author.id);
    if (!burgEntry) return;

    // Polls can't be re-posted faithfully (recreating one would lose every
    // vote), so they're left alone rather than deleted.
    if (message.poll) {
      log.info("burg skipped — message contains a poll", {
        guildId: message.guildId,
        channelId: message.channelId,
      });
      return;
    }

    const me = message.guild.members.me;
    const channelPerms = me ? message.channel.permissionsFor(me) : null;
    if (!channelPerms?.has(PermissionFlagsBits.ManageMessages)) {
      log.warn("burg'd message left alone — missing Manage Messages", {
        guildId: message.guildId,
        channelId: message.channelId,
      });
      return;
    }
    if (!channelPerms.has(PermissionFlagsBits.SendMessages)) {
      // Deleting a message the bot couldn't re-post would just destroy it.
      log.warn("burg'd message left alone — missing Send Messages", {
        guildId: message.guildId,
        channelId: message.channelId,
      });
      return;
    }

    const content = toBurg(message.content ?? "", burgEntry.style);
    const files = message.attachments.map((a) => a.url);
    const stickers = message.stickers.map((s) => s.name);
    const stickerText =
      stickers.length > 0 ? toBurg(`*(sticker: ${stickers.join(", ")})*`, burgEntry.style) : "";
    const body = [content, stickerText].filter(Boolean).join("\n");
    if (!body && files.length === 0) {
      await message.delete().catch(() => {});
      return;
    }

    const member = message.member;
    const displayName =
      member?.displayName ?? message.author.displayName ?? message.author.username;
    const avatarURL =
      member?.displayAvatarURL({ size: 256 }) ?? message.author.displayAvatarURL({ size: 256 });
    const username = sanitizeRelayUsername(displayName, message.author.username);
    const sendPayload = (): WebhookMessageCreateOptions => ({
      content: truncate(body, 2000) || undefined,
      files: files.slice(0, 10),
      username,
      avatarURL,
      threadId: message.channel.isThread() ? message.channel.id : undefined,
      allowedMentions: { parse: [] },
    });

    // Relay first (attachments are re-uploaded from the original's CDN
    // URLs, which must still exist), then delete. The delete happens even if
    // the relay failed so the gag always holds. One channel relays at a time
    // so quick messages cant arrive swapped.
    await serializeRelay(message.channelId, async () => {
      try {
        const hook = await burgWebhook(message);
        if (hook) {
          try {
            await hook.send(sendPayload());
          } catch (error) {
            // A webhook deleted from Server Settings leaves a stale cache
            // entry: evict it and try once more with a fresh one.
            if (!isUnknownWebhook(error)) throw error;
            log.info("burg webhook was deleted — recreating", {
              guildId: message.guildId,
              channelId: message.channelId,
            });
            evictWebhookCache(hook);
            const fresh = await burgWebhook(message);
            if (!fresh) throw error;
            await fresh.send(sendPayload());
          }
        } else {
          await message.channel.send({
            content: truncate(`**${displayName}**: ${body}`, 2000),
            files: files.slice(0, 10),
            allowedMentions: { parse: [] },
          });
        }
      } catch (e) {
        log.warn("burg relay failed — original still deleted", { error: String(e) });
      }
      await message
        .delete()
        .catch((e) => log.warn("could not delete burg'd message", { error: String(e) }));
    });
  } catch (e) {
    log.error("message relay failed", { error: String(e) });
  }
}

// ── commands (slash + prefix share one set of handlers) ──────────────

/**
 * Every command lives in a surface-neutral handler class (see
 * ./monarch-commands.ts and ./music/commands.ts) that talks to a
 * CommandContext (./context.ts). `onInteraction` wraps interactions in
 * SlashCommandContext, `handlePrefixMessage` wraps messages in
 * PrefixCommandContext — so `/burg @user` and `!burg @user` are the
 * same code, with the same checks, the same API calls and the same replies.
 *
 * This file keeps only what needs the live gateway: the relay webhooks above,
 * the lazily created music manager, and the two event handlers below.
 */
const prefixes = new PrefixRegistry({
  store: internalToken ? internalPrefixStore(appUrl, internalToken) : null,
  log,
});

// Per-guild confession channels: persisted through the dashboard's internal
// API like the command prefix, cached per click so a busy confession channel
// doesn't turn every button press into a fetch.
const confessions = new ConfessionRegistry({
  store: internalToken ? internalConfessionStore(appUrl, internalToken) : null,
  log,
});

// The confession cooldown: one 6h window per Discord user, global across every
// server, stored in the dashboard (same internal API, same token) so a
// redeploy doesn't hand everybody a fresh confession. Degrades to "let them
// confess" when the dashboard is unreachable — see ./confession-cooldown.ts.
const confessionCooldowns = new ConfessionCooldowns({
  store: internalToken ? internalConfessionCooldownStore(appUrl, internalToken) : null,
  log,
});

const monarchCommands = new MonarchCommands({
  appUrl,
  internalToken,
  burg,
  prefixes,
  confessions,
  burgEnabled: () => messageContentEnabled,
  clientId, // for `!invite` — falls back to the bot's own user id below
  ownerUserId,
  debug: debugFlags,
  log,
});
// A bot's user id *is* its application id, so a worker without
// DISCORD_CLIENT_ID can still hand out an invite link.
monarchCommands.botUserId = () => client.user?.id ?? null;

/** Prefix dispatcher dependencies — `music` is lazy so voice never blocks boot. */
const prefixDeps: PrefixDispatcherDeps = {
  prefixes,
  monarch: monarchCommands,
  music: () => getMusicCommands(),
  botUserId: () => client.user?.id ?? null,
  enabled: () => messageContentEnabled, // MessageContent intent → text commands at all
  era: {
    botOwnerId: () => ownerUserId,
    postAsPersona: (message, posts) =>
      postAsEraPersona(message, posts, {
        botUserId: client.user?.id ?? null,
        resolvePersona: () => resolveEraPersona(message.guild, (id) => client.users.fetch(id)),
      }),
  },
  log,
};

/** Wrap a cached-guild interaction, or answer why it can't be used. */
async function slashContext(
  interaction: ChatInputCommandInteraction,
): Promise<SlashCommandContext | null> {
  if (!interaction.inCachedGuild()) {
    await interaction
      .reply({ content: "Run this command inside a server.", flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return null;
  }
  // Never await the network before the first reply: `deferReply` must reach
  // Discord within 3 s of the interaction, and a cold dashboard (serverless
  // cold start + cold database) easily takes longer — the result is
  // `DiscordAPIError[10062]: Unknown interaction` on the first command after
  // a boot. The prefix only affects reply *wording*, so serve the cached
  // value and refresh it in the background.
  const prefix = prefixes.peekSingle(interaction.guildId);
  void prefixes.get(interaction.guildId);
  return new SlashCommandContext(interaction, prefix);
}

/**
 * Discord error codes that mean "this interaction is already dead":
 * - 10062 Unknown interaction — the 3 s window passed before the first
 *   reply (slow network, cold-starting dashboard, overloaded event loop);
 * - 40060 already acknowledged — another worker answered the same
 *   interaction first (two services sharing DISCORD_BOT_TOKEN).
 * Either way retrying the reply fails the same way, so callers log and stop.
 */
function deadInteractionCode(e: unknown): number | null {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 10062 || code === "10062") return 10062;
  if (code === 40060 || code === "40060") return 40060;
  if (/unknown interaction/i.test(String(e))) return 10062;
  if (/already[ -]acknowledged/i.test(String(e))) return 40060;
  return null;
}

/** Log a dead interaction as the operational warning it is — not an error. */
function logDeadInteraction(what: string, e: unknown, code: number): void {
  log.warn(`${what} — interaction expired before the bot answered`, {
    code,
    hint:
      code === 40060
        ? "another worker acknowledged it first — pause any second bot service sharing DISCORD_BOT_TOKEN (see docs/hosting-laptop.md §3)"
        : "slow network, a cold-starting dashboard, or two workers sharing DISCORD_BOT_TOKEN — the next try usually works",
    error: String(e),
  });
}

/** The single error net for slash commands: log, then say so in-channel. */
async function runSlash(
  interaction: ChatInputCommandInteraction,
  what: string,
  run: (ctx: SlashCommandContext) => Promise<void>,
): Promise<void> {
  try {
    const ctx = await slashContext(interaction);
    if (!ctx) return;
    await run(ctx);
  } catch (e) {
    const dead = deadInteractionCode(e);
    if (dead !== null) {
      // The user already saw "This interaction failed" (or another worker
      // answered first) — a retry of the reply would fail the same way.
      logDeadInteraction(what, e, dead);
      return;
    }
    log.error(`${what} failed`, { error: String(e) });
    const msg = "❌ Something went wrong running that command.";
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    } catch {
      // interaction already timed out — nothing more to do
    }
  }
}

/** Error net for the confession components — log, then say so in-channel. */
async function runConfession(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  what: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (e) {
    const dead = deadInteractionCode(e);
    if (dead !== null) {
      logDeadInteraction(what, e, dead);
      return;
    }
    log.error(`${what} failed`, { error: String(e) });
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "❌ Something went wrong with the confession — try again.",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      // interaction already timed out — nothing more to do
    }
  }
}

async function onInteraction(interaction: Interaction) {
  if (interaction.isChatInputCommand()) {
    await runChatInput(interaction);
    return;
  }

  // Confession components: the Confess button opens the modal (unless the
  // person is still cooling down), the modal posts the anonymous embed (and
  // the staff log entry, when configured) after claiming the 6h window.
  if (interaction.isButton() && interaction.customId === CONFESS_BUTTON_ID) {
    const button = interaction;
    await runConfession(interaction, "confess button", () =>
      handleConfessButton(button, { registry: confessions, cooldowns: confessionCooldowns, log }),
    );
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId === CONFESS_MODAL_ID) {
    const modal = interaction;
    await runConfession(interaction, "confession modal", () =>
      handleConfessSubmit(modal, { registry: confessions, cooldowns: confessionCooldowns, log }),
    );
    return;
  }
}

async function runChatInput(interaction: ChatInputCommandInteraction) {
  switch (interaction.commandName) {
    case "music": {
      const sub = interaction.options.getSubcommand(false) ?? "play";
      await runSlash(interaction, "music command", (ctx) => getMusicCommands().run(ctx, sub));
      return;
    }
    case "burg":
      await runSlash(interaction, "burg command", (ctx) => monarchCommands.burg(ctx));
      return;
    case "monarch": {
      const sub = interaction.options.getSubcommand(false) ?? "help";
      await runSlash(interaction, "interaction", (ctx) => monarchCommands.run(ctx, sub));
      return;
    }
    default:
      return;
  }
}

/** Music commands need the (lazily created) manager, so they're lazy too. */
let musicCommands: MusicCommands | null = null;
function getMusicCommands(): MusicCommands {
  musicCommands ??= new MusicCommands(getMusic());
  return musicCommands;
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
    log.error("slash command registration failed — continuing with existing commands", {
      error: String(e),
    });
  }
}

async function start(botToken: string) {
  await registerCommands(botToken);
  try {
    await client.login(botToken);
  } catch (e) {
    if (!isDisallowedIntents(e)) throw e;
    log.error(
      "Message Content intent is not enabled for this application — /burg and all prefix (text) " +
        "commands are disabled; slash commands keep working. " +
        "Enable it under Bot → Privileged Gateway Intents in the Discord developer portal, then restart.",
      { error: String(e) },
    );
    messageContentEnabled = false;
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
