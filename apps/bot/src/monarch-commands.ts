import { PermissionFlagsBits, type GuildMember } from "discord.js";
import {
  COMMAND_PREFIX_CHARS,
  DEFAULT_COMMAND_PREFIX,
  MAX_COMMAND_PREFIX_LENGTH,
  buildBotInviteUrl,
  invitePermissionNames,
} from "@monarch/shared";
import { BURG_PERMISSIONS, DESIGN_PERMISSIONS, JAIL_PERMISSIONS, renderHelpEmbeds } from "./commands.js";
import type { BurgRegistry, BurgStyle } from "./burg.js";
import { toBurg } from "./burg.js";
import type { CommandContext } from "./context.js";
import { formatDuration, parseDuration, toGalactic } from "./galactic.js";
import type { JailRegistry } from "./jail.js";
import type { PrefixRegistry } from "./prefix/registry.js";

/**
 * The `/monarch` command family, written once against {@link CommandContext}
 * so slash commands and prefix commands share the exact same checks, replies
 * and API calls (`/monarch jail @user` and `!jail @user` are the same code).
 *
 * Everything structural still happens in the dashboard: the commands that
 * touch server data call `/api/internal/*` with `INTERNAL_API_TOKEN`, and
 * anything that mutates Discord goes through the diff → review → apply
 * pipeline in the web UI. Nothing here writes to Discord directly except the
 * two in-memory gags (jail / burg), which need live gateway messages.
 */

export interface MonarchCommandDeps {
  /** Dashboard origin, e.g. https://monarch.example — also the internal API. */
  appUrl: string;
  /** Server-to-server token; without it backup/export/embed/test/prefix-set explain what's missing. */
  internalToken?: string;
  jail: JailRegistry;
  burg: BurgRegistry;
  prefixes: PrefixRegistry;
  /** True when the Message Content intent is enabled (jail/burg/prefix need it). */
  messageGagsEnabled: () => boolean;
  /**
   * Application id for `!invite` (the "add me to your server" link). Falls
   * back to the bot's own user id — for a bot, those are the same snowflake —
   * which the prefix dispatcher supplies (the slash surface gets it from
   * DISCORD_CLIENT_ID, the same variable that registers the commands).
   */
  clientId?: string | null;
  botUserId?: () => string | null;
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

type ApiError = { message: string; reason?: string; fix?: string };

/** `sub` values this class handles — mirrors monarchCommandJSON(). */
export const MONARCH_SUBCOMMANDS = [
  "help",
  "dashboard",
  "invite",
  "status",
  "prefix",
  "backup",
  "export",
  "embed",
  "test",
  "jail",
  "unjail",
  "jailed",
] as const;

export type MonarchSubcommand = (typeof MONARCH_SUBCOMMANDS)[number];

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeApiError(e: ApiError | undefined, fallback: string): string {
  if (!e) return `❌ ${fallback}`;
  return `❌ ${e.message}\n${[e.reason, e.fix].filter(Boolean).join("\n")}`.trim();
}

/** One wording for "that duration makes no sense", on both surfaces. */
export const DURATION_ERROR = "❌ I didn't understand that duration. Use `30s`, `10m`, `2h`, `1d` or `1h30m`.";

/** Burg styles, shared with the slash command's choices. */
const BURG_STYLE_WORDS = ["random", "soft", "cat", "chaotic"];

/**
 * Does this word look like somebody *trying* to give a duration? `10m`, `2h`,
 * `90min`, `10 minutes` and a bare `minutes` all count; ordinary reason words
 * ("spamming memes", "being loud") don't.
 * Used so a typo is refused instead of being silently filed under "reason"
 * and turning a 10-minute jail into a life sentence.
 */
const DURATIONISH =
  /^(?:\d+\s*(?:[smhdw]|ms|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|wks?|weeks?)|(?:secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|wks?|weeks?))$/i;

/**
 * Free-form prefix arguments for the two gag commands: a mention/id, then an
 * optional duration (`10m`, `1h30m`), an optional burg style, and whatever is
 * left over becomes the reason. Order-free on purpose — text commands get
 * typed in whatever order feels natural.
 */
export function parseGagArgs(args: readonly string[]): {
  target: string | null;
  duration: string | null;
  /** A duration-shaped word we couldn't parse — the command must refuse. */
  invalidDuration: string | null;
  style: string | null;
  reason: string | null;
} {
  let target: string | null = null;
  let duration: string | null = null;
  let invalidDuration: string | null = null;
  let style: string | null = null;
  const rest: string[] = [];

  for (const raw of args) {
    const arg = raw.trim();
    if (arg.length === 0) continue;
    const lower = arg.toLowerCase();
    if (!target && /^\d{15,25}$/.test(arg)) {
      target = arg;
      continue;
    }
    const parsedMs = parseDuration(arg);
    if (parsedMs !== null && !duration) {
      duration = arg;
      continue;
    }
    if (parsedMs === null && !invalidDuration && DURATIONISH.test(lower)) {
      invalidDuration = arg;
      continue;
    }
    if (!style && BURG_STYLE_WORDS.includes(lower)) {
      style = lower;
      continue;
    }
    rest.push(arg);
  }
  return {
    target,
    duration,
    invalidDuration,
    style,
    reason: rest.length > 0 ? rest.join(" ") : null,
  };
}

export class MonarchCommands {
  /**
   * Late-bound "who am I" for the invite link: the prefix dispatcher sets this
   * from the live client (a bot's user id *is* its application id), so
   * `!invite` works on a worker that never got DISCORD_CLIENT_ID.
   */
  botUserId?: () => string | null;

