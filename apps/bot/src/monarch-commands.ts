import { PermissionFlagsBits, type GuildBasedChannel, type GuildMember, type Role } from "discord.js";
import {
  COMMAND_PREFIX_CHARS,
  DEFAULT_COMMAND_PREFIX,
  MAX_COMMAND_PREFIX_LENGTH,
  buildBotInviteUrl,
} from "@monarch/shared";
import {
  JAIL_PERMISSIONS,
  DESIGN_PERMISSIONS,
  commandHelpEmbed,
  renderHelpEmbeds,
} from "./commands.js";
import type { JailConfig, JailConfigRegistry } from "./jail-config.js";
import type { JailManager } from "./jail-manager.js";
import {
  isVoterJailStyle,
  type JailRegistry,
  type JailStyle,
} from "./jail.js";
import { voteRequiredMessage, type VoteGate } from "./votes.js";
import type { CommandContext } from "./context.js";
import { confessButtonRow, starterEmbed, type ConfessionRegistry } from "./confession.js";
import { parseDuration } from "./durations.js";
import type { PrefixRegistry } from "./prefix/registry.js";
import type { DebugFlags } from "./debug.js";
import type { CatCards } from "./cat-cards.js";

/**
 * The `/monarch` command family, written once against {@link CommandContext}
 * so slash commands and prefix commands share the exact same checks, replies
 * and API calls (`/jail @user` and `!jail @user` are the same code).
 *
 * Everything structural still happens in the dashboard: the commands that
 * touch server data call `/api/internal/*` with `INTERNAL_API_TOKEN`, and
 * anything that mutates Discord goes through the diff → review → apply
 * pipeline in the web UI. Nothing here writes to Discord directly except the
 * in-memory jail registry; the confinement and relay need live gateway messages
 * and live in ./jail-manager.ts.
 */

export interface MonarchCommandDeps {
  /** Dashboard origin, e.g. https://monarch.example — also the internal API. */
  appUrl: string;
  /** Server-to-server token; without it backup/export/embed/test/prefix-set explain what's missing. */
  internalToken?: string;
  jail: JailRegistry;
  /** The #jail cell (channel/role/staff roles), persisted via the dashboard. */
  jailConfigs: JailConfigRegistry;
  /** The live half: building the cell, confining members, the relay. */
  jailManager: JailManager;
  prefixes: PrefixRegistry;
  /** Per-guild confession channels (persisted through the internal API). */
  confessions: ConfessionRegistry;
  /** True when the Message Content intent is enabled (the jail relay needs it). */
  jailEnabled: () => boolean;
  /**
   * Application id for `!invite` (the "add me to your server" link). Falls
   * back to the bot's own user id — for a bot, those are the same snowflake —
   * which the prefix dispatcher supplies (the slash surface gets it from
   * DISCORD_CLIENT_ID, the same variable that registers the commands).
   */
  clientId?: string | null;
  /** Discord user id of the person who owns the Monarch application. */
  ownerUserId?: string | null;
  /**
   * Owner-only `/monarch debug on|off` switch: while it is on, raw failure
   * detail is posted alongside the human-readable one. Optional — without it
   * (or without {@link MonarchCommandDeps.ownerUserId}) the subcommand
   * explains that it is not available.
   */
  debug?: DebugFlags;
  /**
   * top.gg vote gate for the voter perks. Optional: without one (or without
   * `TOPGG_TOKEN`) every perk is unlocked — see ./votes.ts.
   */
  votes?: VoteGate;
  /** Local image catalog plus global pull/adoption persistence. */
  cats?: CatCards;
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
  "jailed",
  "jail",
  "report",
  "vote",
  "confession",
  "debug",
] as const;

export type MonarchSubcommand = (typeof MONARCH_SUBCOMMANDS)[number];

function describeApiError(e: ApiError | undefined, fallback: string): string {
  if (!e) return `❌ ${fallback}`;
  return `❌ ${e.message}\n${[e.reason, e.fix].filter(Boolean).join("\n")}`.trim();
}

