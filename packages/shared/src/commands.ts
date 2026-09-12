import {
  COMMAND_PREFIX_CHARS,
  DEFAULT_COMMAND_PREFIX,
  MAX_COMMAND_PREFIX_LENGTH,
} from "./prefix.js";

/**
 * Monarch's command catalog — the single source of truth for every command
 * (slash **and** prefix), used by:
 *
 * - the bot, to render `/monarch help` and `!help` (so Discord help can never
 *   drift from what's registered), and
 * - the dashboard's **Help & Commands** page, which renders the same
 *   entries with full usage details.
 *
 * Keep `usage` identical to the SlashCommandBuilder options in
 * apps/bot/src/commands.ts — a test asserts they match. Keep `prefixUsage`
 * and `prefixAliases` identical to the prefix router in
 * apps/bot/src/prefix/commands.ts — a test asserts that too.
 */

export type CommandGroupId = "general" | "design" | "moderation" | "music";

export interface CommandGroup {
  id: CommandGroupId;
  label: string;
  /** Short line shown above the group on the dashboard. */
  description: string;
  icon: string;
}

export interface CommandArg {
  name: string;
  description: string;
  required?: boolean;
}

export interface CommandDoc {
  /** Slash path, e.g. "/monarch backup" or "/music play". */
  name: string;
  /** Full usage line including optional options in [brackets]. */
  usage: string;
  /**
   * Same command in prefix form, written with the default prefix (`!`) —
   * e.g. "!monarch backup [name]". Servers can change their prefix with
   * `!prefix set`, so docs and help always show the *shape*, not a promise
   * about the exact character.
   */
  prefixUsage?: string;
  /** Short prefix aliases, e.g. ["backup"] for `!backup`. Never includes the prefix character itself. */
  prefixAliases?: string[];
  group: CommandGroupId;
  /** One-line summary. */
  summary: string;
  /** Who can run it (Discord-side checks happen in the command handler). */
  who: string;
  /** Longer how-to for the dashboard's help page. */
  details?: string;
  args?: CommandArg[];
  examples?: string[];
  /** Requirements and behavior notes (permissions, intents, tokens…). */
  notes?: string[];
}

export const COMMAND_GROUPS: CommandGroup[] = [
  { id: "general", label: "General", description: "Finding your way around Monarch.", icon: "👑" },
  {
    id: "design",
    label: "Design studio",
    description: "Snapshot, export and publish server designs without touching Discord by hand.",
    icon: "🎨",
  },
  {
    id: "moderation",
    label: "Fun relays",
    description: "Jail and burg gags — messages are deleted and re-posted with an enchanted or cute style.",
    icon: "🔒",
  },
  {
    id: "music",
    label: "Music player",
    description: "Play YouTube and Spotify tracks and playlists in voice channels, with a shared queue and vote-skip.",
    icon: "🎵",
  },
];

