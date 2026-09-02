import type { MonarchError } from "@monarch/shared";
import { monarchError } from "@monarch/shared";

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