  constructor(private readonly deps: MonarchCommandDeps) {}

  private get appUrl(): string {
    return this.deps.appUrl;
  }

  private get internalToken(): string | undefined {
    return this.deps.internalToken;
  }

  private internalHeaders(): Record<string, string> | undefined {
    return this.internalToken ? { Authorization: `Bearer ${this.internalToken}` } : undefined;
  }

  async run(ctx: CommandContext, sub: string): Promise<void> {
    switch (sub) {
      case "help":
        return this.help(ctx);
      case "dashboard":
        return this.dashboard(ctx);
      case "invite":
        return this.invite(ctx);
      case "status":
        return this.status(ctx);
      case "prefix":
        return this.prefix(ctx);
      case "backup":
        return this.backup(ctx);
      case "export":
        return this.export(ctx);
      case "embed":
        return this.embed(ctx);
      case "test":
        return this.test(ctx);
      case "jail":
        return this.jail(ctx);
      case "unjail":
        return this.unjail(ctx);
      case "jailed":
        return this.jailed(ctx);
      default:
        await ctx.replyHidden(
          `❓ I don't know \`${sub}\`. Try \`${ctx.commandPrefix}help\` or \`/monarch help\` for the full list.`,
        );
    }
  }

  // ── general ────────────────────────────────────────────────────────

  private async help(ctx: CommandContext): Promise<void> {
    // ctx.commandPrefix is already the guild's own prefix on both surfaces —
    // no second lookup (and no chance of quoting the wrong one).
    await ctx.replyEmbeds(renderHelpEmbeds(this.appUrl, ctx.guildId, ctx.commandPrefix), { hidden: true });
  }

  private async dashboard(ctx: CommandContext): Promise<void> {
    const url = `${this.appUrl}/s/${ctx.guildId}`;
    await ctx.replyHidden(`👑 Design **${ctx.guild.name}** in the Monarch studio:\n${url}`);
  }

