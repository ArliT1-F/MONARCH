import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";

/**
 * Monarch's slash commands — the single source of truth used by both the
 * worker (apps/bot/src/index.ts, registers at startup) and the one-off
 * `npm run register-commands` script.
 *
 * The bot stays lightweight: commands give dashboard links, quick actions
 * (backup / export / test-send) and the jail moderation gag. Any structural
 * change or generated content is executed by the dashboard API layer
 * (through the Target Resolver), never by this process.
 *
 * `/monarch help` is rendered from COMMAND_HELP so the two can't drift.
 */
export interface CommandHelp {
  usage: string;
  description: string;
  /** Who can run it (Discord-side checks happen in the handler). */
  who?: string;
}

export const COMMAND_HELP: CommandHelp[] = [
  { usage: "/monarch help", description: "Show this list." },
  { usage: "/monarch dashboard", description: "Open this server in the Monarch design studio." },
  { usage: "/monarch status", description: "Show Monarch's status for this server." },
  {
    usage: "/monarch backup [name]",
    description: "Save a snapshot of the server's categories and channels. Restore from the dashboard → Backups & History.",
    who: "Manage Server / Administrator",
  },
  {
    usage: "/monarch export",
    description: "Download the server layout as a portable Monarch template (.json) you can import into any server.",
    who: "Manage Server / Administrator",
  },
  { usage: "/monarch embed", description: "Open the Embed Builder (and show the saved embed)." },
  {
    usage: "/monarch test kind:<embed|message> [mode] [channel]",
    description: "Test-send or publish the saved embed/message design.",
    who: "Manage Server / Administrator",
  },
  {
    usage: "/monarch jail @user [duration] [reason]",
    description:
      "Everything the user posts is deleted and re-posted in the Standard Galactic Alphabet under their name. No duration = until unjailed; e.g. `10m`, `2h`, `1d`.",
    who: "Administrator or Kick Members",
  },
  { usage: "/monarch unjail @user", description: "Release a jailed user early.", who: "Administrator or Kick Members" },
  { usage: "/monarch jailed", description: "List who is currently jailed in this server.", who: "Administrator or Kick Members" },
];

export function monarchCommandJSON(): RESTPostAPIApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("monarch")
    .setDescription("Monarch — design your Discord server")
    // Guild-only: every subcommand needs a server context.
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName("help").setDescription("List every Monarch command"))
    .addSubcommand((s) =>
      s.setName("dashboard").setDescription("Open this server in the Monarch design studio"),
    )
    .addSubcommand((s) =>
      s.setName("status").setDescription("Show Monarch's status for this server"),
    )
    .addSubcommand((s) =>
      s
        .setName("backup")
        .setDescription("Save a snapshot of this server's categories and channels")
        .addStringOption((o) =>
          o.setName("name").setDescription("Optional name for the backup").setMaxLength(100),
        ),
    )
    .addSubcommand((s) =>
      s.setName("export").setDescription("Export this server's layout as a portable Monarch template"),
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
    .addSubcommand((s) =>
      s
        .setName("jail")
        .setDescription("Re-post everything a user says in the Standard Galactic Alphabet")
        .addUserOption((o) => o.setName("user").setDescription("Who to jail").setRequired(true))
        .addStringOption((o) =>
          o
            .setName("duration")
            .setDescription("e.g. 10m, 2h, 1d — leave empty to jail until /monarch unjail")
            .setMaxLength(20),
        )
        .addStringOption((o) =>
          o.setName("reason").setDescription("Shown in the confirmation only").setMaxLength(200),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("unjail")
        .setDescription("Release a jailed user")
        .addUserOption((o) => o.setName("user").setDescription("Who to release").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("jailed").setDescription("List who is currently jailed here"))
    .toJSON();
}

/** Bits that let a member run the moderation subcommands (jail / unjail / jailed). */
export const JAIL_PERMISSIONS = [PermissionFlagsBits.Administrator, PermissionFlagsBits.KickMembers] as const;

/** Bits that let a member run backup / export / test (mirrors the dashboard's "can design" rule). */
export const DESIGN_PERMISSIONS = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild] as const;

/** Render `/monarch help` (kept under Discord's 2000-char message limit). */
export function renderHelp(appUrl: string): string {
  const lines = COMMAND_HELP.map((c) => {
    const who = c.who ? ` — *${c.who}*` : "";
    return `**${c.usage}**${who}\n${c.description}`;
  });
  return [
    "👑 **Monarch commands**",
    "",
    ...lines,
    "",
    `Dashboard: ${appUrl}`,
  ].join("\n");
}
