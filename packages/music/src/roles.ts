/**
 * Music role policy — who can skip without a vote.
 *
 * Monarch never asks servers to create specific roles. Instead it recognizes
 * a role by **name** (case-insensitive, configurable) and falls back to real
 * Discord permissions, so a role called anything at all with moderator-ish
 * powers still counts as staff:
 *
 * 1. **DJ** — a role named like the server's DJ role (`DJ`, `DJs`, …).
 * 2. **Staff** — roles named Moderator / Mod / Staff / Admin / …, or members
 *    holding actual moderation permissions (Administrator, Manage Server,
 *    Timeout Members, Kick, Ban, Move Members).
 * 3. **Requester** — whoever queued the current track can always skip it.
 * 4. Everyone else votes, and a majority of the current listeners wins.
 */

export const DEFAULT_DJ_ROLE_NAMES = ["dj"] as const;

export const DEFAULT_STAFF_ROLE_NAMES = [
  "moderator",
  "moderators",
  "mod",
  "mods",
  "staff",
  "admin",
  "admins",
  "administrator",
  "administrators",
  "trial mod",
  "trial moderator",
] as const;

/**
 * Discord permission flags that imply "can moderate this server". Values
 * mirror the Discord API v10 bitfield (the same numbers discord.js uses).
 */
export const STAFF_PERMISSION_BITS = {
  Administrator: 1n << 3n,
  ManageGuild: 1n << 5n,
  MoveMembers: 1n << 24n,
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  ModerateMembers: 1n << 40n,
} as const;

export type StaffPermissionName = keyof typeof STAFF_PERMISSION_BITS;

export interface ForceSkipInput {
  /** The member's role names (any case; normalized here). */
  roleNames: string[];
  /** The member's permission bitfield as a bigint. */
  permissions: bigint;
  /** true when the member queued the track that is playing right now. */
  isCurrentRequester: boolean;
  config?: MusicRoleConfig;
}

export interface MusicRoleConfig {
  djRoleNames?: readonly string[];
  staffRoleNames?: readonly string[];
  /** Disable recognition of DJ roles if a server wants moderator-only. */
  djRolesEnabled?: boolean;
}

export type ForceSkipReason = "dj" | "staff" | "requester";

export interface ForceSkipResult {
  allowed: boolean;
  reason?: ForceSkipReason;
}

function normalize(names: readonly string[]): string[] {
  return names.map((n) => n.trim().toLowerCase()).filter(Boolean);
}

/** Does a role with one of these names exist on the member? */
export function hasNamedRole(roleNames: readonly string[], wanted: readonly string[]): boolean {
  const have = new Set(normalize(roleNames));
  return normalize(wanted).some((w) => have.has(w));
}

export function hasStaffPermissions(permissions: bigint): boolean {
  return Object.values(STAFF_PERMISSION_BITS).some((bit) => (permissions & bit) === bit);
}

/** Should this member's `/music skip` force-skip instead of starting a vote? */
export function canForceSkip(input: ForceSkipInput): ForceSkipResult {
  const config = input.config ?? {};
  if (config.djRolesEnabled !== false && hasNamedRole(input.roleNames, config.djRoleNames ?? DEFAULT_DJ_ROLE_NAMES)) {
    return { allowed: true, reason: "dj" };
  }
  if (hasNamedRole(input.roleNames, config.staffRoleNames ?? DEFAULT_STAFF_ROLE_NAMES)) {
    return { allowed: true, reason: "staff" };
  }
  if (hasStaffPermissions(input.permissions)) {
    return { allowed: true, reason: "staff" };
  }
  if (input.isCurrentRequester) {
    return { allowed: true, reason: "requester" };
  }
  return { allowed: false };
}

export const FORCE_SKIP_LABEL: Record<ForceSkipReason, string> = {
  dj: "DJ",
  staff: "staff",
  requester: "the requester",
};