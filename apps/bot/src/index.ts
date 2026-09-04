import { Client, GatewayIntentBits, Events, MessageFlags, REST, Routes, SlashCommandBuilder } from "discord.js";
import { createLogger } from "@monarch/shared";

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
 * Monarch's Target Resolver — and that happens in the API layer.
 */
const log = createLogger("bot");

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const appUrl = process.env.APP_URL ?? "http://localhost:3000";

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

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "monarch") return;

  const sub = interaction.options.getSubcommand(false);
  try {
    switch (sub) {
      case "dashboard": {
        const url = interaction.guildId ? `${appUrl}/s/${interaction.guildId}` : appUrl;
        await interaction.reply({
          content: `👑 Design **${interaction.guild?.name ?? "your server"}** in the Monarch studio:\n${url}`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      case "status": {
        await interaction.reply({
          content: [
            "**Monarch** — Design your Discord.",
            `• Server: ${interaction.guild?.name ?? "—"}`,
            `• Dashboard: ${appUrl}`,
            "• All design changes are previewed and applied from the dashboard.",
          ].join("\n"),
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      default:
        await interaction.reply({
          content: `Use \`/monarch dashboard\` to open the design studio.`,
          flags: MessageFlags.Ephemeral,
        });
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

  const commands = [
    new SlashCommandBuilder()
      .setName("monarch")
      .setDescription("Monarch — design your Discord server")
      .addSubcommand((s) => s.setName("dashboard").setDescription("Open this server in the Monarch design studio"))
      .addSubcommand((s) => s.setName("status").setDescription("Show Monarch's status for this server"))
      .toJSON(),
  ];

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