  /**
   * `!invite` / `/monarch invite` — the "add Monarch to your own server" link.
   *
   * Deliberately open to everyone: it changes nothing anywhere. Discord's own
   * install dialog only offers servers the *clicker* can manage, so a member
   * without Manage Server can't use this to install a bot somewhere they
   * don't run — the worst case is a link they can't complete. That is exactly
   * why it's in the same "no danger" bucket as `status` and `dashboard`.
   *
   * Unlike the dashboard's invite button this link carries **no** `guild_id`:
   * the whole point is installing Monarch somewhere else, and pre-selecting
   * (with `disable_guild_select`) would lock the dialog to the server they
   * typed in — which already has the bot.
   */
  private async invite(ctx: CommandContext): Promise<void> {
    const clientId = this.deps.clientId ?? (this.botUserId?.() ?? this.deps.botUserId?.()) ?? null;
    const url = buildBotInviteUrl({ clientId });
    if (!url) {
      await ctx.replyHidden(
        `❓ I can't build an invite link without an application id — ask whoever runs this bot to set ` +
          `\`DISCORD_CLIENT_ID\` on the worker, or use **Add Monarch to Discord** at ${this.appUrl}.`,
      );
      return;
    }
    await ctx.replyHidden(
      [
        `👑 **Add Monarch to a server** — ${url}`,
        `• Discord's dialog lists the servers you can manage — pick the one you want Monarch in (this one already has it).`,
        `• Monarch asks for ${invitePermissionNames().length} permissions and never Administrator — the ones it actually uses: ` +
          `channels, roles, webhooks (the jail/burg relays), messages and files.`,
        `• Once it's in: \`${ctx.commandPrefix}help\` lists everything, and \`${ctx.commandPrefix}prefix set <new>\` picks a prefix.`,
        `• The dashboard for it lives at ${this.appUrl}/s/<server>.`,
      ].join("\n"),
    );
  }

  private async status(ctx: CommandContext): Promise<void> {
    const jailed = this.deps.jail.list(ctx.guildId).length;
    const burged = this.deps.burg.list(ctx.guildId).length;
    const prefix = ctx.commandPrefix;
    await ctx.replyHidden(
      [
        "**Monarch** — Design your Discord.",
        `• Server: ${ctx.guild.name}`,
        `• Dashboard: ${this.appUrl}`,
        `• Prefix: \`${prefix}\` (also @Monarch) — change it with \`${prefix}prefix set <new>\``,
        `• Jailed members: ${jailed}`,
        `• Burg'd members: ${burged}`,
        "• All design changes are previewed and applied from the dashboard.",
        `• \`${prefix}help\` or \`/monarch help\` lists every command — \`${prefix}invite\` adds Monarch to another server.`,
      ].join("\n"),
    );
  }

