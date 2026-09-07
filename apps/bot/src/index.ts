import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from "discord.js";
import { createLogger } from "@monarch/shared";
import { monarchCommandJSON } from "./commands.js";

/**
 * Monarch bot — deliberately lightweight.
 *
 * The web dashboard is the product; the bot is the integration layer.
 * Commands only provide quick actions and dashboard links. Structural
 * changes are executed by the API layer through @monarch/discord (REST),
 * not by this process.
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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  log.info("bot ready", { user: c.user.tag, guilds: c.guilds.cache.size });
});

// Surface gateway trouble instead of letting an EventEmitter "error" event
// take the whole worker down (discord.js reconnects on its own).
client.on(Events.Error, (e) => {
  log.error("gateway error", { error: String(e) });
});

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

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "monarch") return;

  const sub = interaction.options.getSubcommand(false);
  const reply = (content: string) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral });
  try {
    switch (sub) {
      case "dashboard": {
        const url = interaction.guildId ? `${appUrl}/s/${interaction.guildId}` : appUrl;
        await reply(`👑 Design **${interaction.guild?.name ?? "your server"}** in the Monarch studio:\n${url}`);
        break;
      }
      case "status": {
        await reply(
          [
            "**Monarch** — Design your Discord.",
            `• Server: ${interaction.guild?.name ?? "—"}`,
            `• Dashboard: ${appUrl}`,
            "• All design changes are previewed and applied from the dashboard.",
          ].join("\n"),
        );
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
          info =
            "\n\nℹ Tip: set `INTERNAL_API_TOKEN` in the dashboard and bot to see the saved embed here.";
        } else {
          try {
            const res = await fetch(
              `${appUrl}/api/internal/guilds/${interaction.guildId}/workspace`,
              { headers: internalHeaders() },
            );
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
        await reply(
          `👑 **Embed Builder** for **${interaction.guild?.name ?? "your server"}**:\n${url}${info}`,
        );
        break;
      }
      case "test": {
        if (!interaction.guildId) {
          await reply("Run this command inside the server you want to test.");
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
          const res = await fetch(
            `${appUrl}/api/internal/guilds/${interaction.guildId}/workspace/send`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", ...internalHeaders() },
              body: JSON.stringify({ kind, mode, target }),
            },
          );
          const data = (await res.json()) as {
            ok?: boolean;
            channelName?: string;
            error?: { message: string; reason?: string; fix?: string };
          };
          if (res.ok && data.ok) {
            await reply(
              `✅ ${mode === "publish" ? "Published" : "Tested"} **${kind}** to #${data.channelName}.`,
            );
          } else {
            const e = data?.error ?? { message: "Monarch couldn't send the design." };
            await reply(
              `❌ ${e.message}\n${[e.reason, e.fix].filter(Boolean).join("\n")}`.trim(),
            );
          }
        } catch {
          await reply("❌ Couldn't reach the Monarch dashboard.");
        }
        break;
      }
      default:
        await reply("Use `/monarch dashboard`, `/monarch embed` or `/monarch test`.");
    }
  } catch (e) {
    log.error("interaction failed", { error: String(e) });
  }
});

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

registerCommands(token)
  .then(() => client.login(token))
  .catch((e) => {
    log.error("bot startup failed", { error: String(e) });
    process.exit(1);
  });