export const MONARCH_COMMANDS: CommandDoc[] = [
  {
    name: "/monarch help",
    usage: "/monarch help",
  prefixUsage: "!monarch help",
  prefixAliases: ["help", "commands"],
    group: "general",
    summary: "List every Monarch command.",
    who: "everyone",
    details:
      "Posts the full command list as an embed, grouped exactly like this page — the Discord-side copy of this help section. The embed links here for the long-form version.",
  },
  {
    name: "/monarch dashboard",
    usage: "/monarch dashboard",
  prefixUsage: "!monarch dashboard",
  prefixAliases: ["dashboard"],
    group: "general",
    summary: "Open this server in the Monarch design studio.",
    who: "everyone",
    details: "Replies with a direct link to this server's dashboard so you don't have to dig through the server picker.",
  },
  {
    name: "/monarch invite",
    usage: "/monarch invite",
    prefixUsage: "!monarch invite",
    prefixAliases: ["invite", "add"],
    group: "general",
    summary: "Get the link to add Monarch to another server.",
    who: "everyone",
    details:
      "Posts Discord's \u201cAdd to Server\u201d link for Monarch — the same least-privilege link the dashboard's **Add Monarch to Discord** button uses, but without a server pre-selected, so the dialog lets you choose any server you manage. Anyone can run it: no Manage Server needed, because installing a bot is something Discord only allows on servers you can manage, and the link never requests Administrator.",
    examples: ["!invite", "!add", "/monarch invite", "@Monarch invite"],
    notes: [
      "Needs the bot's application id: DISCORD_CLIENT_ID on the worker, or simply being online — the bot's own user id is its application id.",
      "The permission list lives in `packages/shared/src/invite.ts` and is shared with the dashboard's invite button, so the two can never drift.",
    ],
  },
  {
    name: "/monarch status",
    usage: "/monarch status",
  prefixUsage: "!monarch status",
  prefixAliases: ["status"],
    group: "general",
    summary: "Show Monarch's status for this server.",
    who: "everyone",
    details:
      "Reports which server the bot sees, where the dashboard lives, how many members are currently jailed or burg'd, and a reminder that all design changes flow through the dashboard.",
  },
  {
    name: "/monarch prefix",
    usage: "/monarch prefix [prefix]",
    prefixUsage: "!monarch prefix [prefix]",
    prefixAliases: ["prefix"],
    group: "general",
    summary: "Show or change this server's prefix for text commands.",
    who: "Manage Server or Administrator",
    details:
      "Every Monarch command also works as a plain text message: `!help`, `!play <song>`, `!jail @user`. Without an argument this shows the prefix your server currently uses; with one it changes it (1–4 punctuation characters, for example `?`, `m!` or `>>`). The default prefix `!` and an @Monarch mention keep working either way, so you can never lock yourself out. Prefix commands are stored per server and need the same privileged Message Content intent as the jail and burg relays.",
    args: [
      {
        name: "prefix",
        description: `New prefix for this server — 1–${MAX_COMMAND_PREFIX_LENGTH} characters from ${COMMAND_PREFIX_CHARS}. Omit to show the current one.`,
      },
    ],
    examples: ["!prefix", "!prefix set ?", "!prefix set m!", "!prefix reset", "@Monarch prefix >>"],
    notes: [
      `Default prefix: ${DEFAULT_COMMAND_PREFIX} — mentioning the bot always works as a prefix too.`,
      "Needs the privileged Message Content gateway intent (developer portal → Bot → Privileged Gateway Intents). Without it only slash commands are available.",
      "Saving a custom prefix calls the dashboard's internal API, so it needs INTERNAL_API_TOKEN set in the dashboard and the bot.",
      "Matching is case-insensitive and only the shortest unambiguous reading is used: unknown `!words` are ignored so other bots' prefixes keep working.",
    ],
  },
  {
    name: "/monarch backup",
    usage: "/monarch backup [name]",
  prefixUsage: "!monarch backup [name]",
  prefixAliases: ["backup"],
    group: "design",
    summary: "Save a snapshot of the server's categories and channels.",
    who: "Manage Server or Administrator",
    details:
      "Captures the live structure (categories, channels and their settings) as a named snapshot. Restore any snapshot from the dashboard's Backups & History page: it loads as a draft, deleted channels come back as creates, and everything is reviewed through the normal diff preview before it touches Discord.",
    args: [{ name: "name", description: "Optional name for the backup (defaults to a timestamped label)." }],
    examples: ["/monarch backup", "/monarch backup before summer cleanup"],
    notes: ["Needs INTERNAL_API_TOKEN set in both the dashboard and the bot."],
  },
  {
    name: "/monarch export",
    usage: "/monarch export",
  prefixUsage: "!monarch export",
  prefixAliases: ["export"],
    group: "design",
    summary: "Download the server layout as a portable Monarch template (.json).",
    who: "Manage Server or Administrator",
    details:
      "Posts a monarch-template file containing the layout — no snowflakes, no server-specific settings — so it can be imported into any other server from the dashboard's Templates · Import / Export page (always with the full diff preview first).",
    notes: ["Needs INTERNAL_API_TOKEN set in both the dashboard and the bot."],
  },
  {
    name: "/monarch embed",
    usage: "/monarch embed",
  prefixUsage: "!monarch embed",
  prefixAliases: ["embed"],
    group: "design",
    summary: "Open the Embed Builder (and show the saved embed).",
    who: "everyone",
    details:
      "Links straight to the Embed Builder for this server. With INTERNAL_API_TOKEN configured it also previews the embed design that's currently saved in the builder.",
  },
  {
    name: "/monarch test",
    usage: "/monarch test kind:<embed|message> [mode] [channel]",
  prefixUsage: "!monarch test <embed|message> [test|publish] [#channel]",
  prefixAliases: ["test"],
    group: "design",
    summary: "Test-send or publish the saved embed/message design.",
    who: "Manage Server or Administrator",
    details:
      "Sends the design saved in the Embed Builder / Message Designer. In Test mode it goes to your designated testing channel (or the channel you pass); in Publish mode it goes to the designated announcements channel. Monarch never posts into #general by accident — destinations always resolve through the Target Resolver.",
    args: [
      { name: "kind", description: "Which design to send — embed or message.", required: true },
      { name: "mode", description: "Test (default) or Publish." },
      { name: "channel", description: "Send here instead of the designated channel." },
    ],
    examples: ["/monarch test kind:embed", "/monarch test kind:message mode:publish"],
    notes: ["Needs INTERNAL_API_TOKEN set in both the dashboard and the bot."],
  },
  {
    name: "/monarch jail",
    usage: "/monarch jail @user [duration] [reason]",
  prefixUsage: "!monarch jail @user [duration] [reason]",
  prefixAliases: ["jail"],
    group: "moderation",
    summary: "Delete everything the user posts and re-post it in the Standard Galactic Alphabet.",
    who: "Administrator or Kick Members",
    details:
      "Monarch's joke gag: everything the jailed member writes is deleted and re-posted in Minecraft enchanting-table script, under their own name and avatar, until released. Omit the duration to jail them until /monarch unjail; give a duration like 10m, 2h, 1d or 1h30m and they are released automatically. You can only jail members below your own highest role, never yourself, never bots, and the owner can only be jailed by nobody.",
    args: [
      { name: "user", description: "Who to jail.", required: true },
      { name: "duration", description: "e.g. 10m, 2h, 1d, 1h30m — empty = until /monarch unjail." },
      { name: "reason", description: "Shown in the confirmation only." },
    ],
    examples: ["/monarch jail @arli 10m enchanting practice", "/monarch jail @arli"],
    notes: [
      "Needs the privileged Message Content gateway intent (developer portal → Bot → Privileged Gateway Intents).",
      "The bot needs the Manage Messages permission to delete and re-post jailed messages.",
    ],
  },
  {
    name: "/monarch unjail",
    usage: "/monarch unjail @user",
  prefixUsage: "!monarch unjail @user",
  prefixAliases: ["unjail"],
    group: "moderation",
    summary: "Release a jailed user early.",
    who: "Administrator or Kick Members",
    details: "Ends the gag immediately; the member's messages go through normally again.",
    args: [{ name: "user", description: "Who to release.", required: true }],
  },
  {
    name: "/monarch jailed",
    usage: "/monarch jailed",
  prefixUsage: "!monarch jailed",
  prefixAliases: ["jailed"],
    group: "moderation",
    summary: "List who is currently jailed in this server.",
    who: "Administrator or Kick Members",
    details: "Shows every active sentence: who is jailed, until when (or 'until released') and who jailed them.",
  },
];