  /**
   * `!prefix` / `!prefix set m!` / `!prefix reset` / `/monarch prefix [prefix]`.
   *
   * Show without arguments; change with one. The default prefix and an
   * @Monarch mention always keep working, so a typo can never lock a server
   * out of its own bot.
   */
  private async prefix(ctx: CommandContext): Promise<void> {
    const current = await this.deps.prefixes.get(ctx.guildId);
    // Slash: the single `prefix` option. Prefix: every word after `prefix`,
    // where the first one may be a verb (`set`, `reset`, `show`).
    const args =
      ctx.surface === "slash"
        ? [ctx.getStringOption("prefix")].filter(
            (v): v is string => typeof v === "string" && v.trim().length > 0,
          )
        : ctx.args;

    // `!prefix`, `!prefix show` → what am I using?
    if (args.length === 0 || (args.length === 1 && args[0]!.toLowerCase() === "show")) {
      const isDefault = current === DEFAULT_COMMAND_PREFIX;
      await ctx.replyHidden(
        [
          `**Prefix in ${ctx.guild.name}**: \`${current}\`${isDefault ? " (the default)" : ""}`,
          `• Commands: \`${current}help\`, \`${current}play <song>\`, \`${current}jail @user\` — @Monarch works as a prefix too.`,
          isDefault
            ? `• Change it with \`${current}prefix set <new>\` — 1-${MAX_COMMAND_PREFIX_LENGTH} characters from \`${COMMAND_PREFIX_CHARS}\`.`
            : `• \`${DEFAULT_COMMAND_PREFIX}\` still works, and \`${current}prefix reset\` restores the default.`,
          this.deps.prefixes.persistent
            ? ""
            : "• ℹ Custom prefixes are saved through the Monarch dashboard — this bot has no `INTERNAL_API_TOKEN`, so only the default prefix is available.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }

    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden("❌ You need **Manage Server** or **Administrator** to change the prefix.");
      return;
    }

    const [verb, maybeValue] = args as [string, string | undefined];
    const lowerVerb = verb!.toLowerCase();
    const isVerb = ["set", "change", "reset", "clear", "default"].includes(lowerVerb);
    const requested = isVerb ? maybeValue ?? null : verb;

    if (isVerb && (["reset", "clear", "default"].includes(lowerVerb) || requested === null)) {
      const outcome = await this.deps.prefixes.set(ctx.guildId, null);
      if (!outcome.ok) {
        await ctx.replyHidden(outcome.message);
        return;
      }
      await ctx.replyHidden(
        `✅ Prefix reset to the default: \`${outcome.prefix}\` — try \`${outcome.prefix}help\`.`,
      );
      return;
    }

    if (requested!.trim().length === 0) {
      await ctx.replyHidden(
        `❓ Give me the new prefix, e.g. \`${ctx.commandPrefix}prefix set ?\` — 1-${MAX_COMMAND_PREFIX_LENGTH} characters from \`${COMMAND_PREFIX_CHARS}\`.`,
      );
      return;
    }

    const outcome = await this.deps.prefixes.set(ctx.guildId, requested);
    if (!outcome.ok) {
      await ctx.replyHidden(outcome.message);
      return;
    }
    await ctx.replyHidden(
      [
        `✅ Prefix for **${ctx.guild.name}** is now \`${outcome.prefix}\`.`,
        `• Try \`${outcome.prefix}help\`, \`${outcome.prefix}play <song>\`, \`${outcome.prefix}jail @user\`.`,
        `• \`${DEFAULT_COMMAND_PREFIX}\` and an @Monarch mention keep working; \`${outcome.prefix}prefix reset\` restores the default.`,
      ].join("\n"),
    );
  }

  // ── design studio (dashboard internal API) ─────────────────────────

  private async backup(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden("❌ You need **Manage Server** or **Administrator** to back up this server.");
      return;
    }
    if (!this.internalToken) {
      await ctx.replyHidden("❌ Backups need `INTERNAL_API_TOKEN` set in the dashboard and bot environments.");
      return;
    }
    await ctx.defer({ hidden: true });
    // Slash passes one `name` option; a text command just types the words.
    const name = (ctx.getStringOption("name") ?? joinArgs(ctx.args) ?? undefined)?.slice(0, 100) || undefined;
    try {
      const res = await fetch(`${this.appUrl}/api/internal/guilds/${ctx.guildId}/backup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.internalHeaders() },
        body: JSON.stringify({ name, userId: ctx.user.id }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        snapshot?: { name: string };
        categoryCount?: number;
        channelCount?: number;
        error?: ApiError;
      };
      if (res.ok && data.ok) {
        await ctx.edit(
          `✅ Backup **${data.snapshot?.name}** saved — ${data.categoryCount} categories, ${data.channelCount} channels.\n` +
            `Restore it any time from ${this.appUrl}/s/${ctx.guildId}/history`,
        );
      } else {
        await ctx.edit(describeApiError(data.error, "Monarch couldn't save the backup."));
      }
    } catch {
      await ctx.edit("❌ Couldn't reach the Monarch dashboard.");
    }
  }

  private async export(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden("❌ You need **Manage Server** or **Administrator** to export this server.");
      return;
    }
    if (!this.internalToken) {
      await ctx.replyHidden("❌ Export needs `INTERNAL_API_TOKEN` set in the dashboard and bot environments.");
      return;
    }
    await ctx.defer({ hidden: true });
    try {
      const res = await fetch(`${this.appUrl}/api/internal/guilds/${ctx.guildId}/template`, {
        headers: this.internalHeaders(),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        fileName?: string;
        template?: { data?: { categories?: unknown[]; channels?: unknown[] } };
        error?: ApiError;
      };
      if (res.ok && data.ok && data.template) {
        const cats = data.template.data?.categories?.length ?? 0;
        const chans = data.template.data?.channels?.length ?? 0;
        await ctx.attach(
          `📦 **${ctx.guild.name}** exported — ${cats} categories, ${chans} channels.\n` +
            `Import it into any server at ${this.appUrl}/s/<server>/import-export.`,
          [
            {
              name: data.fileName ?? "monarch-template.json",
              body: JSON.stringify(data.template, null, 2),
            },
          ],
        );
      } else {
        await ctx.edit(describeApiError(data.error, "Monarch couldn't export this server."));
      }
    } catch {
      await ctx.edit("❌ Couldn't reach the Monarch dashboard.");
    }
  }

  private async embed(ctx: CommandContext): Promise<void> {
    const url = `${this.appUrl}/s/${ctx.guildId}/embeds`;
    let info = "";
    if (!this.internalToken) {
      info = "\n\nℹ Tip: set `INTERNAL_API_TOKEN` in the dashboard and bot to see the saved embed here.";
    } else {
      try {
        const res = await fetch(`${this.appUrl}/api/internal/guilds/${ctx.guildId}/workspace`, {
          headers: this.internalHeaders(),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            workspace?: { embed?: { title?: string; description?: string } };
          };
          const embed = data.workspace?.embed;
          info = embed
            ? `\n\nSaved embed: **${truncate(embed.title ?? embed.description ?? "untitled", 80)}**`
            : "\n\nNo embed saved yet — the builder starts fresh.";
        } else if (res.status === 503) {
          info = "\n\nℹ Set `INTERNAL_API_TOKEN` to enable saved-design previews.";
        }
      } catch {
        info = "\n\n(Monarch dashboard is not reachable right now.)";
      }
    }
    await ctx.replyHidden(`👑 **Embed Builder** for **${ctx.guild.name}**:\n${url}${info}`);
  }

  private async test(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden("❌ You need **Manage Server** or **Administrator** to send designs.");
      return;
    }
    if (!this.internalToken) {
      await ctx.replyHidden(
        "❌ Can't reach Monarch's publish API — set `INTERNAL_API_TOKEN` in the dashboard and bot environments.",
      );
      return;
    }

    const kind = this.readKind(ctx);
    if (!kind) {
      await ctx.replyHidden(
        `❓ Say which design to send: \`${ctx.commandPrefix}test embed\` or \`${ctx.commandPrefix}test message\` ` +
          `(optionally followed by \`publish\` and a #channel).`,
      );
      return;
    }
    const mode = this.readMode(ctx) ?? "test";
    const channel = ctx.getChannelOption("channel");
    const target = channel ? { kind: "explicit", guildId: ctx.guildId, channelId: channel.id } : undefined;

    try {
      const res = await fetch(`${this.appUrl}/api/internal/guilds/${ctx.guildId}/workspace/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.internalHeaders() },
        body: JSON.stringify({ kind, mode, target }),
      });
      const data = (await res.json()) as { ok?: boolean; channelName?: string; error?: ApiError };
      if (res.ok && data.ok) {
        await ctx.replyHidden(`✅ ${mode === "publish" ? "Published" : "Tested"} **${kind}** to #${data.channelName}.`);
      } else {
        await ctx.replyHidden(describeApiError(data?.error, "Monarch couldn't send the design."));
      }
    } catch {
      await ctx.replyHidden("❌ Couldn't reach the Monarch dashboard.");
    }
  }

  /** `kind` option (slash) or the first `embed`/`message` word (prefix). */
  private readKind(ctx: CommandContext): "embed" | "message" | null {
    const fromOption = ctx.getStringOption("kind")?.toLowerCase();
    if (fromOption === "embed" || fromOption === "message") return fromOption;
    for (const arg of ctx.args) {
      const lower = arg.toLowerCase();
      if (lower === "embed" || lower === "embeds" || lower === "message" || lower === "messages") {
        return lower.startsWith("embed") ? "embed" : "message";
      }
    }
    return null;
  }

  /** `mode` option (slash) or a `test`/`publish` word (prefix). */
  private readMode(ctx: CommandContext): "test" | "publish" | null {
    const fromOption = ctx.getStringOption("mode")?.toLowerCase();
    if (fromOption === "test" || fromOption === "publish") return fromOption;
    for (const arg of ctx.args) {
      const lower = arg.toLowerCase();
      if (lower === "test") return "test";
      if (lower === "publish" || lower === "post" || lower === "send") return "publish";
    }
    return null;
  }

  // ── fun relays (jail + burg) ───────────────────────────────────────

  private async jail(ctx: CommandContext): Promise<void> {
    const { jail, burg, log } = this.deps;
    if (!ctx.memberHasAny(JAIL_PERMISSIONS)) {
      await ctx.replyHidden("❌ Only administrators and roles with **Kick Members** can jail people.");
      return;
    }
    if (!this.deps.messageGagsEnabled()) {
      await ctx.replyHidden(
        "❌ The jail is disabled on this Monarch instance: the **Message Content** intent isn't enabled for the bot application. " +
          "The host must turn it on under Bot → Privileged Gateway Intents and restart the bot.",
      );
      return;
    }

    const target = await this.targetMember(ctx);
    if (!target) {
      await ctx.replyHidden("❌ That user isn't in this server.");
      return;
    }
    if (target.id === ctx.user.id) {
      await ctx.replyHidden("You can't jail yourself — nice try.");
      return;
    }
    if (target.user.bot) {
      await ctx.replyHidden("❌ Bots can't be jailed.");
      return;
    }
    if (target.id === ctx.guild.ownerId) {
      await ctx.replyHidden("❌ The server owner can't be jailed.");
      return;
    }
    const invokerIsOwner = ctx.guild.ownerId === ctx.member.id;
    if (!invokerIsOwner && target.roles.highest.position >= ctx.member.roles.highest.position) {
      await ctx.replyHidden("❌ You can only jail members whose highest role is below yours.");
      return;
    }
    if (target.permissions.has(PermissionFlagsBits.Administrator) && !invokerIsOwner) {
      await ctx.replyHidden("❌ Administrators can only be jailed by the server owner.");
      return;
    }
    const mine = ctx.myPermissions();
    if (mine !== null && !mine.has(PermissionFlagsBits.ManageMessages)) {
      await ctx.replyHidden(
        "❌ Monarch needs the **Manage Messages** permission to delete and re-post jailed messages.\n" +
          `Re-invite it from ${this.appUrl} or grant the permission in Server Settings → Roles, then try again.`,
      );
      return;
    }
    if (mine !== null && !mine.has(PermissionFlagsBits.ManageWebhooks)) {
      log.warn("jail without Manage Webhooks — relaying as plain bot messages", { guildId: ctx.guildId });
    }
    if (burg.isBurg(ctx.guildId, target.id)) {
      await ctx.replyHidden(
        `❌ That member is already burg'd. Turn it off with \`${ctx.commandPrefix}burg @${target.user.username}\` first, then use the Galactic jail.`,
      );
      return;
    }

    const { duration: durationRaw, invalidDuration, reason } = this.gagInputs(ctx, ["duration", "reason"]);
    let until: number | null = null;
    if (invalidDuration) {
      // Refuse rather than quietly jail them forever because "ten minutes"
      // landed in the reason field.
      await ctx.replyHidden(DURATION_ERROR);
      return;
    }
    if (durationRaw) {
      const ms = parseDuration(durationRaw);
      if (ms === null) {
        await ctx.replyHidden(DURATION_ERROR);
        return;
      }
      until = Date.now() + ms;
    }

    jail.jail({ guildId: ctx.guildId, userId: target.id, until, jailedBy: ctx.user.id });
    log.info("member jailed", { guildId: ctx.guildId, userId: target.id, by: ctx.user.id, until, surface: ctx.surface });
    const when = until
      ? `for **${formatDuration(until - Date.now())}** (until <t:${Math.floor(until / 1000)}:f>)`
      : `**until released** with \`${ctx.commandPrefix}unjail\``;
    await ctx.replyHidden(
      `🔒 <@${target.id}> is jailed ${when}${reason ? ` — ${reason}` : ""}.\n` +
        `Everything they post will be re-posted as ${toGalactic("galactic")} under their name.`,
      { mentions: false },
    );
  }

  private async unjail(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(JAIL_PERMISSIONS)) {
      await ctx.replyHidden("❌ Only administrators and roles with **Kick Members** can release people.");
      return;
    }
    const target = await this.targetMember(ctx);
    if (!target) {
      await ctx.replyHidden("❌ That user isn't in this server.");
      return;
    }
    const released = this.deps.jail.release(ctx.guildId, target.id);
    if (!released) {
      await ctx.replyHidden(`<@${target.id}> isn't jailed.`);
      return;
    }
    this.deps.log.info("member released", {
      guildId: ctx.guildId,
      userId: target.id,
      by: ctx.user.id,
      surface: ctx.surface,
    });
    await ctx.replyHidden(`🔓 <@${target.id}> has been released.`);
  }

