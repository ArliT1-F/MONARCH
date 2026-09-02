import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { createLogger } from "@monarch/shared";

/** One-off script: registers Monarch's (minimal) slash commands globally. */
const log = createLogger("bot.register");

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) {
  log.error("DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("monarch")
    .setDescription("Monarch — design your Discord server")
    .addSubcommand((s) => s.setName("dashboard").setDescription("Open this server in the Monarch design studio"))
    .addSubcommand((s) => s.setName("status").setDescription("Show Monarch's status for this server"))
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(token);
await rest.put(Routes.applicationCommands(clientId), { body: commands });
log.info("registered slash commands", { count: commands.length });
