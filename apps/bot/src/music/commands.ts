import {
  SlashCommandBuilder,
  InteractionContextType,
  type GuildMember,
  type VoiceBasedChannel,
} from "discord.js";
import { FORCE_SKIP_LABEL, formatDuration, parseVolume, type LoopMode } from "@monarch/music";
import type { CommandContext } from "../context.js";
import type { MusicManager } from "./player.js";
import { nowPlayingDetailed, queueEmbed } from "./player.js";
import { SourceError, musicLimits, resolveQuery, spotifyConfigured } from "./sources.js";

/**
 * `/music` — playback controls, written once against {@link CommandContext}
 * so the slash command and its prefix twins (`!play`, `!skip`, `!queue`…) run
 * the identical code path. The heavy lifting lives in MusicManager (voice)
 * and @monarch/music (queue rules, votes); this file is the Discord surface:
 * checks, replies and embeds.
 */

const MUSIC_COLOR = 0xf5c542;

export function musicCommandJSON() {
  return new SlashCommandBuilder()
    .setName("music")
    .setDescription("Play YouTube & Spotify music in voice channels")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("play")
        .setDescription("Play or queue a song, playlist or album (YouTube / Spotify / search)")
        .addStringOption((o) =>
          o
            .setName("query")
            .setDescription("A YouTube or Spotify link, or a search phrase")
            .setRequired(true)
            .setMaxLength(600),
        ),
    )
    .addSubcommand((s) => s.setName("pause").setDescription("Pause the current song"))
    .addSubcommand((s) => s.setName("resume").setDescription("Resume the paused song"))
    .addSubcommand((s) =>
      s.setName("skip").setDescription("Skip the current song (vote, or instantly with DJ / staff / requester)"),
    )
    .addSubcommand((s) =>
      s
        .setName("queue")
        .setDescription("Show the queue and what's playing")
        .addIntegerOption((o) =>
          o.setName("page").setDescription("Page number for long queues").setMinValue(1).setMaxValue(50),
        ),
    )
    .addSubcommand((s) => s.setName("nowplaying").setDescription("Show the current track with progress"))
    .addSubcommand((s) =>
      s
        .setName("volume")
        .setDescription("Show or set the volume (0–150%)")
        .addIntegerOption((o) =>
          o.setName("level").setDescription("0 = mute, 100 = normal, 150 = loudest").setMinValue(0).setMaxValue(150),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("loop")
        .setDescription("Loop the track, the queue, or nothing")
        .addStringOption((o) =>
          o
            .setName("mode")
            .setDescription("Omit to cycle off → track → queue")
            .addChoices(
              { name: "Off", value: "off" },
              { name: "This track", value: "track" },
              { name: "Whole queue", value: "queue" },
            ),
        ),
    )
    .addSubcommand((s) => s.setName("shuffle").setDescription("Shuffle the upcoming tracks"))
    .addSubcommand((s) =>
      s
        .setName("remove")
        .setDescription("Remove a track from the queue by its #position")
        .addIntegerOption((o) =>
          o.setName("position").setDescription("The #number shown by /music queue").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((s) => s.setName("clear").setDescription("Clear the queue but keep playing"))
    .addSubcommand((s) => s.setName("stop").setDescription("Stop playback, clear the queue and leave"))
    .toJSON();
}

/** Commands that need the invoker to be in a voice channel. */
const NEEDS_VOICE = new Set([
  "play",
  "pause",
  "resume",
  "skip",
  "volume",
  "loop",
  "shuffle",
  "remove",
  "clear",
  "stop",
]);

/** Every `/music` subcommand, for the prefix router's alias table. */
export const MUSIC_SUBCOMMANDS = [
  "play",
  "pause",
  "resume",
  "skip",
  "queue",
  "nowplaying",
  "volume",
  "loop",
  "shuffle",
  "remove",
  "clear",
  "stop",
] as const;

export class MusicCommands {
  constructor(private readonly manager: MusicManager) {}

  /**
   * Run one music subcommand. {@link SourceError} (bad link, unavailable
   * track, Spotify not configured) is answered as a human-readable reply —
   * anything else propagates to the caller's error handling.
   */
  async run(ctx: CommandContext, sub: string): Promise<void> {
    const guild = ctx.guild;
    const guildId = ctx.guildId;

    this.manager.setAnnouncementChannel(guildId, ctx.channelId);

    const memberChannel = (ctx.member.voice?.channel ?? null) as VoiceBasedChannel | null;

    if (NEEDS_VOICE.has(sub)) {
      if (!memberChannel) {
        await ctx.replyHidden("🔊 Join a voice channel first — I play where you are.");
        return;
      }
      const botChannelId = this.manager.connectedChannelId(guildId);
      if (botChannelId && botChannelId !== memberChannel.id) {
        const botChannel = guild.channels.cache.get(botChannelId);
        await ctx.replyHidden(
          `🔊 I'm playing in ${botChannel ? `**${botChannel.name}**` : "another voice channel"} — join me there.`,
        );
        return;
      }
      const me = guild.members.me;
      const perms = me ? memberChannel.permissionsFor(me) : null;
      if (!perms?.has("Connect") || !perms?.has("Speak")) {
        await ctx.replyHidden(`🔒 I need **Connect** and **Speak** permissions in **${memberChannel.name}**.`);
        return;
      }
    }

    try {
      await this.dispatch(ctx, sub, memberChannel);
    } catch (e) {
      // Resolver failures are user-facing (bad link, no Spotify credentials,
      // unavailable track): they become a plain reply, not an error log.
      if (e instanceof SourceError) {
        await ctx.reply(`⚠️ ${e.message}`);
        return;
      }
      throw e;
    }
  }

  private async dispatch(
    ctx: CommandContext,
    sub: string,
    memberChannel: VoiceBasedChannel | null,
  ): Promise<void> {
    const guild = ctx.guild;
    const guildId = ctx.guildId;
    switch (sub) {
      case "play":
        await this.play(ctx, memberChannel);
        return;
      case "pause": {
        const queueEmpty = this.manager.queue(guildId).nowPlaying() === null;
        if (queueEmpty || !this.manager.pause(guildId)) {
          await ctx.replyHidden("Nothing is playing right now.");
          return;
        }
        await ctx.reply(`⏸ **Paused.** \`${ctx.commandPrefix}resume\` to continue, \`${ctx.commandPrefix}skip\` to move on.`);
        return;
      }
      case "resume": {
        if (!this.manager.resume(guildId)) {
          await ctx.replyHidden(
            this.manager.isPlayingSomewhere(guildId)
              ? "I'm not paused."
              : `Nothing is playing — try \`${ctx.commandPrefix}play <song>\`.`,
          );
          return;
        }
        await ctx.reply("▶️ **Resumed.**");
        return;
      }
      case "skip":
        await this.skip(ctx);
        return;
      case "queue": {
        const snapshot = this.manager.queue(guildId).snapshot();
        if (!snapshot.current && snapshot.upcoming.length === 0) {
          await ctx.reply(`The queue is empty — add something with \`${ctx.commandPrefix}play <song>\`.`);
          return;
        }
        const page = this.readPage(ctx);
        await ctx.replyEmbeds([
          queueEmbed(
            { name: guild.name },
            snapshot,
            this.manager.positionMs(guildId),
            page,
            snapshot.loopMode,
            this.manager.getVolume(guildId),
          ),
        ]);
        return;
      }
      case "nowplaying": {
        const current = this.manager.queue(guildId).nowPlaying();
        if (!current) {
          await ctx.reply("Nothing is playing right now.");
          return;
        }
        await ctx.replyEmbeds([
          nowPlayingDetailed(
            current,
            this.manager.isPaused(guildId),
            this.manager.positionMs(guildId),
            this.manager.queue(guildId).loopMode,
            this.manager.getVolume(guildId),
            this.manager.skipStatus(guildId),
          ),
        ]);
        return;
      }
      case "volume": {
        const level = this.readVolume(ctx);
        if (level === null) {
          await ctx.reply(
            `🔊 Volume is **${this.manager.getVolume(guildId)}%** (set it with \`${ctx.commandPrefix}volume <0-150>\`).`,
          );
          return;
        }
        const parsed = parseVolume(level);
        if (parsed === null) {
          await ctx.replyHidden("Pick a number from 0 to 150.");
          return;
        }
        this.manager.setVolume(guildId, parsed);
        await ctx.reply(`🔊 Volume set to **${parsed}%**.`);
        return;
      }
      case "loop": {
        const queue = this.manager.queue(guildId);
        // Slash choices constrain the string; prefix arguments are validated here.
        const requested = this.readLoopMode(ctx);
        const mode = requested ?? queue.cycleLoop();
        queue.setLoop(mode);
        const icon = mode === "track" ? "🔂" : mode === "queue" ? "🔁" : "➡️";
        await ctx.reply(
          mode === "off"
            ? `${icon} Looping **off**.`
            : `${icon} Looping **${mode === "track" ? "this track" : "the whole queue"}**.`,
        );
        return;
      }
      case "shuffle": {
        const queue = this.manager.queue(guildId);
        if (queue.size < 2) {
          await ctx.reply("There's nothing to shuffle yet — queue a few tracks first.");
          return;
        }
        const n = queue.shuffle();
        await ctx.reply(`🔀 Shuffled **${n}** upcoming track${n === 1 ? "" : "s"}.`);
        return;
      }
      case "remove": {
        const position = this.readPosition(ctx);
        if (position === null) {
          await ctx.replyHidden(
            `❓ Which track? Give me the #position from \`${ctx.commandPrefix}queue\`, e.g. \`${ctx.commandPrefix}remove 3\`.`,
          );
          return;
        }
        const removed = this.manager.queue(guildId).remove(position);
        if (!removed) {
          await ctx.replyHidden(
            `There's no track at #${position} — check \`${ctx.commandPrefix}queue\` for positions.`,
          );
          return;
        }
        await ctx.reply(`🗑 Removed **${removed.title}** (was #${position}).`);
        return;
      }
      case "clear": {
        const n = this.manager.queue(guildId).clear();
        await ctx.reply(
          n === 0
            ? "The queue is already empty."
            : `🗑 Cleared **${n}** upcoming track${n === 1 ? "" : "s"} — the current song keeps playing.`,
        );
        return;
      }
      case "stop": {
        const wasActive = this.manager.isPlayingSomewhere(guildId);
        this.manager.teardown(guildId, false);
        await ctx.reply(
          wasActive ? "⏹ **Stopped.** Queue cleared — see you next time!" : "I wasn't playing anything, but fine — left the channel.",
        );
        return;
      }
      default:
        await ctx.replyHidden(
          `❓ I don't know that music command. Try \`${ctx.commandPrefix}help\` or \`/monarch help\` for the full list.`,
        );
    }
  }

  // ── subcommand flows ───────────────────────────────────────────────

  private async play(ctx: CommandContext, channel: VoiceBasedChannel | null): Promise<void> {
    if (!channel) {
      await ctx.replyHidden("🔊 Join a voice channel first — I play where you are.");
      return;
    }
    // Slash: the `query` option. Prefix: the whole rest of the message, so
    // `!play daft punk around the world` keeps the search phrase intact.
    const query = (ctx.getStringOption("query") ?? ctx.args.join(" ")).trim();
    if (query.length === 0) {
      await ctx.replyHidden(
        `❓ What should I play? \`${ctx.commandPrefix}play <link or search>\` — YouTube and Spotify links, playlists, albums or just a song name.`,
      );
      return;
    }
    const { maxQueue, maxPlaylistTracks } = musicLimits();

    await ctx.defer();

    const result = await resolveQuery(query, ctx.user.id, ctx.user.displayName ?? ctx.user.username, maxPlaylistTracks);

    await this.manager.connect(ctx.guildId, channel);

    const queue = this.manager.queue(ctx.guildId);
    const wasIdle = queue.nowPlaying() === null;
    const { added, dropped } = await this.manager.enqueue(ctx.guildId, result.tracks);

    const position = queue.size - added + 1; // 1-based position of the first added track
    const first = result.tracks[0];

    if (added === 0) {
      await ctx.edit("❌ Nothing was added — the queue is full or the link contains no tracks.");
      return;
    }

    if (!first) {
      await ctx.edit("❌ Nothing from that link could be queued.");
      return;
    }

    const startingNow = wasIdle;
    if (result.tracks.length === 1) {
      await ctx.edit(
        `🎶 Added **[${first.title}](${first.url})** by ${first.author} \`${formatDuration(first.durationMs)}\`` +
          (startingNow ? " — **preparing playback**." : ` — position **#${queue.size}** in the queue.`),
      );
    } else {
      const capped = result.skipped;
      const summary =
        `📚 Added **${added}** track${added === 1 ? "" : "s"} from **${result.origin}**` +
        (dropped + capped > 0 ? ` (${dropped + capped} left out — queue/playlist limit is ${maxQueue}/${maxPlaylistTracks})` : "") +
        (startingNow ? " — **starting now**." : ` — starting at position **#${position}**.`);
      await ctx.edit(summary);
    }

    if (this.manager.isPaused(ctx.guildId)) this.manager.resume(ctx.guildId);
    await this.manager.startIfIdle(ctx.guildId);
  }

  private async skip(ctx: CommandContext): Promise<void> {
    const guildId = ctx.guildId;
    const current = this.manager.queue(guildId).nowPlaying();

    if (!current) {
      await ctx.reply(`There's nothing to skip — play something with \`${ctx.commandPrefix}play <song>\`.`);
      return;
    }

    // 1) DJ / staff / requester → instant skip, no vote.
    const force = this.manager.canForceSkip(ctx.member as GuildMember, current);
    if (force.allowed) {
      const label = FORCE_SKIP_LABEL[force.reason ?? "staff"];
      this.manager.skip(guildId);
      await ctx.reply(
        `⏭ **${current.title}** skipped by ${label === "the requester" ? "you (it's your song)" : `**${label}** ${ctx.user.displayName}`} — no vote needed.`,
      );
      return;
    }

    // 2) Everyone else votes. A majority of current listeners passes it.
    const election = this.manager.castSkipVote(guildId, ctx.user.id);

    if (election.status === "already") {
      await ctx.reply(
        `🗳 You already voted to skip **${current.title}** — ${election.voters.length}/${election.required} so far.`,
      );
      return;
    }

    if (election.status === "passed-by-this-vote") {
      this.manager.skip(guildId);
      await ctx.reply(
        `🗳️ Vote passed (${election.voters.length}/${election.required}) — skipping **${current.title}**.`,
      );
      return;
    }

    await ctx.reply(
      `🗳 Vote counted — **${election.voters.length}/${election.required}** to skip **${current.title}**.\n` +
        `A majority of everyone listening passes it. Have a **DJ** or **Moderator/Staff** role? You can skip instantly.`,
    );
  }

  // ── argument readers (slash options ⇄ prefix words) ────────────────

  private readPage(ctx: CommandContext): number {
    return clampInt(ctx.getIntegerOption("page") ?? firstInt(ctx.args), 1, 50) ?? 1;
  }

  private readVolume(ctx: CommandContext): number | null {
    return ctx.getIntegerOption("level") ?? firstInt(ctx.args);
  }

  private readPosition(ctx: CommandContext): number | null {
    const value = ctx.getIntegerOption("position") ?? firstInt(ctx.args);
    return value === null ? null : Math.max(1, Math.trunc(value));
  }

  private readLoopMode(ctx: CommandContext): LoopMode | null {
    const raw = (ctx.getStringOption("mode") ?? ctx.args[0] ?? "").trim().toLowerCase();
    if (raw === "off" || raw === "none" || raw === "no") return "off";
    if (raw === "track" || raw === "song" || raw === "one" || raw === "this") return "track";
    if (raw === "queue" || raw === "all" || raw === "list") return "queue";
    return null;
  }
}

/** First whole number in the argument list (prefix surface). */
function firstInt(args: readonly string[]): number | null {
  for (const arg of args) {
    if (/^-?\d+$/.test(arg.trim())) return Number.parseInt(arg.trim(), 10);
  }
  return null;
}

function clampInt(value: number | null, min: number, max: number): number | null {
  if (value === null || Number.isNaN(value)) return null;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Re-exported so callers can present resolver failures as human-readable replies. */
export { SourceError };

export function spotifyStatusLine(): string {
  return spotifyConfigured()
    ? "Spotify links: enabled"
    : "Spotify links: not configured (set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET)";
}

export const MUSIC_EMBED_COLOR = MUSIC_COLOR;
