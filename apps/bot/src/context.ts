import { PermissionsBitField, type APIEmbed, type Guild, type GuildMember, type MessageMentionOptions, type User } from "discord.js";

/**
 * CommandContext — the one view of "who ran this command, where, and how do I
 * answer them" that every Monarch command handler is written against.
 *
 * Two surfaces feed it:
 *
 * - **slash** (`SlashCommandContext` in ./slash-context.ts) — options come
 *   from the interaction, replies can be ephemeral, long work is deferred
 *   with Discord's "thinking" state;
 * - **prefix** (`PrefixCommand` in ./prefix/context.ts) — options come from
 *   the message text, there is no ephemeral flag (everybody can see a text
 *   command), and deferring posts a placeholder message that gets edited.
 *
 * Keeping the handlers surface-neutral is what makes `!play`, `!burg` and
 * `/music play`, `/burg` run the *same* code: one set of permission
 * checks, one set of replies, no drift between the two ways of typing a
 * command. Anything a handler needs that isn't here belongs in the surface
 * adapter, not in the handler.
 */
export interface CommandContext {
  /** Which surface the command came in through — only used for wording. */
  readonly surface: "slash" | "prefix";
  readonly guildId: string;
  readonly guild: Guild;
  /** Who ran it (a GuildMember in a cached guild). */
  readonly member: GuildMember;
  readonly user: User;
  readonly channelId: string;
  /** Text channel commands were typed in, so replies can mention the prefix. */
  readonly commandPrefix: string;
  /** True once anything has been sent or edited for this invocation. */
  readonly answered: boolean;

  /**
   * Send the answer. `hidden` maps to an ephemeral interaction reply on the
   * slash surface; on the prefix surface it is a normal reply (there is no
   * such thing as a text-message whisper) — handlers can rely on it meaning
   * "this is for the invoker only" without caring how.
   *
   * After a {@link defer}, the first reply/edit fills the placeholder.
   */
  reply(content: string, options?: ReplyOptions): Promise<unknown>;
  /** Same as {@link reply} but explicitly for the invoker only. */
  replyHidden(content: string, options?: ReplyOptions): Promise<unknown>;
  replyEmbeds(embeds: APIEmbed[], options?: ReplyOptions): Promise<unknown>;
  /**
   * Announce that work started (interaction `deferReply` / a placeholder
   * message). Optional: surfaces that already answered can ignore it.
   */
  defer(options?: { hidden?: boolean }): Promise<unknown>;
  /** Replace the deferred/last message. */
  edit(content: string, options?: ReplyOptions): Promise<unknown>;
  /**
   * Answer with a file attached (`/monarch export` posts the template JSON).
   * Always follows a {@link defer}.
   */
  attach(content: string, files: CommandFile[]): Promise<unknown>;

  /**
   * Free-form arguments left over after the command words — empty on the
   * slash surface (where every option is typed), the tokenized rest of the
   * message on the prefix surface. Mention arguments arrive as snowflakes
   * and `"quoted spans"` stay in one piece.
   */
  readonly args: string[];

  /**
   * The second-level subcommand of a subcommand-group command — e.g.
   * `setup` in `/monarch confession setup`. Flat subcommands have none
   * (null). The slash surface reads it from the interaction; the prefix
   * surface carries it as the first argument word (the verb after the
   * command words, e.g. `!confession setup`).
   */
  getSubcommand(): string | null;

  /** Slash options / prefix arguments, all optional by nature. */
  getStringOption(name: string): string | null;
  getIntegerOption(name: string): number | null;
  getUserOption(name: string): User | null;
  getMemberOption(name: string): GuildMember | null;
  /**
   * A channel option by name. On the prefix surface the name picks a position
   * in the message's channel arguments (first = the command's first channel
   * option, second = its second), so `!monarch confession setup #a #b` reads
   * channel=#a and logs=#b — never the same mention twice.
   */
  getChannelOption(name: string): { id: string } | null;
  /**
   * Resolve a member by snowflake (prefix surface: mentions are rewritten to
   * ids during tokenizing). Returns null on the slash surface — use
   * {@link getMemberOption} there.
   */
  resolveMember(userId: string): Promise<GuildMember | null>;

  /** True when the invoking member holds at least one of these bits. */
  memberHasAny(bits: readonly bigint[]): boolean;
  /**
   * Monarch's own guild-level permissions (null when unreadable right now —
   * never treat that as "missing"). Channel-level checks belong to the
   * surface adapter, which already knows it can speak where it was invoked.
   */
  myPermissions(): PermissionsBitField | null;
}

/** A file to attach to a reply — the surface turns it into an AttachmentBuilder. */
export interface CommandFile {
  name: string;
  /** Serialized body; handlers build JSON/text, never raw Discord payloads. */
  body: string;
}

export interface ReplyOptions {
  embeds?: APIEmbed[];
  /** Let the reply ping users/roles. Off by default: replies never mass-mention. */
  mentions?: boolean;
  hidden?: boolean;
}

/**
 * The smallest "can I reply at all" view of a Discord text channel. Kept
 * structural so tests can hand the prefix router a stub instead of a real
 * gateway object.
 */
export interface SendableChannel {
  send(payload: {
    content?: string;
    embeds?: APIEmbed[];
    allowedMentions?: { parse?: string[]; users?: string[] };
  }): Promise<{ id: string; edit(payload: { content?: string; embeds?: APIEmbed[] }): Promise<unknown> }>;
}

/**
 * Does this member hold any of these permission bits?
 *
 * Both surfaces must agree, including Discord's "Administrator implies
 * everything" shortcut — which `PermissionsBitField.has()` implements and a
 * raw bitwise AND does not. Handlers therefore read the same answer whether
 * the command arrived as `/burg` or `!burg`.
 */
export function hasAnyPermission(
  permissions: PermissionsBitField | bigint | null | undefined,
  bits: readonly bigint[],
): boolean {
  if (permissions === null || permissions === undefined) return false;
  const field = typeof permissions === "bigint" ? new PermissionsBitField(permissions) : permissions;
  return bits.some((bit) => field.has(bit));
}

/**
 * Reply policy for mentions. Discord mentions nobody by default when a
 * message is sent by a bot *replying to an interaction*, but a plain channel
 * send would ping whoever is in the text — so the prefix surface always sends
 * an explicit policy, and both surfaces only allow user pings when the
 * handler asks for them.
 */
export function allowedMentionsFor(options?: ReplyOptions): MessageMentionOptions {
  return options?.mentions ? { parse: ["users"] } : { parse: [] };
}
