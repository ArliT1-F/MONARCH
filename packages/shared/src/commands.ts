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

export type CommandGroupId = "general" | "design" | "moderation" | "community" | "music";

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
    label: "Jail",
    description:
      "Cute confinement — jailed members may only talk in #jail and their messages come back adorable.",
    icon: "🔒",
  },
  {
    id: "community",
    label: "Community",
    description: "Anonymous confessions — anyone can spill the tea, nobody gets caught.",
    icon: "🤫",
  },
  {
    id: "music",
    label: "Music player",
    description:
      "Play YouTube and Spotify tracks and playlists in voice channels, with a shared queue and vote-skip.",
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
    details:
      "Replies with a direct link to this server's dashboard so you don't have to dig through the server picker.",
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
      "Reports which server the bot sees, where the dashboard lives, how many members are currently jailed, and a reminder that all design changes flow through the dashboard.",
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
      "Every Monarch command also works as a plain text message: `!help`, `!play <song>`, `!jail @user`. Without an argument this shows the prefix your server currently uses; with one it changes it (1–4 punctuation characters, for example `?`, `m!` or `>>`). The default prefix `!` and an @Monarch mention keep working either way, so you can never lock yourself out. Prefix commands are stored per server and need the same privileged Message Content intent as the jail relay.",
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
    args: [
      {
        name: "name",
        description: "Optional name for the backup (defaults to a timestamped label).",
      },
    ],
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
    name: "/monarch debug",
    usage: "/monarch debug [state]",
    prefixUsage: "!monarch debug [state]",
    prefixAliases: ["debug"],
    group: "general",
    summary: "Owner-only: toggle raw error reporting for music failures.",
    who: "the Monarch application owner (MONARCH_OWNER_USER_ID)",
    details:
      "A switch only the bot's owner can flip. With debugging **on**, every music failure is followed by the raw error — the downloader's own words (yt-dlp stderr), the exit code, the stack trace — posted in the same channel as the tidied-up message. With it **off** (the default) failures stay one human-readable line. The state is kept in memory: a bot restart puts it back to off, so a forgotten switch can never leave raw internals in a server forever. Everyone else gets the same refusal, and never learns whether the switch is on.",
    args: [
      {
        name: "state",
        description: "`on` or `off` — omit to see the current state.",
        required: false,
      },
    ],
    examples: ["/monarch debug on", "/monarch debug off", "!debug on", "!debug"],
    notes: [
      "Only the user id in `MONARCH_OWNER_USER_ID` can use it; without that variable set the command refuses everyone.",
      "Debug output is raw by design — it can include URLs, cookies names and stack traces. Turn it off when you're done.",
    ],
  },
  {
    name: "/monarch jailed",
    usage: "/monarch jailed",
    prefixUsage: "!monarch jailed",
    prefixAliases: ["jailed"],
    group: "moderation",
    summary: "List who is currently jailed in this server.",
    who: "Administrator or Kick Members",
    details:
      "Shows every active jail: who, until when (or 'until released'), which style, and who jailed them. Run /jail on them again with no options to set them free.",
  },
  {
    name: "/monarch jail",
    usage: "/monarch jail setup [#channel] [staff]",
    prefixUsage: "!jail setup [#channel] [staff]",
    prefixAliases: ["jail"],
    group: "moderation",
    summary: "Set up (or switch off) the #jail cell that jailed members are confined to.",
    who: "Manage Server or Administrator",
    details:
      "`/monarch jail setup` builds the cell: Monarch creates a **#jail** channel and **creates the @jailed role itself** (it never adopts an existing role), hides #jail from @everyone, and — this is the part that matters — denies the @jailed role **View Channel and Send Messages on every other channel in the server**, so a jailed member can only read and type in #jail and cannot follow anyone back out into the rest of the server. The role is created with no server-wide permissions; jailed members get it added when jailed and removed on release. Roles that already have moderation powers (Manage Server, Kick/Ban Members, Manage Messages, Moderate Members, Manage Roles, Administrator) are granted access to #jail so staff can watch; pass `staff` to add another role (e.g. a Trial Mod role that holds none of those permissions). Pass `channel` to use an existing channel named #jail instead of creating one.\n\nWhile setup is on, `/jail @user` also **confines** them: they can only talk in #jail, anything they type elsewhere is deleted and they get a DM pointing at #jail, and their #jail messages are still re-posted in the cute style — a cell with a mirror. `/monarch jail disable` releases everyone, strips the overwrites and switches confinement off (the gag itself keeps working). `/monarch jail status` shows the configured channel, role and staff roles.\n\nWithout setup, `/jail` still runs, but it is the old relay-only gag: messages are re-posted cutely wherever they are typed and nobody is confined.",
    args: [
      {
        name: "channel",
        description: "Use this channel as #jail — omit to let Monarch create one.",
      },
      {
        name: "staff",
        description: "An extra role that may see #jail (moderation roles get access automatically).",
      },
    ],
    examples: [
      "/monarch jail setup",
      "/monarch jail setup #jail @Trial Mod",
      "!jail setup #jail",
      "!jail status",
      "!monarch jail disable",
    ],
    notes: [
      "Needs INTERNAL_API_TOKEN set in the dashboard and the bot (the setup must survive a restart).",
      "Monarch needs Manage Channels and Manage Roles to build the cell, and Manage Messages for the confinement itself.",
      "The @jailed role is owned by Monarch: setup creates it with no server-wide permissions, denies it View Channel and Send Messages in every other channel, and jailed members get it added when jailed and removed on release.",
      "Staff access is re-synced every time you run setup, so roles promoted later can be included by running setup again.",
      "Discord Administrator permissions bypass channel denies; do not jail administrators. A role granting View Channel globally also defeats confinement.",
    ],
  },
  {
    name: "/monarch report",
    usage: "/monarch report",
    prefixUsage: "!monarch report",
    prefixAliases: ["report"],
    group: "design",
    summary: "🗳 Vote-locked: post the full Design Analyzer report as a Markdown file.",
    who: "Manage Server or Administrator, and a recent top.gg vote",
    details:
      "Runs the same deterministic 0–100 design score as the dashboard's Design Analyzer (organization · naming · role consistency · branding, with every check's suggestion) and posts it as a `.md` file you can keep or paste into a doc. Read-only: it never changes the server. Voters get this command; see `/monarch vote`.",
    examples: ["/monarch report", "!report"],
    notes: [
      "Needs INTERNAL_API_TOKEN (the report is computed by the dashboard from the live server).",
      "Vote-locked: run `/monarch vote` to vote for Monarch on top.gg — the unlock lasts as long as top.gg counts your vote (12 hours).",
    ],
  },
  {
    name: "/monarch vote",
    usage: "/monarch vote",
    prefixUsage: "!monarch vote",
    prefixAliases: ["vote"],
    group: "general",
    summary: "Vote for Monarch on top.gg and unlock the voter perks.",
    who: "everyone",
    details:
      "Posts the top.gg vote link and, when the bot can check votes (`TOPGG_TOKEN`), says whether your vote is currently counted and what it unlocks: the premium jail styles (pirate, shakespeare, robot), `/music autoplay` (radio mode) and `/monarch report` (the full Design Analyzer report in chat). One vote runs for 12 hours; every command that needs it says so instead of failing silently.",
    examples: ["/monarch vote", "!vote"],
    notes: [
      "Self-hosted Monarch runs without TOPGG_TOKEN: nobody can be checked, so every perk is unlocked and nothing is locked behind votes.",
    ],
  },
  {
    name: "/monarch confession",
    usage: "/monarch confession setup [channel] [logs]",
    prefixUsage: "!monarch confession setup [#channel] [#logs]",
    prefixAliases: ["confession"],
    group: "community",
    summary: "Set up (or disable) the anonymous confession channel.",
    who: "Manage Server or Administrator",
    details:
      "Setup points Monarch at a confession channel (the channel where you run it by default) and an optional staff-only log channel, then posts the first 'starter' confession there. Anyone can then confess from the **Confess** button on any confession: the post goes to the confession channel as a fully anonymous embed — no username, no avatar, no id — and when a log channel is set, staff get a full entry there (who, when, the text, and a link to the public message). `/monarch confession disable` switches the feature off again (old messages stay in the channel). Confessions are rate-limited to **one per person every 6 hours**, counted across every server Monarch is in: the Confess button answers with a countdown while the window is running instead of opening the form.",
    args: [
      {
        name: "channel",
        description:
          "Where confessions are posted — omit to use the channel where you run the command.",
      },
      {
        name: "logs",
        description:
          "Staff-only channel that receives full log entries (who/when/link). Must differ from the confession channel; omit for no logs (fully anonymous).",
      },
    ],
    examples: [
      "/monarch confession setup #confessions #confession-logs",
      "/monarch confession setup",
      "!monarch confession disable",
      "!confession setup #confessions",
    ],
    notes: [
      "Needs INTERNAL_API_TOKEN set in the dashboard and the bot (the setup must survive a restart).",
      "Anyone in the server can confess — the Confess button and form need no permission.",
      "One confession per person every 6 hours, shared across every server (confessing here makes you wait elsewhere too). Manage Server / Administrator skip the wait; a failed post never costs anybody their window.",
      "The log channel must be different from the confession channel — it names names, so keep it staff-only.",
      "Confessions are capped at 2000 characters (the form enforces it).",
    ],
  },
];

