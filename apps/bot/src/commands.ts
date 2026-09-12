import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type APIEmbed,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import {
  COMMAND_CATALOG,
  COMMAND_GROUPS,
  DEFAULT_COMMAND_PREFIX,
  MAX_COMMAND_PREFIX_LENGTH,
  MONARCH_COMMANDS,
  type CommandDoc,
  type CommandGroupId,
} from "@monarch/shared";
import { BURG_STYLES } from "./burg.js";

/**
 Monarch's slash commands — the worker (apps/bot/src/index.ts) registers
 * this at startup; `npm run register-commands` is the one-off variant.
 *
 * The bot stays lightweight: commands give dashboard links, quick actions
 * (backup / export / test-send), the burg gag and the music player. Any
 * structural change or generated content is executed by the dashboard API
 * layer, never by this process.
 *
 * `/monarch help` and the dashboard's Help page both render from the shared
 * command catalog (@monarch/shared/commands) so the two can't drift.
 */
 
 export interface CommandHelp {
  usage: string;
  description: string;
  /** Who can run it (Discord-side checks happen in the handler). */
  who?: string;
}

export const COMMAND_HELP: CommandHelp[] = MONARCH_COMMANDS.map((c) => ({
  usage: c.usage,
  description: c.summary,
  who: c.who === "everyone" ? undefined : c.who,
}));

export function monarchCommandJSON(): RESTPostAPIApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("monarch")
    .setDescription("Monarch — design your Discord server")
    // Guild-only: every subcommand needs a server context.
    .setContexts(0)
    .addSubcommand((s) => s.setName("help").setDescription("List every Monarch command"))
    .addSubcommand((s) =>
      s.setName("dashboard").setDescription("Open this server in the Monarch design studio"),
    )
    .addSubcommand((s) =>
      s.setName("status").setDescription("Show Monarch's status for this server"),
    )
    .addSubcommand((s) =>
      s.setName("invite").setDescription("Get the link to add Monarch to another server"),
    )
    .addSubcommand((s) =>
      s
        .setName("prefix")
        .setDescription("Show or change this server's prefix for text commands (default !)")
        .addStringOption((o) =>
          o
            .setName("prefix")
            .setDescription(
              `1-${MAX_COMMAND_PREFIX_LENGTH} punctuation characters, e.g. ? or m! — omit to show the current prefix`,
            )
            .setMaxLength(MAX_COMMAND_PREFIX_LENGTH),
        ),
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
    .addSubcommand((s) => s.setName("burged").setDescription("List who is currently burg'd here"))
    .toJSON();
}

/**
 * `/burg` is intentionally a top-level command rather than a `/monarch`
 * subcommand: it is a quick, memorable toggle for the uwu relay.
 */
export function burgCommandJSON(): RESTPostAPIApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("burg")
    .setDescription("Toggle cute uwu/owo re-posts for a member")
    .setContexts(0)
    .addUserOption((o) => o.setName("user").setDescription("Who to burg").setRequired(true))
    .addStringOption((o) =>
      o
        .setName("duration")
        .setDescription("e.g. 10m, 2h, 1d — empty = until /burg is used again")
        .setMaxLength(20),
    )
    .addStringOption((o) =>
      o
        .setName("style")
        .setDescription("Cute spelling style; random is the default")
        .addChoices(...BURG_STYLES),
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Shown in the confirmation only").setMaxLength(200),
    )
    .toJSON();
}

/** Bits that let a member run `/burg` and `/monarch burged`. */
export const BURG_PERMISSIONS = [PermissionFlagsBits.KickMembers] as const;

/** Bits that let a member run backup / export / test (mirrors the dashboard's "can design" rule). */
export const DESIGN_PERMISSIONS = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild] as const;


// ── /monarch help ────────────────────────────────────────────────────
const GOLD = 0xf5c542;
const GROUP_ORDER: CommandGroupId[] = ["general", "design", "moderation", "music"];
const FIELD_VALUE_LIMIT = 1024;

