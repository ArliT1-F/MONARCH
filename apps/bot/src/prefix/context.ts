import {
  AttachmentBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  type APIEmbed,
  type Guild,
  type GuildMember,
  type Message,
  type User,
} from "discord.js";
import {
  allowedMentionsFor,
  hasAnyPermission,
  type CommandContext,
  type CommandFile,
  type ReplyOptions,
} from "../context.js";
import { canonicalSubcommand, type PrefixInvocation } from "./parse.js";

/**
 * Prefix-command surface: adapts a Discord {@link Message} to the same
 * {@link CommandContext} the slash surface implements, so `!burg @user` and
 * `/burg @user` run one and the same handler.
 *
 * Differences from slash, all absorbed here rather than in the handlers:
 *
 * - **no ephemeral replies** — a text command is public, so `replyHidden`
 *   answers in the channel like everything else;
 * - **defer = a placeholder message** that later replies edit, instead of
 *   Discord's "thinking" state;
 * - **arguments are words** — the tokenized rest of the message is exposed as
 *   `args`, and typed options (`getStringOption("query")`) read from it;
 * - **options are positional** — a command with two channel options reads them
 *   in the order they were typed, per {@link CHANNEL_OPTION_ORDER};
 * - the bot needs **Send Messages** where it was invoked; the dispatcher
 *   checks that before constructing this.
 */

/** Option names that mean "the whole rest of the message" (e.g. `!play <query>`). */
const FREEFORM_OPTIONS = new Set(["query", "name", "raw"]);

/**
 * Channel options in the order they're typed, for the commands that have more
 * than one — keyed by the command's own word (alias-resolved, so `!confession
 * setup` and `!monarch confession setup` agree).
 *
 * `!monarch confession setup #confessions #confess-logs` means channel =
 * #confessions and logs = #confess-logs. Answering *both* options with the
 * first mention — what "the first channel mentioned" alone can do — reads as
 * "the log channel is the confession channel" and refuses a setup where the
 * two channels are perfectly different.
 *
 * Commands missing here have at most one channel option (`!monarch test …
 * #channel`), where the first mention is the whole answer.
 */
const CHANNEL_OPTION_ORDER: Readonly<Record<string, readonly string[]>> = {
  confession: ["channel", "logs"],
  test: ["channel"],
};

/** A bare snowflake argument (`parseArgs` already reduced mentions to ids). */
const SNOWFLAKE = /^\d{15,25}$/;

/** User and role mentions — ids that are *not* channel arguments. */
const NOT_A_CHANNEL = /<@!?(\d{15,25})>|<@&(\d{15,25})>/g;

export class PrefixCommandContext implements CommandContext {
  readonly surface = "prefix" as const;
  readonly guildId: string;
  readonly guild: Guild;
  readonly member: GuildMember;
  readonly user: User;
  readonly channelId: string;
  readonly args: string[];
  /**
   * The command's own word, alias resolved — `confession` for both
   * `!monarch confession setup` and `!confession setup`. Decides which
   * positional options the command has.
   */
  private readonly commandWord: string | null;

  private sent: { edit(payload: { content?: string; embeds?: APIEmbed[] }): Promise<unknown> } | null = null;
  private responded = false;

  constructor(
    private readonly message: Message<true>,
    /** How the command was addressed — kept for logs and future wording. */
    readonly invocation: PrefixInvocation,
    readonly commandPrefix: string,
    args: string[],
  ) {
    this.guildId = message.guildId;
    this.guild = message.guild;
    // A guild message always carries its member; the dispatcher refuses
    // partial messages before we get here.
    this.member = message.member!;
    this.user = message.author;
    this.channelId = message.channelId;
    this.args = args;
    this.commandWord = canonicalSubcommand(invocation.tokens);
  }

  get answered(): boolean {
    return this.responded;
  }

  /** The channel the command was typed in (threads included). */
  private get channel(): Message<true>["channel"] {
    return this.message.channel;
  }

  async reply(content: string, options?: ReplyOptions): Promise<unknown> {
    return this.send({ content, embeds: options?.embeds }, options);
  }

  async replyHidden(content: string, options?: ReplyOptions): Promise<unknown> {
    // Text commands are public; "hidden" only means "this is for the invoker".
    return this.send({ content, embeds: options?.embeds }, options);
  }

  async replyEmbeds(embeds: APIEmbed[], options?: ReplyOptions): Promise<unknown> {
    return this.send({ embeds }, options);
  }

  async defer(): Promise<unknown> {
    if (this.responded) return;
    this.responded = true;
    try {
      this.sent = await this.channel.send({ content: "⏳ Working on it…" });
    } catch {
      // No placeholder is not fatal: the next reply posts a fresh message.
      this.sent = null;
    }
  }