  private async jailed(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(JAIL_PERMISSIONS)) {
      await ctx.replyHidden("❌ Only administrators and roles with **Kick Members** can see the jail list.");
      return;
    }
    const entries = this.deps.jail.list(ctx.guildId);
    if (entries.length === 0) {
      await ctx.replyHidden("Nobody is jailed right now.");
      return;
    }
    await ctx.replyHidden(
      [
        `🔒 **Jailed in ${ctx.guild.name}** (${entries.length})`,
        ...entries.map(
          (e) =>
            `• <@${e.userId}> — ${e.until ? `until <t:${Math.floor(e.until / 1000)}:R>` : "until released"} · by <@${e.jailedBy}>`,
        ),
      ].join("\n"),
    );
  }

  /**
   * `/burg` — a toggle, so it lives beside the jail gag but keeps its own
   * top-level name on both surfaces (`/burg @user`, `!burg @user`).
   */
  async burg(ctx: CommandContext): Promise<void> {
    const { burg, jail, log } = this.deps;
    if (!ctx.memberHasAny(BURG_PERMISSIONS)) {
      await ctx.replyHidden("❌ Only administrators and roles with **Kick Members** can use /burg.");
      return;
    }

    const existingTarget = await this.targetMember(ctx);
    if (!existingTarget) {
      await ctx.replyHidden(
        `❓ Say who to burg — \`${ctx.commandPrefix}burg @user [duration] [style] [reason]\` (run it again to turn it off).`,
      );
      return;
    }
    if (burg.get(ctx.guildId, existingTarget.id)) {
      // Deliberately a toggle: no second command name to remember.
      burg.release(ctx.guildId, existingTarget.id);
      log.info("member unburged", {
        guildId: ctx.guildId,
        userId: existingTarget.id,
        by: ctx.user.id,
        surface: ctx.surface,
      });
      await ctx.replyHidden(`🧁 <@${existingTarget.id}> is no longer burg'd — their messages are back to normal.`);
      return;
    }

    const target = existingTarget;
    if (!this.deps.messageGagsEnabled()) {
      await ctx.replyHidden(
        "❌ /burg is disabled on this Monarch instance: the **Message Content** intent isn't enabled for the bot application. " +
          "The host must turn it on under Bot → Privileged Gateway Intents and restart the bot.",
      );
      return;
    }
    if (target.id === ctx.user.id) {
      await ctx.replyHidden("You can't burg yourself — nice try.");
      return;
    }
    if (target.user.bot) {
      await ctx.replyHidden("❌ Bots can't be burg'd.");
      return;
    }
    if (target.id === ctx.guild.ownerId) {
      await ctx.replyHidden("❌ The server owner can't be burg'd.");
      return;
    }
    const invokerIsOwner = ctx.guild.ownerId === ctx.member.id;
    if (!invokerIsOwner && target.roles.highest.position >= ctx.member.roles.highest.position) {
      await ctx.replyHidden("❌ You can only burg members whose highest role is below yours.");
      return;
    }
    if (target.permissions.has(PermissionFlagsBits.Administrator) && !invokerIsOwner) {
      await ctx.replyHidden("❌ Administrators can only be burg'd by the server owner.");
      return;
    }
    if (jail.isJailed(ctx.guildId, target.id)) {
      await ctx.replyHidden(
        `❌ That member is already in the Galactic jail. Release them with \`${ctx.commandPrefix}unjail\` first, then use burg.`,
      );
      return;
    }
    const mine = ctx.myPermissions();
    if (mine !== null && !mine.has(PermissionFlagsBits.ManageMessages)) {
      await ctx.replyHidden(
        "❌ Monarch needs the **Manage Messages** permission to delete and re-post burg'd messages.\n" +
          `Re-invite it from ${this.appUrl} or grant the permission in Server Settings → Roles, then try again.`,
      );
      return;
    }
    if (mine !== null && !mine.has(PermissionFlagsBits.ManageWebhooks)) {
      log.warn("burg without Manage Webhooks — relaying as plain bot messages", { guildId: ctx.guildId });
    }

    const {
      duration: durationRaw,
      invalidDuration,
      reason,
      style: styleRaw,
    } = this.gagInputs(ctx, ["duration", "reason", "style"]);
    const style: BurgStyle =
      styleRaw === "soft" || styleRaw === "cat" || styleRaw === "chaotic" ? styleRaw : "random";
    let until: number | null = null;
    if (invalidDuration) {
      await ctx.replyHidden(DURATION_ERROR);
      return;
    }
    if (durationRaw) {
      const ms = parseDuration(durationRaw);
      if (ms === null) {
        await ctx.replyHidden(DURATION_ERROR);
        return;
      }
      until = Date.now() + ms;
    }

    burg.burg({ guildId: ctx.guildId, userId: target.id, until, burgedBy: ctx.user.id, style });
    log.info("member burged", {
      guildId: ctx.guildId,
      userId: target.id,
      by: ctx.user.id,
      until,
      style,
      surface: ctx.surface,
    });
    const when = until
      ? `for **${formatDuration(until - Date.now())}** (until <t:${Math.floor(until / 1000)}:f>)`
      : `**until toggled off** with \`${ctx.commandPrefix}burg @user\``;
    const styleLabel = style === "random" ? "a random cute style" : `the **${style}** style`;
    await ctx.replyHidden(
      `🧁 <@${target.id}> is burg'd ${when}${reason ? ` — ${reason}` : ""}.\n` +
        `Their messages will be re-posted as ${styleLabel}, e.g. ${toBurg("hello there", style)} under their name and avatar.\n` +
        `Use \`${ctx.commandPrefix}burg\` on them again to turn it off.`,
    );
  }

