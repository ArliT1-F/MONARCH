import {
  INVITE_PERMISSIONS,
  INVITE_SCOPES,
  buildBotInviteUrl as buildInviteUrl,
  invitePermissionBits,
  invitePermissionNames,
  isValidGuildId,
  type BotInviteUrlOptions,
} from "@monarch/shared";
import { env, isDemoMode } from "./env";

/**
 * Bot invite (OAuth2 "add to server") link building.
 *
 * The link itself — scopes, and the exact least-privilege permission set,
 * never Administrator — lives in `@monarch/shared/invite` because the bot
 * posts the very same URL in chat (`!invite` / `/monarch invite`). This
 * module only adds what the dashboard knows: which client id to use, and
 * whether an invite is possible at all in demo mode.
 */
export {
  INVITE_PERMISSIONS,
  INVITE_SCOPES,
  invitePermissionBits,
  invitePermissionNames,
  isValidGuildId,
};

export type BotInviteOptions = Omit<BotInviteUrlOptions, "clientId">;

/**
 * Build the Discord authorize URL that installs the Monarch bot.
 * Returns null when no Discord application is configured (demo mode).
 */
export function buildBotInviteUrl({ guildId }: BotInviteOptions = {}): string | null {
  return buildInviteUrl({ clientId: env.discordClientId, guildId });
}

/**
 * Can the "Invite Monarch" affordance do anything right now?
 * In demo mode the invite is simulated against the mock gateway, so it is
 * always available to a signed-in user.
 */
export function isInviteAvailable(): boolean {
  return isDemoMode() || Boolean(env.discordClientId);
}