/** One wording for "that duration makes no sense", on both surfaces. */
export const DURATION_ERROR = "❌ Invalid duration. Try `10m` or `2h`.";

/** Jail styles, shared with the slash command's choices (./jail.ts). */
const JAIL_STYLE_WORDS = [
  "random",
  "soft",
  "cat",
  "chaotic",
  "pirate",
  "shakespeare",
  "robot",
];

/**
 * Does this word look like somebody *trying* to give a duration? Anything
 * with a digit (`10m`, `0m`, `10minutes`, `90min`) always counts; a bare
 * unit word (`minutes`, `hours`) only counts when a number shows up somewhere
 * else in the command (`10 minutes`, `ten minutes`). That keeps ordinary
 * reason prose ("being silly for hours") working while a typo is still
 * refused instead of being silently filed under "reason" and turning a
 * 10-minute jail into an indefinite one.
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
 * Free-form prefix arguments for the jail command: a mention/id, then an
 * optional duration (`10m`, `1h30m`), an optional jail style, and whatever is
 * left over becomes the reason. Order-free on purpose — text commands get
 * typed in whatever order feels natural — with one exception: style words
 * are only read *before* the reason starts, so "being chaotic today" stays
 * a reason instead of becoming style=chaotic plus "being today".
 */
export function parseJailArgs(args: readonly string[]): {
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
    if (!style && rest.length === 0 && JAIL_STYLE_WORDS.includes(lower)) {
      style = lower;
      continue;
    }
    rest.push(arg);
  }

  // A lone unit word with nothing else (`!jail @user minutes`) is a
  // forgotten number, not a one-word reason.
  if (
    !duration &&
    !invalidDuration &&
    rest.length === 1 &&
    DURATIONISH_BARE_UNIT.test(rest[0]!.toLowerCase())
  ) {
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
      case "jailed":
        return this.jailed(ctx);
      case "jail":
        return this.jailCell(ctx);
      case "report":
        return this.report(ctx);
      case "vote":
        return this.vote(ctx);
      case "confession":
        return this.confession(ctx);
      case "debug":
        return this.debug(ctx);
      case "cat":
        return this.cat(ctx);
      default:
        await ctx.replyHidden(
          `❓ I don't know \`${sub}\`. Try \`${ctx.commandPrefix}help\` or \`/monarch help\` for the full list.`,
        );
    }
  }

  // ── owner-only tooling ─────────────────────────────────────────────

  /**
   * `/monarch debug [state]` — the owner's switch for raw failure detail.
   *
   * Gated on `MONARCH_OWNER_USER_ID`: anyone else gets the same answer no
   * matter what they type, and never learns whether the switch is on. When it
   * is on, the music player posts the downloader's own words next to every
   * failure it announces (see {@link MusicManager.reportDebug}).
   */
  private async debug(ctx: CommandContext): Promise<void> {
    const owner = this.deps.ownerUserId?.trim();
    if (!owner || ctx.user.id !== owner) {
      this.deps.log.warn("debug command refused", { userId: ctx.user.id, guildId: ctx.guildId });
      await ctx.replyHidden("🔒 That command is reserved for the bot's owner.");
      return;
    }

    const flags = this.deps.debug;
    if (!flags) {
      await ctx.replyHidden("🐞 Debugging isn't wired up on this worker.");
      return;
    }

    const asked = (ctx.args[0] ?? ctx.getStringOption("state") ?? "").trim().toLowerCase();
    const on = ["on", "enable", "enabled", "true", "1", "yes"].includes(asked);
    const off = ["off", "disable", "disabled", "false", "0", "no"].includes(asked);

    if (on || off) {
      const state = flags.set(on);
      this.deps.log.info("debug mode changed", { userId: ctx.user.id, enabled: state });
      await ctx.replyHidden(`🐞 Debug ${state ? "on" : "off"}.`);
      return;
    }

    if (asked.length > 0 && !on && !off) {
      await ctx.replyHidden(
        `❓ \`${asked}\` isn't a state I know. Use \`/monarch debug on\` or \`/monarch debug off\` ` +
          `(\`${ctx.commandPrefix}debug on\` works too).`,
      );
      return;
    }

    await ctx.replyHidden(`🐞 Debug is ${flags.enabled ? "on" : "off"}.`);
  }

  // ── general ────────────────────────────────────────────────────────

  private async cat(ctx: CommandContext): Promise<void> {
    if (!this.deps.cats) {
      await ctx.replyHidden("🐾 Cat cards aren't configured on this bot worker yet.");
      return;
    }
    await this.deps.cats.roll(ctx);
  }

  private async help(ctx: CommandContext): Promise<void> {
    const query = ctx.surface === "prefix" ? ctx.args.join(" ").trim() : "";
    if (query) {
      const detail = commandHelpEmbed(query, ctx.commandPrefix);
      if (!detail) {
        await ctx.replyHidden(`❓ I don't know that command. Try \`${ctx.commandPrefix}help\`.`);
        return;
      }
      await ctx.replyEmbeds([detail], { hidden: true });
      return;
    }
    // No query: the compact directory. Ask `!help <command>` for details.
    await ctx.replyEmbeds(renderHelpEmbeds(this.appUrl, ctx.guildId, ctx.commandPrefix), {
      hidden: true,
    });
  }

  private async dashboard(ctx: CommandContext): Promise<void> {
    await ctx.replyHidden(`${this.appUrl}/s/${ctx.guildId}`);
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
    const clientId = this.deps.clientId ?? this.botUserId?.() ?? this.deps.botUserId?.() ?? null;
    const url = buildBotInviteUrl({ clientId });
    if (!url) {
      await ctx.replyHidden(
        `❓ I can't build an invite link without an application id — ask whoever runs this bot to set ` +
          `\`DISCORD_CLIENT_ID\` on the worker, or use **Add Monarch to Discord** at ${this.appUrl}.`,
      );
      return;
    }
    await ctx.replyHidden(`👑 Invite Monarch: ${url}`);
  }

  private async status(ctx: CommandContext): Promise<void> {
    const jailed = this.deps.jail.list(ctx.guildId).length;
    const prefix = ctx.commandPrefix;
    await ctx.replyHidden(
      `👑 ${ctx.guild.name} · ${jailed} jailed · prefix \`${prefix}\` · ${this.appUrl}/s/${ctx.guildId}`,
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
      await ctx.replyHidden(`Prefix: \`${current}\`${isDefault ? " (default)" : ""}.`);
      return;
    }

    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden(
        "❌ You need **Manage Server** or **Administrator** to change the prefix.",
      );
      return;
    }

    const [verb, maybeValue] = args as [string, string | undefined];
    const lowerVerb = verb!.toLowerCase();
    const isVerb = ["set", "change", "reset", "clear", "default"].includes(lowerVerb);
    const requested = isVerb ? (maybeValue ?? null) : verb;

    if (isVerb && (["reset", "clear", "default"].includes(lowerVerb) || requested === null)) {
      const outcome = await this.deps.prefixes.set(ctx.guildId, null);
      if (!outcome.ok) {
        await ctx.replyHidden(outcome.message);
        return;
      }
      await ctx.replyHidden(`✅ Prefix reset to \`${outcome.prefix}\`.`);
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
    await ctx.replyHidden(`✅ Prefix set to \`${outcome.prefix}\`.`);
  }

  // ── design studio (dashboard internal API) ─────────────────────────

  private async backup(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden(
        "❌ You need **Manage Server** or **Administrator** to back up this server.",
      );
      return;
    }
    if (!this.internalToken) {
      await ctx.replyHidden(
        "❌ Backups need `INTERNAL_API_TOKEN` set in the dashboard and bot environments.",
      );
      return;
    }
    await ctx.defer({ hidden: true });
    // Slash passes one `name` option; a text command just types the words.
    const name =
      (ctx.getStringOption("name") ?? joinArgs(ctx.args) ?? undefined)?.slice(0, 100) || undefined;
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
        await ctx.edit(`✅ Backup **${data.snapshot?.name}** saved.`);
      } else {
        await ctx.edit(describeApiError(data.error, "Monarch couldn't save the backup."));
      }
    } catch {
      await ctx.edit("❌ Couldn't reach the Monarch dashboard.");
    }
  }

  private async export(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden(
        "❌ You need **Manage Server** or **Administrator** to export this server.",
      );
      return;
    }
    if (!this.internalToken) {
      await ctx.replyHidden(
        "❌ Export needs `INTERNAL_API_TOKEN` set in the dashboard and bot environments.",
      );
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
          `📦 **${ctx.guild.name}** exported (${cats} categories, ${chans} channels).`,
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
    await ctx.replyHidden(`👑 Embed Builder: ${this.appUrl}/s/${ctx.guildId}/embeds`);
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
    const target = channel
      ? { kind: "explicit", guildId: ctx.guildId, channelId: channel.id }
      : undefined;

    try {
      const res = await fetch(`${this.appUrl}/api/internal/guilds/${ctx.guildId}/workspace/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.internalHeaders() },
        body: JSON.stringify({ kind, mode, target }),
      });
      const data = (await res.json()) as { ok?: boolean; channelName?: string; error?: ApiError };
      if (res.ok && data.ok) {
        await ctx.replyHidden(
          `✅ ${mode === "publish" ? "Published" : "Tested"} **${kind}** to #${data.channelName}.`,
        );
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

  // ── jail ───────────────────────────────────────────────────────────

  /** `/monarch jailed` — who is in the cell right now. */
  private async jailed(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(JAIL_PERMISSIONS)) {
      await ctx.replyHidden(
        "❌ Only administrators and roles with **Kick Members** can see who's jailed.",
      );
      return;
    }
    const entries = this.deps.jail.list(ctx.guildId);
    if (entries.length === 0) {
      await ctx.replyHidden("Nobody is jailed right now. 🎉");
      return;
    }
    await ctx.replyHidden(
      [`⚖️ Jailed (${entries.length})`, ...entries.map((entry) => `<@${entry.userId}>`)].join("\n"),
    );
  }

  /**
   * `/monarch jail` — the cell: `setup`, `disable`, `status`. The bare
   * `!jail …` form is the gag itself, so a word that isn't a verb falls
   * through to {@link jail} (that is what keeps `!jail @user 10m` working).
   */
  private async jailCell(ctx: CommandContext): Promise<void> {
    const verb = (ctx.getSubcommand() ?? "").toLowerCase();
    if (verb === "setup") return this.jailSetup(ctx);
    if (verb === "disable") return this.jailDisable(ctx);
    if (verb === "status") return this.jailStatus(ctx);
    return this.jail(ctx);
  }

  /**
   * `/monarch jail setup [#channel] [staff]` and `!jail setup …`.
   *
   * Builds the cell: a #jail channel hidden from @everyone, a managed
   * @jailed role that setup creates (with no server-wide permissions) and
   * that may only read and write in that channel, plus a deny for that role
   * on every other channel in the server. Re-running refreshes staff access and
   * repairs anything that changed outside Monarch.
   */
  private async jailSetup(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden(
        "❌ You need **Manage Server** or **Administrator** to set up the jail cell.",
      );
      return;
    }
    if (!this.deps.jailConfigs.persistent) {
      await ctx.replyHidden(
        "❌ The jail cell is saved through the Monarch dashboard — set `INTERNAL_API_TOKEN` " +
          "in the dashboard and bot environments first. The `/jail` relay still works without a cell.",
      );
      return;
    }

    await ctx.defer({ hidden: true });

    // A channel option that isn't a normal text channel is refused here so the
    // manager never has to explain Discord's channel types.
    const channelId = ctx.getChannelOption("channel")?.id ?? null;
    const channel = channelId
      ? await ctx.guild.channels.fetch(channelId).catch(() => null)
      : null;
    if (channelId && (!channel || !channel.isTextBased() || channel.isThread())) {
      await ctx.edit(
        "❌ The cell must be a normal text channel Monarch can see — mention a different channel or leave it out and I'll create `#jail`.",
      );
      return;
    }

    const staff = await this.resolveRole(ctx, "staff");
    if (ctx.getRoleOption("staff") && !staff) {
      await ctx.edit("❌ I couldn't find that staff role in this server.");
      return;
    }

    const result = await this.deps.jailManager.setup(ctx.guild, {
      channel,
      staffRole: staff,
      actorId: ctx.user.id,
    });
    if (!result.ok) {
      await ctx.edit(result.message);
      return;
    }

    await ctx.edit(
      `🔒 Jail cell ready: <#${result.channel.id}> · role <@&${result.role.id}>${result.failed ? ` · ${result.failed} channel locks failed` : ""}.`,
    );
  }

  /** `/monarch jail disable` — release everyone and forget the cell. */
  private async jailDisable(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden(
        "❌ You need **Manage Server** or **Administrator** to disable the jail cell.",
      );
      return;
    }
    const result = await this.deps.jailManager.disable(ctx.guild, ctx.user.id);
    if (!result.ok) {
      await ctx.replyHidden(result.message);
      return;
    }
    await ctx.replyHidden(
      `🔓 Jail disabled · ${result.released} released${result.failed > 0 ? ` · ${result.failed} permission errors` : ""}.`,
    );
  }

  /** `/monarch jail status` — the cell and its occupants. */
  private async jailStatus(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(JAIL_PERMISSIONS)) {
      await ctx.replyHidden(
        "❌ Only administrators and roles with **Kick Members** can inspect the jail.",
      );
      return;
    }
    if (!this.deps.jailConfigs.persistent) {
      await ctx.replyHidden(
        "❌ The jail cell is stored through the Monarch dashboard, and this bot has no " +
          "`INTERNAL_API_TOKEN` — so there is no cell here, only the relay gag.",
      );
      return;
    }
    const status = await this.deps.jailManager.status(ctx.guild);
    if (!status.config) {
      await ctx.replyHidden(
        `🔓 **No jail cell is set up here.** The \`/jail\` relay works, but nobody is confined. ` +
          `Run \`${ctx.commandPrefix}jail setup\` to build one.`,
      );
      return;
    }
    await ctx.replyHidden(
      `🔒 Jail: ${status.channelExists ? `<#${status.config.channelId}>` : "channel missing"} · ${status.jailed.length} jailed · ${status.roleExists ? "role active" : "role missing"}.`,
    );
  }

  /**
   * `/jail @user [duration] [style] [reason]`, `!jail @user …` — a toggle with
   * an update path.
   *
   * Run it bare on a jailed member to set them free; run it with a duration,
   * style or reason to (re)apply it. The inputs are parsed *before* the
   * toggle decision so a typo can't silently open the cell.
   *
   * The relay is the joke, the role is the confinement: with a cell in place
   * the member also gets the @jailed role (so the rest of the server becomes
   * invisible to them) and loses it on release. Without one, `/jail` is the
   * old relay-only gag.
   */
  async jail(ctx: CommandContext): Promise<void> {
    const { jail, log } = this.deps;
    if (!ctx.memberHasAny(JAIL_PERMISSIONS)) {
      await ctx.replyHidden("❌ You need Kick Members to use jail.");
      return;
    }

    const target = await this.targetMember(ctx);
    if (!target) {
      if (ctx.surface === "prefix" && !this.targetUserId(ctx)) {
        await ctx.replyHidden(`Use \`${ctx.commandPrefix}jail @user\`.`);
      } else {
        // Slash always carries a user option, and a prefix id that resolves
        // to nobody, both mean the same thing: the member isn't here.
        await ctx.replyHidden("❌ That user isn't in this server.");
      }
      return;
    }

    const existing = jail.get(ctx.guildId, target.id);
    const inputs = this.jailInputs(ctx, ["duration", "reason", "style"]);
    const hasNewInputs =
      inputs.duration !== null ||
      inputs.invalidDuration !== null ||
      inputs.style !== null ||
      inputs.reason !== null;
    if (existing && !hasNewInputs) {
      // Deliberately a toggle: no second command name to remember. Releasing
      // only needs the moderation permission — not the intent, not the role
      // hierarchy, not a working relay.
      jail.release(ctx.guildId, target.id);
      const config = await this.deps.jailConfigs.get(ctx.guildId);
      const freed = await this.deps.jailManager.free(ctx.guild, target.id, config);
      log.info("member released from jail", {
        guildId: ctx.guildId,
        userId: target.id,
        by: ctx.user.id,
        surface: ctx.surface,
        roleRemoved: freed,
      });
      await ctx.replyHidden(`<@${target.id}> has been released from jail ⚖️`);
      return;
    }
    if (!this.deps.jailEnabled()) {
      await ctx.replyHidden("❌ Jail needs the Message Content intent enabled.");
      return;
    }
    if (target.id === ctx.user.id) {
      await ctx.replyHidden("You can't jail yourself — nice try.");
      return;
    }
    // Jail cannot target the bot owner (the application owner). Reverse the
    // gag onto the person who tried it instead.
    if (this.deps.ownerUserId && target.id === this.deps.ownerUserId) {
      if (!jail.get(ctx.guildId, ctx.user.id)) {
        // ...unless they're already jailed, in which case the entry stays:
        // the reverse must not become a free get-out-of-jail card.
        jail.jail({
          guildId: ctx.guildId,
          userId: ctx.user.id,
          until: null,
          jailedBy: target.id,
          style: "random",
        });
      }
      log.info("bot owner uno-reversed the jail command", {
        guildId: ctx.guildId,
        attemptedTarget: target.id,
        jailedUser: ctx.user.id,
        surface: ctx.surface,
      });
      const config = await this.deps.jailConfigs.get(ctx.guildId);
      if (config) await this.confineOrWarn(ctx, ctx.user.id, config);
      await ctx.replyHidden(`<@${ctx.user.id}> has been put in jail ⚖️`);
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
    if (target.permissions.has(PermissionFlagsBits.Administrator)) {
      await ctx.replyHidden("❌ Admins can't be jailed; Discord bypasses channel restrictions.");
      return;
    }
    const mine = ctx.myPermissions();
    if (mine !== null && !mine.has(PermissionFlagsBits.ManageMessages)) {
      await ctx.replyHidden("❌ Give the bot Manage Messages permission first.");
      return;
    }
    if (mine !== null && !mine.has(PermissionFlagsBits.ManageWebhooks)) {
      log.warn("jail without Manage Webhooks — relaying as plain bot messages", {
        guildId: ctx.guildId,
      });
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
    const style = asJailStyle(inputs.style) ?? "random";

    // Voter perks: the premium styles are the reward for a top.gg vote. Checked
    // before anything is stored, so a locked style never half-applies.
    if (style !== "random" && isVoterJailStyle(style)) {
      if (!(await this.requireVote(ctx, `The **${style}** style`))) return;
    }

    const config = await this.deps.jailConfigs.get(ctx.guildId);

    if (existing) {
      // Re-running with options updates the entry instead of toggling it
      // off: whatever the command didn't mention keeps its current value, so
      // `!jail @user pirate` changes the style without touching the timer.
      const resolvedStyle = asJailStyle(inputs.style) ?? existing.style;
      const resolvedUntil = inputs.duration ? until : existing.until;
      jail.jail({
        guildId: ctx.guildId,
        userId: target.id,
        until: resolvedUntil,
        jailedBy: ctx.user.id,
        style: resolvedStyle,
        reason: inputs.reason ?? existing.reason,
      });
      log.info("jail updated", {
        guildId: ctx.guildId,
        userId: target.id,
        by: ctx.user.id,
        until: resolvedUntil,
        style: resolvedStyle,
        surface: ctx.surface,
      });
      await ctx.replyHidden(`Updated <@${target.id}>'s jail ⚖️`);
      if (config) await this.confineOrWarn(ctx, target.id, config);
      return;
    }

    jail.jail({
      guildId: ctx.guildId,
      userId: target.id,
      until,
      jailedBy: ctx.user.id,
      style,
      reason: inputs.reason,
    });
    log.info("member jailed", {
      guildId: ctx.guildId,
      userId: target.id,
      by: ctx.user.id,
      until,
      style,
      surface: ctx.surface,
      confined: config !== null,
    });
    await ctx.replyHidden(`<@${target.id}> has been put in jail ⚖️`);
    if (config) await this.confineOrWarn(ctx, target.id, config);
  }

  /**
   * Hand out the @jailed role, or say why the confinement half didn't happen.
   * The relay is already running at this point, so a failure here is a
   * warning on top of a working gag — never a rollback.
   */
  private async confineOrWarn(
    ctx: CommandContext,
    userId: string,
    config: JailConfig,
  ): Promise<void> {
    const result = await this.deps.jailManager.confine(ctx.guild, userId, config);
    if (!result.ok) await ctx.replyHidden(`⚠️ Couldn't confine <@${userId}>. Check bot permissions.`);
  }

  // ── voter perks ────────────────────────────────────────────────────

  /**
   * Is this person allowed to use a voter perk? Reposts the vote link when
   * not. Without a gate (no `TOPGG_TOKEN`) everything is unlocked.
   */
  private async requireVote(ctx: CommandContext, perk: string): Promise<boolean> {
    const gate = this.deps.votes;
    if (!gate || !gate.enabled) return true;
    if (await gate.hasVoted(ctx.user.id)) return true;
    await ctx.replyHidden(voteRequiredMessage(perk, gate.voteUrl()));
    return false;
  }

  /** `/monarch vote` — the link, the perks, and whether the vote counts. */
  private async vote(ctx: CommandContext): Promise<void> {
    const gate = this.deps.votes;
    const url = gate?.voteUrl() ?? null;
    if (!gate || !gate.enabled) {
      await ctx.replyHidden("🗳️ Vote checks are off; all perks are unlocked.");
      return;
    }
    // Always re-check rather than trusting the cache: the point of this
    // command is to confirm the vote just landed.
    gate.forget(ctx.user.id);
    const voted = await gate.hasVoted(ctx.user.id);
    await ctx.replyHidden(
      `🗳️ Vote ${voted ? "counted — perks unlocked" : "not found"}.${url ? ` ${url}` : ""}`,
    );
  }

  /** `/monarch report` — the Design Analyzer report as a Markdown file. */
  private async report(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden("❌ You need **Manage Server** or **Administrator** to run a report.");
      return;
    }
    if (!this.internalToken) {
      await ctx.replyHidden(
        "❌ The report is computed by the Monarch dashboard — set `INTERNAL_API_TOKEN` in the dashboard and bot environments.",
      );
      return;
    }
    if (!(await this.requireVote(ctx, "The Design Analyzer report"))) return;

    await ctx.defer({ hidden: true });
    try {
      const res = await fetch(`${this.appUrl}/api/internal/guilds/${ctx.guildId}/analyzer`, {
        headers: this.internalHeaders(),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        fileName?: string;
        markdown?: string;
        score?: number;
        error?: ApiError;
      };
      if (res.ok && data.ok && data.markdown) {
        await ctx.attach(`📊 Design score: **${data.score ?? "?"}/100**.`,
          [{ name: data.fileName ?? "monarch-design-report.md", body: data.markdown }],
        );
      } else {
        await ctx.edit(describeApiError(data.error, "Monarch couldn't analyze this server."));
      }
    } catch {
      await ctx.edit("❌ Couldn't reach the Monarch dashboard.");
    }
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
      await ctx.replyHidden(`Use \`${ctx.commandPrefix}confession setup\` or \`${ctx.commandPrefix}confession disable\`. Details: \`${ctx.commandPrefix}help confession\`.`);
      return;
    }
    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden(
        "❌ You need **Manage Server** or **Administrator** to set up confessions.",
      );
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

    // Both surfaces answer by name: slash reads the typed channel options, the
    // prefix surface reads the channel mentions (or bare ids) in argument
    // order — first = channel, second = logs. No channel = this one, no logs.
    const channelId = ctx.getChannelOption("channel")?.id ?? ctx.channelId;
    const logChannelId = ctx.getChannelOption("logs")?.id ?? null;

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
      this.deps.log.warn("couldn't post the starter confession", {
        guildId: ctx.guildId,
        error: String(e),
      });
      await ctx.edit(
        "✅ Confessions are set up, but I couldn't post the starter confession — check my permissions " +
          "in that channel and run the command again.",
      );
      return;
    }

    await ctx.edit(`🤫 Confessions live in **#${publicChannel.name}**.`);
  }

  private async confessionDisable(ctx: CommandContext): Promise<void> {
    if (!ctx.memberHasAny(DESIGN_PERMISSIONS)) {
      await ctx.replyHidden(
        "❌ You need **Manage Server** or **Administrator** to disable confessions.",
      );
      return;
    }
    const confessions = this.deps.confessions;
    if (!confessions.persistent) {
      await ctx.replyHidden(
        "❌ Confession setup is saved through the Monarch dashboard — set `INTERNAL_API_TOKEN` in the dashboard and bot environments first.",
      );
      return;
    }
    const outcome = await confessions.configure(ctx.guildId, {
      channelId: null,
      logChannelId: null,
    });
    if (!outcome.ok) {
      await ctx.replyHidden(outcome.message);
      return;
    }
    this.deps.log.info("confessions disabled", { guildId: ctx.guildId });
    await ctx.replyHidden("🤫 Confessions are off.");
  }

  /** A guild text channel Monarch can view and post in. */
  private canConfessIn(channel: GuildBasedChannel | null, ctx: CommandContext): boolean {
    if (!channel || !channel.isTextBased()) return false;
    const me = ctx.guild.members.me;
    if (!me) return false;
    const perms = channel.permissionsFor(me);
    return Boolean(
      perms?.has(PermissionFlagsBits.ViewChannel) && perms?.has(PermissionFlagsBits.SendMessages),
    );
  }

  // ── shared argument plumbing ───────────────────────────────────────

  /**
   * The gag commands read their inputs from slash options *or* from the
   * prefix argument list ({@link CommandContext.args}). One code path, two
   * surfaces.
   */
  private jailInputs(
    ctx: CommandContext,
    names: string[],
  ): {
    duration: string | null;
    invalidDuration: string | null;
    reason: string | null;
    style: string | null;
  } {
    const parsed = ctx.surface === "slash" ? fromSlashOptions(ctx) : parseJailArgs(ctx.args);
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
   * member — after `!jail` its the reason.
   */
  private async targetMember(ctx: CommandContext): Promise<GuildMember | null> {
    const fromOption = ctx.getMemberOption("user");
    if (fromOption) return fromOption;

    const userId = this.targetUserId(ctx);
    if (!userId) return null;
    return ctx.resolveMember(userId);
  }

  /** A role option (`role`, `staff`) resolved against this guild. */
  private async resolveRole(ctx: CommandContext, name: string): Promise<Role | null> {
    const id = ctx.getRoleOption(name)?.id;
    if (!id) return null;
    const cached = ctx.guild.roles.cache.get(id);
    if (cached) return cached;
    return ctx.guild.roles.fetch(id).catch(() => null);
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

/** A validated jail style, or null when the caller gave none (or garbage). */
function asJailStyle(raw: string | null): JailStyle | null {
  return raw !== null && (JAIL_STYLE_WORDS as readonly string[]).includes(raw)
    ? (raw as JailStyle)
    : null;
}

/** Slash-option form of {@link parseJailArgs} (typed options: nothing to guess). */
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
