import { Permission, type PermissionName } from "./permissions.js";

/**
 * The bot's "Add to Server" link, built in exactly one place.
 *
 * Two surfaces need it and they must agree to the bit:
 *
 * - the dashboard (`GET /api/invite`, the landing page and server picker),
 *   which redirects a signed-in user to Discord's install dialog, and
 * - the bot (`!invite` / `/monarch invite`), which posts the same link in
 *   chat so *anyone* — not just whoever can log into the studio — can put
 *   Monarch on a server they run.
 *
 * Monarch asks for exactly the permissions it uses, never Administrator
 * (spec §32: no moderation features; the invite must not smuggle any in).
 */
export const INVITE_PERMISSIONS: PermissionName[] = [
  "ViewChannel",
  "ManageChannels",
  "ManageRoles",
  "ManageWebhooks",
  "ManageMessages", // /monarch jail and /burg delete and re-post member messages
  "SendMessages",
  "SendMessagesInThreads",
  "EmbedLinks",
  "AttachFiles",
];

/** Decimal permission bitfield Discord expects in the invite URL. */
export function invitePermissionBits(): string {
  return INVITE_PERMISSIONS.reduce((bits, name) => bits | Permission[name], 0n).toString();
}

/** Scopes: the bot itself plus its slash commands (`/monarch …`). */
export const INVITE_SCOPES = ["bot", "applications.commands"] as const;

/** Discord snowflakes are 17-20 digits; be permissive but strictly numeric. */
export function isValidGuildId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{5,25}$/.test(value);
}

export interface BotInviteUrlOptions {
  /** Discord application (bot user) id. Nothing can be built without it. */
  clientId: string | null | undefined;
  /** Pre-select a server in Discord's install dialog. */
  guildId?: string | null;
}

/**
 * Build the Discord authorize URL that installs the Monarch bot.
 * Returns null when there is no application id (demo mode / unconfigured
 * worker) — callers decide what to say, they never invent a link.
 */
export function buildBotInviteUrl({ clientId, guildId }: BotInviteUrlOptions): string | null {
  if (!clientId) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    scope: INVITE_SCOPES.join(" "),
    permissions: invitePermissionBits(),
    // 0 = install to a guild (as opposed to a user-install).
    integration_type: "0",
  });
  if (isValidGuildId(guildId)) {
    params.set("guild_id", guildId);
    params.set("disable_guild_select", "true");
  }
  return `https://discord.com/oauth2/authorize?${params}`;
}

/** Human-readable permission list, for "here's what I'll be able to do". */
export function invitePermissionNames(): string[] {
  return [...INVITE_PERMISSIONS];
}