/** Cat cards are a lightweight standalone prefix/slash command. */
export const CAT_COMMANDS: CommandDoc[] = [
  {
    name: "/cat",
    usage: "/cat",
    prefixUsage: "!cat",
    prefixAliases: ["cat", "c"],
    group: "community",
    summary: "Roll a cat card and adopt it before someone else does.",
    who: "everyone",
    details:
      "Draws a random cat card using its rarity drop rate, shows the image and all-server pull count, and lets one person adopt that card in this server. The same card may be adopted independently in another server.",
    examples: ["!cat", "!c", "/cat"],
    notes: [
      "Cat images are loaded from the repository's `cats/` folders; the filename becomes the card name.",
      "The bot owner can add an image by DMing `!cat add <rarity>`, then uploading it; Mythic cards drop at 0.01%.",
      "Only add images you own or have permission to reuse. Global pull totals and adoptions require INTERNAL_API_TOKEN for persistent storage.",
    ],
  },
];

/** The standalone /jail toggle is documented beside the Monarch jail commands. */
export const JAIL_COMMANDS: CommandDoc[] = [
  {
    name: "/jail",
    usage: "/jail @user [duration] [style] [reason]",
    prefixUsage: "!jail @user [duration] [style] [reason]",
    prefixAliases: ["jail"],
    group: "moderation",
    summary: "Send a member to #jail — only #jail hears them, and everything they say comes back cute.",
    who: "Administrator or Kick Members",
    details:
      "Jails the selected member until you run the command again on them. With `/monarch jail setup` in place this is a real cell: they are given the **@jailed** role, which can see **only #jail**, so the rest of the server is invisible to them; anything they type in another channel is deleted and they get a DM pointing at #jail; and what they do type in #jail is deleted and re-posted through a webhook under their own name and avatar in a cute uwu/owo spelling — staff get to watch, nobody else can see or answer them. Without setup it is the relay-only gag: every message they post is re-posted cutely, wherever it was typed. Run `/jail` on the same member again with no options to release them (the joke is over and their role goes away), or pass options to update the timer and style. Styles: random, soft, cat, chaotic — plus **pirate**, **shakespeare** and **robot**, which are voter perks (see `/monarch vote`).",
    args: [
      { name: "user", description: "Who to jail.", required: true },
      {
        name: "duration",
        description: "e.g. 10m, 2h, 1d, 1h30m — empty = until toggled off with /jail.",
      },
      {
        name: "style",
        description: "random, soft, cat, chaotic (+ pirate, shakespeare, robot for voters).",
      },
      { name: "reason", description: "Shown in the confirmation and in the staff log entry." },
    ],
    examples: [
      "/jail @icy404 10m",
      "/jail @icy404 style:cat",
      "/jail @icy404 1h pirate being a scourge",
      "/jail @icy404",
    ],
    notes: [
      "Needs the privileged Message Content gateway intent plus Manage Messages (deleting and re-posting).",
      "Confining someone to #jail needs the cell — run `/monarch jail setup` once. The relay itself works without it.",
      "A member whose highest role is at or above yours can't be jailed; Discord Administrator permissions bypass channel denies, so administrators cannot be jailed.",
      "The bot owner and the server owner are never jailed — trying it on the bot owner jails you instead.",
      "Running /jail with options updates the timer/style; running it bare releases them. Durations run from 30s to 28d.",
    ],
  },
];

