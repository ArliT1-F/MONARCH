import type { Message } from "discord.js";
import type { MonarchCommands } from "../monarch-commands.js";
import { canReplyIn, PrefixCommandContext } from "./context.js";
import { extractPrefixCommand, matchCommand, type PrefixInvocation } from "./parse.js";
import type { PrefixRegistry } from "./registry.js";

/**
 * Prefix-command dispatcher — the text-command front door.
 *
 * It owns only what is specific to *text* messages: which prefix matched,
 * whether Monarch may speak in that channel, how the words map onto a
 * command, and the top-level error net. Every command itself is the same
 * surface-neutral handler the slash commands use
 * ({@link MonarchCommands}, `MusicCommands`), so the two ways of typing a
 * command can't drift apart.
 *
 * Silent by default: an unknown `!word` is ignored, because most servers run
 * other bots on `!` and Monarch must not answer their prefixes. Anything
 * addressed with an @Monarch mention (or under `!monarch` / `!music`) is
 * unambiguously ours and does get a helpful reply.
 */

export interface PrefixDispatcherDeps {
  prefixes: PrefixRegistry;
  monarch: MonarchCommands;
  /** Created lazily by the worker so the voice stack never blocks boot. */
  music: () => import("../music/commands.js").MusicCommands;
  /** The bot's own user id, for `@Monarch help` — null before READY. */
  botUserId: () => string | null;
  /** False when the Message Content intent is off (prefix commands need it). */
  enabled: () => boolean;
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** True when this message was handled as a prefix command. */
export async function handlePrefixMessage(message: Message<true>, deps: PrefixDispatcherDeps): Promise<boolean> {
  if (!deps.enabled()) return false;

  const content = message.content ?? "";

  // Fast path, no I/O: try the prefixes we already know (the default and an
  // @Monarch mention are always among them, so nothing is ever missed here).
  const botUserId = deps.botUserId();
  const cached = deps.prefixes.peek(message.guildId);
  let invocation = cached ? extractPrefixCommand(content, cached, botUserId) : null;

  if (!invocation) {
    // Slow path: this guild's prefix isn't cached (or is stale). One internal
    // API call per guild per TTL — and only for messages that could plausibly
    // be a command, so ordinary chatter costs nothing.
    if (!/^\s*(?:<@|[\p{L}\p{N}\p{P}\p{S}])/u.test(content)) return false;
    const prefixes = await deps.prefixes.candidates(message.guildId);
    invocation = extractPrefixCommand(content, prefixes, botUserId);
    if (!invocation) return false;
  }

  const match = matchCommand(invocation);
  if (match.kind === "ignore") return false;
  // A lone `!` in a busy channel is noise; a lone @Monarch mention is a hello.
  if (match.kind === "bare" && !match.viaMention) return false;
  if (!canReplyIn(message)) {
    deps.log.warn("prefix command ignored — no Send Messages permission", {
      guildId: message.guildId,
      channelId: message.channelId,
    });
    return true;
  }

  // Replies quote a prefix people can actually type — the server's configured
  // one, whether this message arrived through it, through the default, or
  // through an @Monarch mention (which has no typable form at all).
  const prefix = await deps.prefixes.get(message.guildId);
  const ctx = new PrefixCommandContext(message, invocation, prefix, match.kind === "command" ? match.args : []);

  try {
    switch (match.kind) {
      case "bare":
        await ctx.replyHidden(greeting(prefix));
        return true;
      case "unknown":
        await ctx.replyHidden(unknownCommand(match.token, prefix));
        return true;
      case "command":
        await runCommand(match, ctx, deps, botUserId);
        return true;
      default:
        return false;
    }
  } catch (e) {
    deps.log.error("prefix command failed", {
      guildId: message.guildId,
      channelId: message.channelId,
      command: match.kind === "command" ? `${match.surface} ${"sub" in match ? match.sub : ""}`.trim() : match.kind,
      error: String(e),
    });
    if (!ctx.answered) {
      await ctx
        .replyHidden(`❌ Something went wrong running that command — try again, or use the slash version (\`/${match.kind === "command" ? match.surface : "monarch"}\`).`)
        .catch(() => {});
    }
    return true;
  }
}

async function runCommand(
  match: Extract<ReturnType<typeof matchCommand>, { kind: "command" }>,
  ctx: PrefixCommandContext,
  deps: PrefixDispatcherDeps,
  botUserId: string | null,
): Promise<void> {
  switch (match.surface) {
    case "monarch":
      // The mention path knows who we are even when DISCORD_CLIENT_ID is unset
      // on the worker, so `!invite` can still build a link.
      deps.monarch.botUserId ??= () => botUserId;
      await deps.monarch.run(ctx, match.sub);
      return;
    case "burg":
      await deps.monarch.burg(ctx);
      return;
    case "music":
      await deps.music().run(ctx, match.sub);
      return;
  }
}

/** "@Monarch" with nothing after it — point at help instead of staying mute. */
function greeting(prefix: string): string {
  return [
    "👑 **Monarch — Design your Discord.**",
    `• \`${prefix}help\` — every command (slash commands work too)`,
    `• \`${prefix}dashboard\` — open this server in the design studio`,
    `• \`${prefix}play <song>\` — music · \`${prefix}queue\` · \`${prefix}skip\``,
    `• \`${prefix}prefix set <new>\` — use your own prefix`,
    `• \`${prefix}invite\` — add Monarch to a server of your own`,
  ].join("\n");
}

function unknownCommand(token: string, prefix: string): string {
  return (
    `❓ \`${token}\` isn't a Monarch command.\n` +
    `Try \`${prefix}help\` for the full list — or \`/monarch help\` in slash form.`
  );
}

export type { PrefixInvocation };
