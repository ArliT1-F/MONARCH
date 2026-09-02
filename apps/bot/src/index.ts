import { Client, GatewayIntentBits, Events, MessageFlags } from "discord.js";
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
const appUrl = process.env.APP_URL ?? "http://localhost:3000";

if (!token) {
  log.warn("DISCORD_BOT_TOKEN is not set — bot not started. (Dashboard demo mode does not need the bot.)");
  process.exit(0);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  log.info("bot ready", { user: c.user.tag, guilds: c.guilds.cache.size });
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

client.login(token).catch((e) => {
  log.error("login failed — check DISCORD_BOT_TOKEN", { error: String(e) });
  process.exit(1);
});
