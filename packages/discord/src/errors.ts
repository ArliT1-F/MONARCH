import type { MonarchError } from "@monarch/shared";
import { monarchError } from "@monarch/shared";

/** HTTP status of a thrown @discordjs/rest error, if any. */
export function discordErrorStatus(e: unknown): number | undefined {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** Discord JSON error code (e.g. 10007 Unknown Member) of a thrown error, if any. */
export function discordErrorCode(e: unknown): number | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "number") return code;
  if (typeof code === "string" && /^\d+$/.test(code)) return Number(code);
  return undefined;
}

/**
 * Discord JSON error codes meaning "the bot is not in this guild / has no
 * access to it": Unknown Guild, Unknown Member, Missing Access.
 */
const NOT_IN_GUILD_CODES = new Set([10004, 10007, 50001]);

/**
 * True when a failed guild read POSITIVELY means the bot is not a member of
 * (or has no access to) the guild — as opposed to a transient failure such as
 * a rate limit, a 5xx or a network error, where the bot may well be installed
 * and callers must treat the answer as *unknown* rather than "missing".
 */
export function isNotInGuildError(e: unknown): boolean {
  const code = discordErrorCode(e);
  if (code !== undefined && NOT_IN_GUILD_CODES.has(code)) return true;
  const status = discordErrorStatus(e);
  return status === 403 || status === 404;
}

/**
 * Translate Discord API failures into human-readable Monarch errors.
 * Raw error payloads are preserved in `detail` for logs only.
 */
export function translateDiscordError(e: unknown, context: string): MonarchError {
  const status = (e as { status?: number })?.status;
  const code = (e as { code?: number })?.code;

  if (status === 403 || code === 50013) {
    return monarchError("discord.permissions", `Monarch doesn't have permission to ${context}.`, {
      reason: "The Monarch bot is missing the required permission, or the resource sits above its highest role.",
      fix: "Check Monarch's role permissions in Server Settings → Roles, and move Monarch's role higher if needed.",
      detail: e,
    });
  }
  if (status === 404 || code === 10003) {
    return monarchError("discord.not-found", `Monarch couldn't find the resource needed to ${context}.`, {
      reason: "It may have been deleted on Discord after Monarch last synced.",
      fix: "Refresh the server state and try again.",
      detail: e,
    });
  }
  if (status === 429) {
    return monarchError("discord.rate-limited", `Discord rate-limited Monarch while trying to ${context}.`, {
      reason: "Too many changes were sent in a short window.",
      fix: "Wait a moment and apply again — completed steps are not repeated.",
      detail: e,
    });
  }
  return monarchError("discord.unknown", `Monarch couldn't ${context}.`, {
    reason: "Discord returned an unexpected error.",
    fix: "Try again; if it keeps failing, check Monarch's permissions in this server.",
    detail: e,
  });
}
