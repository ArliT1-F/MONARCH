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
import type { PrefixInvocation } from "./parse.js";

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
 * - the bot needs **Send Messages** where it was invoked; the dispatcher
 *   checks that before constructing this.
 */

/** Option names that mean "the whole rest of the message" (e.g. `!play <query>`). */
const FREEFORM_OPTIONS = new Set(["query", "name", "raw"]);

export class PrefixCommandContext implements CommandContext {
  readonly surface = "prefix" as const;
  readonly guildId: string;
  readonly guild: Guild;
  readonly member: GuildMember;
  readonly user: User;
  readonly channelId: string;
  readonly args: string[];

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

  getChannelOption(): { id: string } | null {
    const channel = this.message.mentions.channels.first();
    return channel ? { id: channel.id } : null;
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
