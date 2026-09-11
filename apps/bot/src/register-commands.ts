import { REST, Routes } from "discord.js";
import { createLogger } from "@monarch/shared";
import { burgCommandJSON, monarchCommandJSON } from "./commands.js";
import { musicCommandJSON } from "./music/commands.js";

/**
 * One-off script: registers Monarch's slash commands globally, or in one
 * guild when DISCORD_GUILD_ID is set.
 */
const log = createLogger("bot.register");

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID?.trim();
if (!token || !clientId) {
  log.error("DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required");
  process.exit(1);
}

const commands = [monarchCommandJSON(), burgCommandJSON(), musicCommandJSON()];
const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);

const rest = new REST({ version: "10" }).setToken(token);
await rest.put(route, { body: commands });
log.info("registered slash commands", {
  count: commands.length,
  names: commands.map((command) => command.name),
  scope: guildId ? "guild" : "global",
  ...(guildId ? { guildId } : {}),
});
