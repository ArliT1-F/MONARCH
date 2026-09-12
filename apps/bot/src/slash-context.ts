import {
  AttachmentBuilder,
  MessageFlags,
  type APIEmbed,
  type PermissionsBitField,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type User,
} from "discord.js";
import {
  allowedMentionsFor,
  hasAnyPermission,
  type CommandContext,
  type CommandFile,
  type ReplyOptions,
} from "./context.js";

/**
 * Slash-command surface: adapts a `ChatInputCommandInteraction` to the
 * surface-neutral {@link CommandContext} every Monarch handler is written
 * against (see ./context.ts for why).
 *
 * Behaviour notes:
 * - `replyHidden` uses Discord's ephemeral flag, so the answer is only
 *   visible to whoever ran the command;
 * - once `defer()` has been called, `reply`/`edit`/`attach` all go through
 *   `editReply` — Discord rejects a second `reply` on a deferred interaction;
 * - prefix commands are resolved from the interaction's own text channel,
 *   which only matters for wording ("try `!play`").
 */
export class SlashCommandContext implements CommandContext {
  readonly surface = "slash" as const;
  readonly guildId: string;
  readonly guild: Guild;
  readonly member: GuildMember;
  readonly user: User;
  readonly channelId: string;
  /** Slash commands have typed options — there is no free-form argument list. */
  readonly args: string[] = [];

  private deferred = false;
  private responded = false;

  constructor(
    private readonly interaction: ChatInputCommandInteraction<"cached">,
    readonly commandPrefix: string,
  ) {
    this.guildId = interaction.guildId;
    this.guild = interaction.guild;
    this.member = interaction.member;
    this.user = interaction.user;
    this.channelId = interaction.channelId;
  }

  get answered(): boolean {
    return this.responded || this.interaction.replied || this.interaction.deferred;
  }

  /**
   * discord.js types `flags` on an interaction reply as the *narrow* set of
   * reply-capable flags, so the ephemeral bit is passed explicitly rather
   * than as a widened MessageFlags value.
   */
  private replyFlags(options?: ReplyOptions): { flags?: typeof MessageFlags.Ephemeral } {
    return options?.hidden ? { flags: MessageFlags.Ephemeral } : {};
  }

  async reply(content: string, options?: ReplyOptions): Promise<unknown> {
    return this.send({ content, embeds: options?.embeds }, options);
  }

  async replyHidden(content: string, options?: ReplyOptions): Promise<unknown> {
    return this.send({ content, embeds: options?.embeds }, { ...options, hidden: true });
  }

  async replyEmbeds(embeds: APIEmbed[], options?: ReplyOptions): Promise<unknown> {
    return this.send({ embeds }, options);
  }

  async defer(options?: { hidden?: boolean }): Promise<unknown> {
    if (this.deferred || this.interaction.deferred || this.interaction.replied) return;
    this.deferred = true;
    this.responded = true;
    const flags = options?.hidden ? MessageFlags.Ephemeral : undefined;
    await this.interaction.deferReply(flags ? { flags } : {});
  }

  async edit(content: string, options?: ReplyOptions): Promise<unknown> {
    return this.send({ content, embeds: options?.embeds }, options);
  }

  async attach(content: string, files: CommandFile[]): Promise<unknown> {
    const attachments = files.map(
      (file) => new AttachmentBuilder(Buffer.from(file.body, "utf8"), { name: file.name }),
    );
    if (this.deferred || this.interaction.deferred || this.interaction.replied) {
      this.responded = true;
      return this.interaction.editReply({ content, files: attachments });
    }
    this.responded = true;
    return this.interaction.reply({ content, files: attachments, flags: MessageFlags.Ephemeral });
  }

  getStringOption(name: string): string | null {
    return this.interaction.options.getString(name);
  }

  getIntegerOption(name: string): number | null {
    return this.interaction.options.getInteger(name);
  }

  getUserOption(name: string): User | null {
    return this.interaction.options.getUser(name);
  }

  getMemberOption(name: string): GuildMember | null {
    return (this.interaction.options.getMember(name) as GuildMember | null) ?? null;
  }

  getChannelOption(name: string): { id: string } | null {
    const channel = this.interaction.options.getChannel(name);
    return channel ? { id: channel.id } : null;
  }

  /** Options are typed on the slash surface — free-form lookup isn't a thing. */
  async resolveMember(): Promise<GuildMember | null> {
    return null;
  }

  memberHasAny(bits: readonly bigint[]): boolean {
    return hasAnyPermission(this.interaction.memberPermissions, bits);
  }

  myPermissions(): PermissionsBitField | null {
    return this.guild.members.me?.permissions ?? null;
  }

  private async send(
    payload: { content?: string; embeds?: APIEmbed[] },
    options?: ReplyOptions,
  ): Promise<unknown> {
    this.responded = true;
    if (this.deferred || this.interaction.deferred || this.interaction.replied) {
      return this.interaction.editReply({
        content: payload.content,
        embeds: payload.embeds,
        ...(options?.mentions ? { allowedMentions: allowedMentionsFor(options) } : {}),
      });
    }
    return this.interaction.reply({
      content: payload.content,
      embeds: payload.embeds,
      ...this.replyFlags(options),
      ...(options?.mentions ? { allowedMentions: allowedMentionsFor(options) } : {}),
    });
  }
}
