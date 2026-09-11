import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type VoiceBasedChannel,
} from "discord.js";
import { formatDuration, parseVolume, type LoopMode } from "@monarch/music";
import { FORCE_SKIP_LABEL } from "@monarch/music";
import type { MusicManager } from "./player.js";
import { queueEmbed, nowPlayingDetailed } from "./player.js";
import {
  SourceError,
  musicLimits,
  resolveQuery,
  spotifyConfigured,
} from "./sources.js";

/**
 * `/music` — playback controls. The heavy lifting lives in MusicManager
 * (voice) and @monarch/music (queue rules, votes); this file is the Discord
 * surface: checks, replies and embeds.
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

const replyEphemeral = (interaction: ChatInputCommandInteraction, content: string) =>
  interaction.deferred || interaction.replied
    ? interaction.editReply({ content })
    : interaction.reply({ content, flags: MessageFlags.Ephemeral });

export async function handleMusicCommand(
  interaction: ChatInputCommandInteraction,
  manager: MusicManager,
): Promise<void> {
  if (!interaction.inCachedGuild() || !interaction.guild) {
    await replyEphemeral(interaction, "Run music commands inside a server.");
    return;
  }
  const guild = interaction.guild;
  const guildId = guild.id;
  const sub = interaction.options.getSubcommand(true);

  manager.setAnnouncementChannel(guildId, interaction.channelId);

  const member = interaction.member as GuildMember;
  const memberChannel = member.voice.channel as VoiceBasedChannel | null;

  if (NEEDS_VOICE.has(sub)) {
    if (!memberChannel) {
      await replyEphemeral(interaction, "🔊 Join a voice channel first — I play where you are.");
      return;
    }
    const botChannelId = manager.connectedChannelId(guildId);
    if (botChannelId && botChannelId !== memberChannel.id) {
      const botChannel = guild.channels.cache.get(botChannelId);
      await replyEphemeral(
        interaction,
        `🔊 I'm playing in ${botChannel ? `**${botChannel.name}**` : "another voice channel"} — join me there.`,
      );
      return;
    }
    const me = guild.members.me;
    const perms = me ? memberChannel.permissionsFor(me) : null;
    if (!perms?.has("Connect") || !perms?.has("Speak")) {
      await replyEphemeral(
        interaction,
        `🔒 I need **Connect** and **Speak** permissions in **${memberChannel.name}**.`,
      );
      return;
    }
  }

  try {
    switch (sub) {
      case "play":
        await handlePlay(interaction, manager, memberChannel);
        return;
      case "pause": {
        const queueEmpty = manager.queue(guildId).nowPlaying() === null;
        if (queueEmpty || !manager.pause(guildId)) {
          await replyEphemeral(interaction, "Nothing is playing right now.");
          return;
        }
        await interaction.reply("⏸ **Paused.** `/music resume` to continue, `/music skip` to move on.");
        return;
      }
      case "resume": {
        if (!manager.resume(guildId)) {
          await replyEphemeral(interaction, manager.isPlayingSomewhere(guildId) ? "I'm not paused." : "Nothing is playing — try `/music play`.");
          return;
        }
        await interaction.reply("▶️ **Resumed.**");
        return;
      }
      case "skip":
        await handleSkip(interaction, manager);
        return;
      case "queue": {
        const snapshot = manager.queue(guildId).snapshot();
        if (!snapshot.current && snapshot.upcoming.length === 0) {
          await interaction.reply("The queue is empty — add something with `/music play`.");
          return;
        }
        const page = interaction.options.getInteger("page") ?? 1;
        await interaction.reply({
          embeds: [
            queueEmbed(
              { name: guild.name },
              snapshot,
              manager.positionMs(guildId),
              page,
              snapshot.loopMode,
              manager.getVolume(guildId),
            ),
          ],
        });
        return;
      }
      case "nowplaying": {
        const current = manager.queue(guildId).nowPlaying();
        if (!current) {
          await interaction.reply("Nothing is playing right now.");
          return;
        }
        await interaction.reply({
          embeds: [
            nowPlayingDetailed(
              current,
              manager.isPaused(guildId),
              manager.positionMs(guildId),
              manager.queue(guildId).loopMode,
              manager.getVolume(guildId),
              manager.skipStatus(guildId),
            ),
          ],
        });
        return;
      }
      case "volume": {
        const level = interaction.options.getInteger("level");
        if (level === null) {
          await interaction.reply(`🔊 Volume is **${manager.getVolume(guildId)}%** (set it with \`/music volume <0-150>\`).`);
          return;
        }
        const parsed = parseVolume(level);
        if (parsed === null) {
          await replyEphemeral(interaction, "Pick a number from 0 to 150.");
          return;
        }
        manager.setVolume(guildId, parsed);
        await interaction.reply(`🔊 Volume set to **${parsed}%**.`);
        return;
      }
      case "loop": {
        const queue = manager.queue(guildId);
        // Choices constrain the string to off/track/queue.
        const requested = interaction.options.getString("mode") as LoopMode | null;
        const mode = requested ?? queue.cycleLoop();
        queue.setLoop(mode);
        const icon = mode === "track" ? "🔂" : mode === "queue" ? "🔁" : "➡️";
        await interaction.reply(
          mode === "off" ? `${icon} Looping **off**.` : `${icon} Looping **${mode === "track" ? "this track" : "the whole queue"}**.`,
        );
        return;
      }
      case "shuffle": {
        const queue = manager.queue(guildId);
        if (queue.size < 2) {
          await interaction.reply("There's nothing to shuffle yet — queue a few tracks first.");
          return;
        }
        const n = queue.shuffle();
        await interaction.reply(`🔀 Shuffled **${n}** upcoming track${n === 1 ? "" : "s"}.`);
        return;
      }
      case "remove": {
        const position = interaction.options.getInteger("position", true);
        const removed = manager.queue(guildId).remove(position);
        if (!removed) {
          await replyEphemeral(interaction, `There's no track at #${position} — check \`/music queue\` for positions.`);
          return;
        }
        await interaction.reply(`🗑 Removed **${removed.title}** (was #${position}).`);
        return;
      }
      case "clear": {
        const n = manager.queue(guildId).clear();
        await interaction.reply(
          n === 0 ? "The queue is already empty." : `🗑 Cleared **${n}** upcoming track${n === 1 ? "" : "s"} — the current song keeps playing.`,
        );
        return;
      }
      case "stop": {
        const wasActive = manager.isPlayingSomewhere(guildId);
        manager.teardown(guildId, false);
        await interaction.reply(wasActive ? "⏹ **Stopped.** Queue cleared — see you next time!" : "I wasn't playing anything, but fine — left the channel.");
        return;
      }
      default:
        await replyEphemeral(interaction, "Try `/monarch help` for the full command list.");
    }
  } catch (e) {
    if (e instanceof SourceError) {
      await replyEphemeral(interaction, `⚠️ ${e.message}`);
      return;
    }
    throw e;
  }
}

// ── subcommand flows ─────────────────────────────────────────────────

async function handlePlay(
  interaction: ChatInputCommandInteraction<"cached">,
  manager: MusicManager,
  channel: VoiceBasedChannel | null,
): Promise<void> {
  if (!channel) {
    await replyEphemeral(interaction, "🔊 Join a voice channel first — I play where you are.");
    return;
  }
  const query = interaction.options.getString("query", true).trim();
  const { maxQueue, maxPlaylistTracks } = musicLimits();

  await interaction.deferReply();

  const result = await resolveQuery(query, interaction.user.id, interaction.user.displayName, maxPlaylistTracks);

  await manager.connect(interaction.guildId, channel);

  const queue = manager.queue(interaction.guildId);
  const wasIdle = queue.nowPlaying() === null;
  const { added, dropped } = await manager.enqueue(interaction.guildId, result.tracks);

  const position = queue.size - added + 1; // 1-based position of the first added track
  const first = result.tracks[0];

  if (added === 0) {
    await interaction.editReply("❌ Nothing was added — the queue is full or the link contains no tracks.");
    return;
  }

  if (!first) {
    await interaction.editReply("❌ Nothing from that link could be queued.");
    return;
  }

  const startingNow = wasIdle;
  if (result.tracks.length === 1) {
    await interaction.editReply(
      `🎶 Added **[${first.title}](${first.url})** by ${first.author} \`${formatDuration(first.durationMs)}\`` +
        (startingNow ? " — **preparing playback**." : ` — position **#${queue.size}** in the queue.`),
    );
  } else {
    const capped = result.skipped;
    const summary =
      `📚 Added **${added}** track${added === 1 ? "" : "s"} from **${result.origin}**` +
      (dropped + capped > 0 ? ` (${dropped + capped} left out — queue/playlist limit is ${maxQueue}/${maxPlaylistTracks})` : "") +
      (startingNow ? " — **starting now**." : ` — starting at position **#${position}**.`);
    await interaction.editReply(summary);
  }

  if (manager.isPaused(interaction.guildId)) manager.resume(interaction.guildId);
  await manager.startIfIdle(interaction.guildId);
}

async function handleSkip(interaction: ChatInputCommandInteraction<"cached">, manager: MusicManager): Promise<void> {
  const guildId = interaction.guildId;
  const current = manager.queue(guildId).nowPlaying();

  if (!current || manager.isPaused(guildId) === undefined) {
    // (isPaused undefined never happens; kept simple)
  }
  if (!current) {
    await interaction.reply("There's nothing to skip — play something with `/music play`.");
    return;
  }

  // 1) DJ / staff / requester → instant skip, no vote.
  const force = manager.canForceSkip(interaction.member as GuildMember, current);
  if (force.allowed) {
    const label = FORCE_SKIP_LABEL[force.reason ?? "staff"];
    manager.skip(guildId);
    await interaction.reply(
      `⏭ **${current.title}** skipped by ${label === "the requester" ? "you (it's your song)" : `**${label}** ${interaction.user.displayName}`} — no vote needed.`,
    );
    return;
  }

  // 2) Everyone else votes. A majority of current listeners passes it.
  const election = manager.castSkipVote(guildId, interaction.user.id);

  if (election.status === "already") {
    await interaction.reply(
      `🗳 You already voted to skip **${current.title}** — ${election.voters.length}/${election.required} so far.`,
    );
    return;
  }

  if (election.status === "passed-by-this-vote") {
    manager.skip(guildId);
    await interaction.reply(
      `🗳️ Vote passed (${election.voters.length}/${election.required}) — skipping **${current.title}**.`,
    );
    return;
  }

  await interaction.reply(
    `🗳 Vote counted — **${election.voters.length}/${election.required}** to skip **${current.title}**.\n` +
      `A majority of everyone listening passes it. Have a **DJ** or **Moderator/Staff** role? You can skip instantly.`,
  );
}

export function spotifyStatusLine(): string {
  return spotifyConfigured()
    ? "Spotify links: enabled"
    : "Spotify links: not configured (set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET)";
}

export const MUSIC_EMBED_COLOR = MUSIC_COLOR;