export const MUSIC_COMMANDS: CommandDoc[] = [
  {
    name: "/music play",
    usage: "/music play <link or search> [source:youtube|spotify]",
    prefixUsage: "!music play <link or search> [youtube|spotify]",
    prefixAliases: ["play", "p"],
    group: "music",
    summary: "Play or queue a song, playlist or album (pick YouTube or Spotify).",
    who: "everyone in a voice channel",
    details:
      "Joins your voice channel (or queues if something is already playing) and starts playback. Accepts YouTube video links, YouTube playlist links, Spotify track/album/playlist links and plain search text. Search text and Spotify tracks are matched against YouTube at play time. If the bot is paused, /music play also unpauses. Use source to force where a plain search looks: youtube (default) searches YouTube, spotify searches Spotify first (needs Spotify API configured) and then plays via YouTube. Links are always honored regardless of source.",
    args: [
      { name: "query", description: "A YouTube/Spotify link or a search phrase.", required: true },
      {
        name: "source",
        description: "Where to search: youtube (default) or spotify. Links ignore this.",
      },
    ],
    examples: [
      "/music play https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "/music play https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
      "/music play daft punk around the world",
      "/music play query:daft punk around the world source:spotify",
      "/music play query:never gonna give you up source:youtube",
      "!play never gonna give you up",
      "!play never gonna give you up spotify",
      "!play spotify never gonna give you up",
      "!play youtube never gonna give you up",
      "!p blinding lights spotify",
    ],
    notes: [
      "Default search is YouTube. Use source:spotify or suffix 'spotify' to search Spotify first.",
      "Playlists are imported up to the queue limit; the reply tells you how many tracks made it in.",
      "Spotify search and Spotify links need SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET on the bot — without them only YouTube and search work.",
      "Prefix examples: !play <song> (youtube), !play <song> spotify, !play spotify <song>, !play yt <song>.",
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
    details:
      "Freezes playback where it is. The queue is kept, so /music resume continues exactly here.",
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
    details:
      "Without an argument it shows the current volume. 100 is normal loudness; 150 is the ceiling.",
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
    details:
      "Randomizes the play order of everything that is queued. The track that's playing is left alone.",
  },
  {
    name: "/music autoplay",
    usage: "/music autoplay [mode:on|off]",
    prefixUsage: "!music autoplay [on|off]",
    prefixAliases: ["autoplay", "radio"],
    group: "music",
    summary: "🗳 Vote-locked: radio mode — queue a related track when the queue runs dry.",
    who: "everyone in the bot's voice channel, and a recent top.gg vote (to switch it on)",
    details:
      "With autoplay on, Monarch keeps the session alive by itself: when the last queued track finishes naturally, it searches for a track related to the one that just ended, queues it, and announces it as autoplay. Loop modes still win — `loop track` and `loop queue` never reach autoplay — and a manual skip, stop or empty queue stays empty. Without an argument it shows the current mode; `on`/`off` changes it.\n\nVoter perk: switching autoplay **on** needs a recent top.gg vote (see `/monarch vote`). Switching it **off** never does, and an instance without `TOPGG_TOKEN` has everything unlocked.",
    args: [{ name: "mode", description: "on or off — omitted = show." }],
    examples: ["/music autoplay", "/music autoplay on", "!radio off"],
    notes: [
      "Vote-locked to switch on: `/monarch vote` posts the link; top.gg counts a vote for 12 hours.",
      "Autoplay only adds a track after a **finished** track — skips, failures, `stop` and both loop modes are left alone.",
      "Related tracks come from a YouTube search based on the track that just finished, so occasionally the robot has questionable taste.",
    ],
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
    details:
      "The full reset: playback stops, the queue and any pending skip votes are cleared, and the bot disconnects.",
  },
];

/** Every command, in display order. */
export const COMMAND_CATALOG: CommandDoc[] = [
  ...MONARCH_COMMANDS,
  ...CAT_COMMANDS,
  ...JAIL_COMMANDS,
  ...MUSIC_COMMANDS,
];

export function commandsByGroup(group: CommandGroupId): CommandDoc[] {
  return COMMAND_CATALOG.filter((c) => c.group === group);
}