/** The standalone /burg toggle is documented beside the Monarch moderation gags. */
export const BURG_COMMANDS: CommandDoc[] = [
  {
    name: "/burg",
    usage: "/burg @user [duration] [style] [reason]",
  prefixUsage: "!burg @user [duration] [style] [reason]",
  prefixAliases: ["burg"],
    group: "moderation",
    summary: "Delete a member's messages and re-post them as cute uwu/owo text.",
    who: "Administrator or Kick Members",
    details:
      "Toggles a playful burg relay for the selected member. Their messages are deleted and re-posted through a webhook with their display name and avatar, using readable uwu/owo spelling plus random cute flourishes such as uwu, nya, >w< and cat faces. Run /burg on the same member again to turn it off. The style can be fixed or left random for a different cute variation on every message.",
    args: [
      { name: "user", description: "Who to burg.", required: true },
      { name: "duration", description: "e.g. 10m, 2h, 1d, 1h30m — empty = until toggled off with /burg." },
      { name: "style", description: "random, soft, cat or chaotic — omitted = random." },
      { name: "reason", description: "Shown in the confirmation only." },
    ],
    examples: [
      "/burg @icy404 10m",
      "/burg @icy404 style:cat",
      "/burg @icy404",
    ],
    notes: [
      "Uses the same duration parsing, role hierarchy checks and moderation permissions as /monarch jail.",
      "Needs the privileged Message Content gateway intent and the Manage Messages permission.",
      "A member cannot be burg'd and jailed at the same time; turn one gag off before enabling the other.",
    ],
  },
];

