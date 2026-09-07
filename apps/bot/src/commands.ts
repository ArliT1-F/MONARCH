import { SlashCommandBuilder, type RESTPostAPIApplicationCommandsJSONBody } from "discord.js";

/**
 * Monarch's slash commands — the single source of truth used by both the
 * worker (apps/bot/src/index.ts, registers at startup) and the one-off
 * `npm run register-commands` script.
 *
 * The bot stays lightweight: commands only give dashboard links and quick
 * actions. Any structural change or generated content is executed by the
 * dashboard API layer (through the Target Resolver), never by this process.
 */
export function monarchCommandJSON(): RESTPostAPIApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("monarch")
    .setDescription("Monarch — design your Discord server")
    .addSubcommand((s) =>
      s.setName("dashboard").setDescription("Open this server in the Monarch design studio"),
    )
    .addSubcommand((s) =>
      s.setName("status").setDescription("Show Monarch's status for this server"),
    )
    .addSubcommand((s) =>
      s.setName("embed").setDescription("Open the Embed Builder for this server"),
    )
    .addSubcommand((s) =>
      s
        .setName("test")
        .setDescription("Test-send or publish the saved embed/message design")
        .addStringOption((o) =>
          o
            .setName("kind")
            .setDescription("Which design to send")
            .setRequired(true)
            .addChoices(
              { name: "Embed", value: "embed" },
              { name: "Message", value: "message" },
            ),
        )
        .addStringOption((o) =>
          o
            .setName("mode")
            .setDescription("Test → designated testing channel; publish → designated announcements channel")
            .addChoices(
              { name: "Test", value: "test" },
              { name: "Publish", value: "publish" },
            ),
        )
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Send here instead of the designated channel"),
        ),
    )
    .toJSON();
}