  // ── shared argument plumbing ───────────────────────────────────────

  /**
   * The gag commands read their inputs from slash options *or* from the
   * prefix argument list ({@link CommandContext.args}). One code path, two
   * surfaces.
   */
  private gagInputs(
    ctx: CommandContext,
    names: string[],
  ): { duration: string | null; invalidDuration: string | null; reason: string | null; style: string | null } {
    const parsed = ctx.surface === "slash" ? fromSlashOptions(ctx) : parseGagArgs(ctx.args);
    return {
      duration: names.includes("duration") ? parsed.duration : null,
      invalidDuration: names.includes("duration") ? parsed.invalidDuration : null,
      reason: names.includes("reason") ? parsed.reason : null,
      style: names.includes("style") ? parsed.style : null,
    };
  }

  /**
   * Who the command is about: the slash `user` option, or the first mention /
   * snowflake in the prefix arguments. A bare word is never treated as a
   * member — after `!jail` it's the reason.
   */
  private async targetMember(ctx: CommandContext): Promise<GuildMember | null> {
    const fromOption = ctx.getMemberOption("user");
    if (fromOption) return fromOption;

    const userId = this.targetUserId(ctx);
    if (!userId) return null;
    return ctx.resolveMember(userId);
  }

  /** The snowflake a gag command is aimed at (mentions arrive as ids). */
  private targetUserId(ctx: CommandContext): string | null {
    const fromOption = ctx.getUserOption("user");
    if (fromOption) return fromOption.id;
    return ctx.args.find((arg) => /^\d{15,25}$/.test(arg)) ?? null;
  }
}

/** The prefix form of a free-text option: every leftover word, joined. */
function joinArgs(args: readonly string[]): string | null {
  return args.length > 0 ? args.join(" ") : null;
}

/** Slash-option form of {@link parseGagArgs} (typed options: nothing to guess). */
function fromSlashOptions(ctx: CommandContext): {
  duration: string | null;
  invalidDuration: string | null;
  reason: string | null;
  style: string | null;
} {
  return {
    duration: ctx.getStringOption("duration"),
    invalidDuration: null,
    reason: ctx.getStringOption("reason"),
    style: ctx.getStringOption("style"),
  };
}
