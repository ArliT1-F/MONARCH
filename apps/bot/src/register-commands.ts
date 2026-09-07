import { REST, Routes } from "discord.js";
import { createLogger } from "@monarch/shared";
import { monarchCommandJSON } from "./commands.js";

/** One-off script: registers Monarch's slash commands globally. */
const log = createLogger("bot.register");

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) {
  log.error("DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required");
  process.exit(1);
}

const commands = [monarchCommandJSON()];

const rest = new REST({ version: "10" }).setToken(token);
await rest.put(Routes.applicationCommands(clientId), { body: commands });
log.info("registered slash commands", { count: commands.length });
