import { Permission, type PermissionName } from "@monarch/shared";
import { env, isDemoMode } from "./env";

/**
 * Bot invite (OAuth2 "add to server") link building.
 *
 * Monarch asks for exactly the permissions it uses — nothing more. Anything
 * Monarch can't do without a permission is surfaced in the UI rather than
 * silently requesting Administrator.
 */
export const INVITE_PERMISSIONS: PermissionName[] = [
  "ViewChannel",
  "ManageChannels",
  "ManageRoles",
  "ManageWebhooks",
  "SendMessages",
  "EmbedLinks",
  "AttachFiles",
];

/** Decimal permission bitfield Discord expects in the invite URL. */
export function invitePermissionBits(): string {
  return INVITE_PERMISSIONS.reduce((bits, name) => bits | Permission[name], 0n).toString();
}

/** Scopes: the bot itself plus its slash commands (`/monarch …`). */
const INVITE_SCOPES = ["bot", "applications.commands"];

/** Discord snowflakes are 17-20 digits; be permissive but strictly numeric. */
export function isValidGuildId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{5,25}$/.test(value);
}

export interface BotInviteOptions {
  /** Pre-select a server in Discord's install dialog. */
  guildId?: string | null;
}

/**
 * Build the Discord authorize URL that installs the Monarch bot.
 * Returns null when no Discord application is configured (demo mode).
 */
export function buildBotInviteUrl({ guildId }: BotInviteOptions = {}): string | null {
  if (!env.discordClientId) return null;
  const params = new URLSearchParams({
    client_id: env.discordClientId,
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

/**
 * Can the "Invite Monarch" affordance do anything right now?
 * In demo mode the invite is simulated against the mock gateway, so it is
 * always available to a signed-in user.
 */
export function isInviteAvailable(): boolean {
  return isDemoMode() || Boolean(env.discordClientId);
}
