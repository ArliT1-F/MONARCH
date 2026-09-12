import { PermissionFlagsBits, type GuildBasedChannel, type GuildMember } from "discord.js";
import {
  COMMAND_PREFIX_CHARS,
  DEFAULT_COMMAND_PREFIX,
  MAX_COMMAND_PREFIX_LENGTH,
  buildBotInviteUrl,
  invitePermissionNames,
} from "@monarch/shared";
import { BURG_PERMISSIONS, DESIGN_PERMISSIONS, renderHelpEmbeds } from "./commands.js";
import type { BurgRegistry, BurgStyle } from "./burg.js";
import { toBurg } from "./burg.js";
import type { CommandContext } from "./context.js";
import { confessButtonRow, starterEmbed, type ConfessionRegistry } from "./confession.js";
import { formatDuration, parseDuration } from "./durations.js";
import type { PrefixRegistry } from "./prefix/registry.js";

/**
 * The `/monarch` command family, written once against {@link CommandContext}
 * so slash commands and prefix commands share the exact same checks, replies
 * and API calls (`/burg @user` and `!burg @user` are the same code).
 *
 * Everything structural still happens in the dashboard: the commands that
 * touch server data call `/api/internal/*` with `INTERNAL_API_TOKEN`, and
 * anything that mutates Discord goes through the diff → review → apply
 * pipeline in the web UI. Nothing here writes to Discord directly except the
 * in-memory burg gag, which needs live gateway messages.
 */