  async edit(content: string, options?: ReplyOptions): Promise<unknown> {
    return this.send({ content, embeds: options?.embeds }, options);
  }

  async attach(content: string, files: CommandFile[]): Promise<unknown> {
    this.responded = true;
    return this.channel.send({
      content,
      files: files.map((file) => new AttachmentBuilder(Buffer.from(file.body, "utf8"), { name: file.name })),
      allowedMentions: allowedMentionsFor(),
    });
  }

  getSubcommand(): string | null {
    // On the prefix surface the group's leaf is the first argument word
    // (e.g. `setup` in `!confession setup` / `!monarch confession setup`).
    return this.args[0]?.toLowerCase() ?? null;
  }

  getStringOption(name: string): string | null {
    if (FREEFORM_OPTIONS.has(name)) {
      return this.args.length > 0 ? this.args.join(" ") : null;
    }
    // Everything else is positional: `!test embed publish`, `!loop track`.
    return this.args[0] ?? null;
  }

  getIntegerOption(name: string): number | null {
    const raw = this.args.find((arg) => /^-?\d+$/.test(arg.trim()));
    return raw === undefined ? null : Number.parseInt(raw.trim(), 10);
  }

  getUserOption(): User | null {
    return this.message.mentions.users.first() ?? null;
  }

  getMemberOption(): GuildMember | null {
    return this.message.mentions.members?.first() ?? null;
  }

  /**
   * A channel option by name, resolved positionally from the message text:
   * the Nth channel argument answers the Nth option in
   * {@link CHANNEL_OPTION_ORDER} (and the first one answers every command
   * that only has a single channel option).
   *
   * Deliberately *not* `message.mentions.channels`: discord.js fills that
   * collection only with channels already in its cache, so one uncached
   * mention would silently shift every option after it. The text is the
   * ground truth for what the person typed, in the order they typed it.
   */
  getChannelOption(name: string): { id: string } | null {
    const ids = this.channelIds();
    const index = CHANNEL_OPTION_ORDER[this.commandWord ?? ""]?.indexOf(name) ?? -1;
    const id = index >= 0 ? ids[index] : ids[0];
    return id === undefined ? null : { id };
  }

  /**
   * Channel arguments in the order typed: `<#id>` mentions (already reduced to
   * snowflakes by the tokenizer) plus bare snowflakes, since people paste
   * channel ids and links too. User and role mentions are excluded — they
   * arrive as snowflakes as well, and are never a channel.
   */
  private channelIds(): string[] {
    const notChannels = new Set<string>();
    for (const match of (this.message.content ?? "").matchAll(NOT_A_CHANNEL)) {
      notChannels.add(match[1] ?? match[2] ?? "");
    }
    return this.args.filter((arg) => SNOWFLAKE.test(arg) && !notChannels.has(arg));
  }

  async resolveMember(userId: string): Promise<GuildMember | null> {
    if (!/^\d{15,25}$/.test(userId)) return null;
    const cached = this.message.mentions.members?.get(userId) ?? this.guild.members.cache.get(userId);
    if (cached) return cached;
    try {
      return await this.guild.members.fetch(userId);
    } catch {
      return null; // not in this server (or the gateway hiccuped)
    }
  }

  memberHasAny(bits: readonly bigint[]): boolean {
    return hasAnyPermission(this.member.permissions, bits);
  }

  myPermissions(): PermissionsBitField | null {
    const perms = this.guild.members.me?.permissions;
    if (!perms) return null;
    return typeof perms === "bigint" ? new PermissionsBitField(perms) : perms;
  }

  private async send(
    payload: { content?: string; embeds?: APIEmbed[] },
    options?: ReplyOptions,
  ): Promise<unknown> {
    this.responded = true;
    // A deferred placeholder gets filled instead of doubling up messages.
    if (this.sent) {
      const message = this.sent;
      this.sent = null;
      try {
        return await message.edit({ content: payload.content, embeds: payload.embeds });
      } catch {
        // The placeholder vanished (deleted, permissions) — fall through and post.
      }
    }
    return this.channel.send({
      content: payload.content,
      embeds: payload.embeds,
      // Always explicit: unlike an interaction reply, a channel send would
      // otherwise ping whoever the text mentions (@everyone included).
      allowedMentions: allowedMentionsFor(options),
    });
  }
}

/** Can Monarch answer at all in the channel this message came from? */
export function canReplyIn(message: Message<true>): boolean {
  const me = message.guild.members.me;
  if (!me) return false;
  const perms = message.channel.permissionsFor(me);
  return Boolean(perms?.has(PermissionFlagsBits.SendMessages) && perms?.has(PermissionFlagsBits.ViewChannel));
}