export const MUSIC_COMMANDS: CommandDoc[] = [
  {
    name: "/music play",
    usage: "/music play <link or search>",
  prefixUsage: "!music play <link or search>",
  prefixAliases: ["play", "p"],
    group: "music",
    summary: "Play or queue a song, playlist or album.",
    who: "everyone in a voice channel",
    details:
      "Joins your voice channel (or queues if something is already playing) and starts playback. Accepts YouTube video links, YouTube playlist links, Spotify track/album/playlist links and plain search text. Search text and Spotify tracks are matched against YouTube at play time. If the bot is paused, /music play also unpauses.",
    args: [{ name: "query", description: "A YouTube/Spotify link or a search phrase.", required: true }],
    examples: [
      "/music play https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "/music play https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
      "/music play daft punk around the world",
    ],
    notes: [
      "Playlists are imported up to the queue limit; the reply tells you how many tracks made it in.",
      "Spotify playback needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET on the bot — without them only YouTube and search work.",
    ],
  },
  {
    name: "/music pause",
    usage: "/music pause",
  prefixUsage: "!music pause",
  prefixAliases: ["pause"],
    group: "music",
    summary: "Pause the current song.",
    who: "everyone in the bot's voice channel",
    details: "Freezes playback where it is. The queue is kept, so /music resume continues exactly here.",
  },
  {
    name: "/music resume",
    usage: "/music resume",
  prefixUsage: "!music resume",
  prefixAliases: ["resume"],
    group: "music",
    summary: "Resume after a pause.",
    who: "everyone in the bot's voice channel",
    details: "Continues the paused track from where it stopped.",
  },
  {
    name: "/music skip",
    usage: "/music skip",
  prefixUsage: "!music skip",
  prefixAliases: ["skip", "voteskip"],
    group: "music",
    summary: "Skip the current song — instantly with a DJ/staff role, otherwise by vote.",
    who: "everyone (voting) · DJ, Moderator/Staff and the requester (instant)",
    details:
      "Members with a DJ role, a Moderator/Staff role (or real moderation permissions like Manage Server, Timeout/Kick/Ban Members, Move Members), plus whoever queued the current track, skip immediately — no vote needed. Everyone else starts or joins a skip vote: a majority of the humans currently listening passes it, and the skip happens automatically when the last needed vote lands. Votes reset when the track changes.",
    notes: [
      "DJ roles are recognized by name — DJ by default, configurable with MUSIC_DJ_ROLE_NAMES.",
      "Staff roles: Moderator, Mod, Staff, Admin, Administrator… — configurable with MUSIC_STAFF_ROLE_NAMES.",
    ],
  },
  {
    name: "/music queue",
    usage: "/music queue [page]",
  prefixUsage: "!music queue [page]",
  prefixAliases: ["queue", "q"],
    group: "music",
    summary: "Show the queue and what's playing.",
    who: "everyone",
    details:
      "Posts an embed with the current track (with progress when the length is known) and the upcoming tracks, ten per page. Use the page argument for long queues.",
    args: [{ name: "page", description: "Page number, starting at 1." }],
    examples: ["/music queue", "/music queue 2"],
  },
  {
    name: "/music nowplaying",
    usage: "/music nowplaying",
  prefixUsage: "!music nowplaying",
  prefixAliases: ["nowplaying", "np"],
    group: "music",
    summary: "Show the current track with a progress bar and skip status.",
    who: "everyone",
    details:
      "A focused view of the current track: requester, progress bar, loop mode, volume and how many skip votes are in so far.",
  },
  {
    name: "/music volume",
    usage: "/music volume [0-150]",
  prefixUsage: "!music volume [0-150]",
  prefixAliases: ["volume", "vol"],
    group: "music",
    summary: "Show or set the playback volume.",
    who: "everyone in the bot's voice channel",
    details: "Without an argument it shows the current volume. 100 is normal loudness; 150 is the ceiling.",
    args: [{ name: "level", description: "0–150." }],
    examples: ["/music volume", "/music volume 80"],
  },
  {
    name: "/music loop",
    usage: "/music loop [off|track|queue]",
  prefixUsage: "!music loop [off|track|queue]",
  prefixAliases: ["loop"],
    group: "music",
    summary: "Loop the current track, the whole queue, or nothing.",
    who: "everyone in the bot's voice channel",
    details:
      "track replays the current song forever; queue repeats the whole queue and puts finished songs at the back. Without an argument it cycles off → track → queue.",
    args: [{ name: "mode", description: "off, track or queue — omitted = cycle." }],
    examples: ["/music loop track", "/music loop off"],
  },
  {
    name: "/music shuffle",
    usage: "/music shuffle",
  prefixUsage: "!music shuffle",
  prefixAliases: ["shuffle"],
    group: "music",
    summary: "Shuffle the upcoming tracks.",
    who: "everyone in the bot's voice channel",
    details: "Randomizes the play order of everything that is queued. The track that's playing is left alone.",
  },
  {
    name: "/music remove",
    usage: "/music remove <position>",
  prefixUsage: "!music remove <position>",
  prefixAliases: ["remove"],
    group: "music",
    summary: "Remove one track from the queue.",
    who: "everyone in the bot's voice channel",
    details: "Positions are the #numbers shown by /music queue (1 = the next song that will play).",
    args: [{ name: "position", description: "Queue position to remove.", required: true }],
    examples: ["/music remove 3"],
  },
  {
    name: "/music clear",
    usage: "/music clear",
  prefixUsage: "!music clear",
  prefixAliases: ["clear"],
    group: "music",
    summary: "Empty the queue but keep playing.",
    who: "everyone in the bot's voice channel",
    details: "Drops every upcoming track. The current song finishes (or keep /music skip handy).",
  },
  {
    name: "/music stop",
    usage: "/music stop",
  prefixUsage: "!music stop",
  prefixAliases: ["stop", "leave"],
    group: "music",
    summary: "Stop playback, clear the queue and leave the voice channel.",
    who: "everyone in the bot's voice channel",
    details: "The full reset: playback stops, the queue and any pending skip votes are cleared, and the bot disconnects.",
  },
];

/** Every command, in display order. */
export const COMMAND_CATALOG: CommandDoc[] = [...MONARCH_COMMANDS, ...BURG_COMMANDS, ...MUSIC_COMMANDS];

export function commandsByGroup(group: CommandGroupId): CommandDoc[] {
  return COMMAND_CATALOG.filter((c) => c.group === group);
}