export interface MonarchCommandDeps {
  /** Dashboard origin, e.g. https://monarch.example — also the internal API. */
  appUrl: string;
  /** Server-to-server token; without it backup/export/embed/test/prefix-set explain what's missing. */
  internalToken?: string;
  burg: BurgRegistry;
  prefixes: PrefixRegistry;
  /** Per-guild confession channels (persisted through the internal API). */
  confessions: ConfessionRegistry;
  /** True when the Message Content intent is enabled (the burg relay needs it). */
  burgEnabled: () => boolean;
  /**
   * Application id for `!invite` (the "add me to your server" link). Falls
   * back to the bot's own user id — for a bot, those are the same snowflake —
   * which the prefix dispatcher supplies (the slash surface gets it from
   * DISCORD_CLIENT_ID, the same variable that registers the commands).
   */
  clientId?: string | null;
  /** Discord user id of the person who owns the Monarch application. */
  ownerUserId?: string | null;
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
  "burged",
  "confession",
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
 * Does this word look like somebody *trying* to give a duration? Anything
 * with a digit (`10m`, `0m`, `10minutes`, `90min`) always counts; a bare
 * unit word (`minutes`, `hours`) only counts when a number shows up somewhere
 * else in the command (`10 minutes`, `ten minutes`). That keeps ordinary
 * reason prose ("being silly for hours") working while a typo is still
 * refused instead of being silently filed under "reason" and turning a
 * 10-minute burg into an indefinite one.
 */
const DURATIONISH_WITH_DIGIT =
  /^\d+\s*(?:[smhdw]|ms|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|wks?|weeks?)$/i;
const DURATIONISH_BARE_UNIT = /^(?:secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|wks?|weeks?)$/i;

/** Number words that make a bare unit a duration attempt ("ten minutes"). */
const NUMBER_WORDS = new Set(
  "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred".split(
    " ",
  ),
);

/** A small bare number (`10` in `10 minutes`) — never a member snowflake. */
const BARE_NUMBER = /^\d{1,6}$/;

/**
 * Free-form prefix arguments for the burg command: a mention/id, then an
 * optional duration (`10m`, `1h30m`), an optional burg style, and whatever is
 * left over becomes the reason. Order-free on purpose — text commands get
 * typed in whatever order feels natural — with one exception: style words
 * are only read *before* the reason starts, so "being chaotic today" stays
 * a reason instead of becoming style=chaotic plus "being today".
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

  const sawNumeric = args.some((raw) => {
    const word = raw.trim().toLowerCase();
    return BARE_NUMBER.test(word) || NUMBER_WORDS.has(word);
  });

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
    if (parsedMs === null && !invalidDuration && DURATIONISH_WITH_DIGIT.test(arg)) {
      invalidDuration = arg;
      continue;
    }
    if (parsedMs === null && !invalidDuration && sawNumeric && DURATIONISH_BARE_UNIT.test(lower)) {
      invalidDuration = arg;
      continue;
    }
    if (!style && rest.length === 0 && BURG_STYLE_WORDS.includes(lower)) {
      style = lower;
      continue;
    }
    rest.push(arg);
  }

  // A lone unit word with nothing else (`!burg @user minutes`) is a
  // forgotten number, not a one-word reason.
  if (!duration && !invalidDuration && rest.length === 1 && DURATIONISH_BARE_UNIT.test(rest[0]!.toLowerCase())) {
    invalidDuration = rest.pop()!;
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
      case "burged":
        return this.burged(ctx);
      case "confession":
        return this.confession(ctx);
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
          `channels, roles, webhooks (the burg relay), messages and files.`,
        `• Once it's in: \`${ctx.commandPrefix}help\` lists everything, and \`${ctx.commandPrefix}prefix set <new>\` picks a prefix.`,
        `• The dashboard for it lives at ${this.appUrl}/s/<server>.`,
      ].join("\n"),
    );
  }

  private async status(ctx: CommandContext): Promise<void> {
    const burged = this.deps.burg.list(ctx.guildId).length;
    const prefix = ctx.commandPrefix;
    await ctx.replyHidden(
      [
        "**Monarch** — Design your Discord.",
        `• Server: ${ctx.guild.name}`,
        `• Dashboard: ${this.appUrl}`,
        `• Prefix: \`${prefix}\` (also @Monarch) — change it with \`${prefix}prefix set <new>\``,
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
          `• Commands: \`${current}help\`, \`${current}play <song>\`, \`${current}burg @user\` — @Monarch works as a prefix too.`,
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
        `• Try \`${outcome.prefix}help\`, \`${outcome.prefix}play <song>\`, \`${outcome.prefix}burg @user\`.`,
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

  // ── burg relay ─────────────────────────────────────────────────────

  private async burged(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(BURG_PERMISSIONS)) {
      await ctx.replyHidden("❌ Only administrators and roles with **Kick Members** can see who's burg'd.");
      return;
    }
    const entries = this.deps.burg.list(ctx.guildId);
    if (entries.length === 0) {
      await ctx.replyHidden("Nobody is burg'd right now.");
      return;
    }
    await ctx.replyHidden(
      [
        `🧁 **Burg'd in ${ctx.guild.name}** (${entries.length})`,
        ...entries.map(
          (e) =>
            `• <@${e.userId}> — ${e.style} · ${e.until ? `until <t:${Math.floor(e.until / 1000)}:R>` : "until toggled off"} · by <@${e.burgedBy}>`,
        ),
      ].join("\n"),
    );
  }

  /**
   * `/burg` — a toggle with an update path, on both surfaces (`/burg @user`,
   * `!burg @user`).
   *
   * Run it bare on a burg'd member to turn the gag off; run it with a
   * duration, style or reason to (re)apply it. The inputs are parsed *before*
   * the toggle decision so a typo can't silently switch the gag off.
   */
  async burg(ctx: CommandContext): Promise<void> {
    const { burg, log } = this.deps;
    if (!ctx.memberHasAny(BURG_PERMISSIONS)) {
      await ctx.replyHidden("❌ Only administrators and roles with **Kick Members** can use /burg.");
      return;
    }

    const target = await this.targetMember(ctx);
    if (!target) {
      if (ctx.surface === "prefix" && !this.targetUserId(ctx)) {
        await ctx.replyHidden(
          `❓ Say who to burg — \`${ctx.commandPrefix}burg @user [duration] [style] [reason]\` (run it again to turn it off).`,
        );
      } else {
        // Slash always carries a user option, and a prefix id that resolves
        // to nobody, both mean the same thing: the member isn't here.
        await ctx.replyHidden("❌ That user isn't in this server.");
      }
      return;
    }

    const existing = burg.get(ctx.guildId, target.id);
    const inputs = this.gagInputs(ctx, ["duration", "reason", "style"]);
    const hasNewInputs =
      inputs.duration !== null ||
      inputs.invalidDuration !== null ||
      inputs.style !== null ||
      inputs.reason !== null;
    if (existing && !hasNewInputs) {
      // Deliberately a toggle: no second command name to remember. Switching
      // the gag off needs nothing but the moderation permission — not the
      // intent, not the role hierarchy, not a working relay.
      burg.release(ctx.guildId, target.id);
      log.info("member unburged", {
        guildId: ctx.guildId,
        userId: target.id,
        by: ctx.user.id,
        surface: ctx.surface,
      });
      await ctx.replyHidden(`🧁 <@${target.id}> is no longer burg'd — their messages are back to normal.`);
      return;
    }
    if (!this.deps.burgEnabled()) {
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
    // Burg cannot target the bot owner (the application owner). Reverse the
    // gag onto the person who tried it instead.
    if (this.deps.ownerUserId && target.id === this.deps.ownerUserId) {
      if (!burg.get(ctx.guildId, ctx.user.id)) {
        // ...unless they're already burg'd, in which case the entry stays:
        // the reverse must not become a free toggle-off.
        burg.burg({ guildId: ctx.guildId, userId: ctx.user.id, until: null, burgedBy: target.id, style: "random" });
      }
      log.info("bot owner uno-reversed burg command", {
        guildId: ctx.guildId,
        attemptedTarget: target.id,
        burgedUser: ctx.user.id,
        surface: ctx.surface,
      });
      await ctx.replyHidden(
        "🔄 You tried to burg the bot owner. That's not how it works around here. Now you have been burg'd.",
      );
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

    if (inputs.invalidDuration) {
      await ctx.replyHidden(DURATION_ERROR);
      return;
    }
    let until: number | null = null;
    if (inputs.duration) {
      const ms = parseDuration(inputs.duration);
      if (ms === null) {
        await ctx.replyHidden(DURATION_ERROR);
        return;
      }
      until = Date.now() + ms;
    }
    const style = asBurgStyle(inputs.style) ?? "random";

    if (existing) {
      // Re-running with options updates the entry instead of toggling it
      // off: whatever the command didn't mention keeps its current value, so
      // `!burg @user cat` changes the style without touching the timer.
      const resolvedStyle = asBurgStyle(inputs.style) ?? existing.style;
      const resolvedUntil = inputs.duration ? until : existing.until;
      burg.burg({
        guildId: ctx.guildId,
        userId: target.id,
        until: resolvedUntil,
        burgedBy: ctx.user.id,
        style: resolvedStyle,
      });
      log.info("member burg updated", {
        guildId: ctx.guildId,
        userId: target.id,
        by: ctx.user.id,
        until: resolvedUntil,
        style: resolvedStyle,
        surface: ctx.surface,
      });
      const when = resolvedUntil
        ? `for **${formatDuration(resolvedUntil - Date.now())}** (until <t:${Math.floor(resolvedUntil / 1000)}:f>)`
        : `**until toggled off** with \`${ctx.commandPrefix}burg @user\``;
      const styleLabel = resolvedStyle === "random" ? "a random cute style" : `the **${resolvedStyle}** style`;
      await ctx.replyHidden(
        `🧁 Updated <@${target.id}>'s burg — now ${when}${inputs.reason ? ` — ${inputs.reason}` : ""}.\n` +
          `Now using ${styleLabel}. Run \`${ctx.commandPrefix}burg @user\` with no options to turn it off.`,
      );
      return;
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
      `🧁 <@${target.id}> is burg'd ${when}${inputs.reason ? ` — ${inputs.reason}` : ""}.\n` +
        `Their messages will be re-posted as ${styleLabel}, e.g. ${toBurg("hello there", style)} under their name and avatar.\n` +
        `Use \`${ctx.commandPrefix}burg\` on them again to turn it off.`,
    );
  }

  // ── confessions ────────────────────────────────────────────────────

  /**
   * `/monarch confession setup [channel] [logs]` / `disable` (and the prefix
   * forms `!monarch confession …`, `!confession …`).
   *
   * Setup fully reconfigures the feature in one call: the public confession
   * channel (the channel where the command was run, by default) plus an
   * optional staff-only log channel. On success the starter confession is
   * posted to the public channel — from then on every confession carries the
   * Confess button that opens the anonymous form (see ./confession.ts).
   */
  private async confession(ctx: CommandContext): Promise<void> {
    // Slash: the group's leaf. Prefix: the first argument word (`setup` in
    // `!confession setup`, `!monarch confession setup`).
    const verb = (ctx.getSubcommand() ?? "").toLowerCase();
    if (verb === "disable") return this.confessionDisable(ctx);
    if (verb !== "setup") {
      await ctx.replyHidden(
        [
          `❓ Confessions usage:`,
          `• \`${ctx.commandPrefix}monarch confession setup [#channel] [#logs]\` — point confessions at a channel (this one by default) and an optional staff log channel, then post the starter confession`,
          `• \`${ctx.commandPrefix}monarch confession disable\` — switch confessions off`,
          `• Also try \`/monarch confession setup\` with the channel picker.`,
        ].join("\n"),
      );
      return;
    }
    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden("❌ You need **Manage Server** or **Administrator** to set up confessions.");
      return;
    }
    const confessions = this.deps.confessions;
    if (!confessions.persistent) {
      await ctx.replyHidden(
        "❌ Confession setup is saved through the Monarch dashboard — set `INTERNAL_API_TOKEN` in the dashboard and bot environments first.",
      );
      return;
    }

    await ctx.defer({ hidden: true });

    // Slash: typed channel options. Prefix: channel mentions arrive as
    // snowflakes in argument order (first = channel, second = logs).
    const snowflakes = (ctx.surface === "prefix" ? ctx.args.slice(1) : []).filter((a) =>
      /^\d{15,25}$/.test(a),
    );
    const channelId = ctx.getChannelOption("channel")?.id ?? snowflakes[0] ?? ctx.channelId;
    const logChannelId = ctx.getChannelOption("logs")?.id ?? snowflakes[1] ?? null;

    const fetchedPublic = await ctx.guild.channels.fetch(channelId).catch(() => null);
    const publicChannel = fetchedPublic && fetchedPublic.isTextBased() ? fetchedPublic : null;
    if (!publicChannel || !this.canConfessIn(publicChannel, ctx)) {
      await ctx.edit(
        "❌ I can't read and write in that channel (or it isn't a text channel in this server). " +
          "Pick one Monarch can see and post in, then try again.",
      );
      return;
    }

    let logChannel: GuildBasedChannel | null = null;
    if (logChannelId) {
      if (logChannelId === channelId) {
        await ctx.edit(
          "❌ The log channel must be different from the confession channel — the log entries say who " +
            "confessed, so keep them in a staff-only channel.",
        );
        return;
      }
      logChannel = await ctx.guild.channels.fetch(logChannelId).catch(() => null);
      if (!logChannel || !this.canConfessIn(logChannel, ctx)) {
        await ctx.edit(
          "❌ I can't read and write in the log channel (or it isn't a text channel in this server). " +
            "Pick one Monarch can see and post in — ideally a staff-only channel.",
        );
        return;
      }
    }

    const outcome = await confessions.configure(ctx.guildId, { channelId, logChannelId });
    if (!outcome.ok) {
      await ctx.edit(outcome.message);
      return;
    }

    try {
      await publicChannel.send({
        embeds: [starterEmbed()],
        components: [confessButtonRow()],
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      this.deps.log.warn("couldn't post the starter confession", { guildId: ctx.guildId, error: String(e) });
      await ctx.edit(
        "✅ Confessions are set up, but I couldn't post the starter confession — check my permissions " +
          "in that channel and run the command again.",
      );
      return;
    }

    await ctx.edit(
      [
        `🤫 **Confessions are live in ${publicChannel.name}** — the starter confession is posted.`,
        "• Anyone can press **Confess** on any confession and tell us their secret — it goes up as an embed with no name, no avatar, no id.",
        logChannel
          ? `• Staff log: **${logChannel.name}** receives who, when, and a link to every confession — keep it staff-only.`
          : "• No log channel — confessions are fully untraceable. Add one with the `logs` option if staff should be able to see who confesses.",
        `• Re-run \`${ctx.commandPrefix}monarch confession setup\` to change the channels, or \`${ctx.commandPrefix}monarch confession disable\` to switch off.`,
      ].join("\n"),
    );
  }

  private async confessionDisable(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden("❌ You need **Manage Server** or **Administrator** to disable confessions.");
      return;
    }
    const confessions = this.deps.confessions;
    if (!confessions.persistent) {
      await ctx.replyHidden(
        "❌ Confession setup is saved through the Monarch dashboard — set `INTERNAL_API_TOKEN` in the dashboard and bot environments first.",
      );
      return;
    }
    const outcome = await confessions.configure(ctx.guildId, { channelId: null, logChannelId: null });
    if (!outcome.ok) {
      await ctx.replyHidden(outcome.message);
      return;
    }
    this.deps.log.info("confessions disabled", { guildId: ctx.guildId });
    await ctx.replyHidden(
      "🤫 Confessions are off in this server. The old confession messages stay in the channel " +
        "(delete them manually if you want a clean slate) — the Confess buttons on them will just say " +
        "confessions are off.",
    );
  }

  /** A guild text channel Monarch can view and post in. */
  private canConfessIn(channel: GuildBasedChannel | null, ctx: CommandContext): boolean {
    if (!channel || !channel.isTextBased()) return false;
    const me = ctx.guild.members.me;
    if (!me) return false;
    const perms = channel.permissionsFor(me);
    return Boolean(perms?.has(PermissionFlagsBits.ViewChannel) && perms?.has(PermissionFlagsBits.SendMessages));
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
   * member — after `!burg` it's the reason.
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

/** A validated burg style, or null when the caller gave none (or garbage). */
function asBurgStyle(raw: string | null): BurgStyle | null {
  return raw === "random" || raw === "soft" || raw === "cat" || raw === "chaotic" ? raw : null;
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