/** `also !play, !p` — the short prefix forms of a command, if it has any. */
function aliasSuffix(doc: CommandDoc): string {
  const aliases = doc.prefixAliases ?? [];
  return aliases.length === 0 ? "" : ` · also ${aliases.map((a) => `\`${DEFAULT_COMMAND_PREFIX}${a}\``).join(", ")}`;
}

function groupLines(docs: CommandDoc[]): string[] {
  return docs.map((c) => {
    const who = c.who.toLowerCase() === "everyone" ? "" : ` · *${c.who}*`;
    return `**\`${c.usage}\`**${aliasSuffix(c)} — ${c.summary}${who}`;
  });
}

/**
 * The prefix line for help footers: every command also answers to the
 * server's text prefix (or an @Monarch mention). `prefix` is the guild's
 * configured prefix when the caller knows it — the default is used otherwise.
 */
export function prefixHelpLine(prefix: string = DEFAULT_COMMAND_PREFIX): string {
  const extra = prefix === DEFAULT_COMMAND_PREFIX ? "" : ` (the default \`${DEFAULT_COMMAND_PREFIX}\` still works)`;
  return (
    `-# Prefix commands: every command also works as \`${prefix}help\`, \`${prefix}play <song>\`, ` +
    `\`${prefix}burg @user\`… or with an @Monarch mention${extra}. Change yours with \`${prefix}prefix set <new>\`; ` +
    `\`${prefix}invite\` adds Monarch to another server.`
  );
}

function chunkLines(lines: string[], prefix: string, suffix: string): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (current.length > 0 && length + line.length + 1 > FIELD_VALUE_LIMIT) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((chunk, i) =>
    i === 0 ? chunk : chunk, // grouping handled by the caller via suffixes
  ).map((chunk, i) => (i === 0 ? chunk : chunk)); // (kept simple — see helpEmbeds)
}

/**
 * `/monarch help` → an embed with every command, grouped like the
 * dashboard's Help page. The shared catalog is the single source of truth.
 */
export function renderHelpEmbeds(appUrl: string, guildId?: string, prefix: string = DEFAULT_COMMAND_PREFIX): APIEmbed[] {
  const helpUrl = guildId ? `${appUrl}/s/${guildId}/help` : appUrl;

  const fields: { name: string; value: string }[] = [];
  for (const groupId of GROUP_ORDER) {
    const group = COMMAND_GROUPS.find((g) => g.id === groupId);
    if (!group) continue;
    const lines = groupLines(COMMAND_CATALOG.filter((c) => c.group === groupId));
    if (lines.length === 0) continue;

    // Pack lines into field-sized chunks; continuation fields repeat the label.
    let value = "";
    const parts: string[] = [];
    for (const line of lines) {
      if (value.length + line.length + 1 > FIELD_VALUE_LIMIT) {
        parts.push(value);
        value = "";
      }
      value += (value ? "\n" : "") + line;
    }
    if (value) parts.push(value);
    parts.forEach((part, i) => {
      fields.push({
        name: i === 0 ? `${group.icon} ${group.label}` : `${group.icon} ${group.label} (cont.)`,
        value: part,
      });
    });
  }

  return [
    {
      color: GOLD,
      title: "👑 Monarch — commands",
      description:
        `**Monarch — Design your Discord.** Full usage guide: ${helpUrl}\n` +
        `-# Music player: /music play · pause · resume · skip · queue · nowplaying · volume · loop · shuffle · remove · clear · stop\n` +
        prefixHelpLine(prefix),
      fields,
      footer: { text: "For any issues dm @icy404 on Discord."},
    },
  ];
}

/**
 * Plain-text fallback (kept for logs/tests): renders the /monarch list under
 * Discord's 2000-character message limit.
 */

export function renderHelp(appUrl: string, prefix: string = DEFAULT_COMMAND_PREFIX): string {
  const lines = COMMAND_HELP.map((c) => {
    const who = c.who ? ` — *${c.who}*` : "";
    return `**${c.usage}**${who}\n${c.description}`;
  });
  return [
    "👑 **Monarch commands**",
    "",
    ...lines,
    "",
    `Prefix: every command also answers to \`${prefix}\` (\`${prefix}help\`) or an @Monarch mention — \`${prefix}prefix set <new>\` to change it.`,
    `Dashboard: ${appUrl}`,
  ].join("\n");
}
