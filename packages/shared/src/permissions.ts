/**
 * Discord permission helpers used by both the dashboard (user permission
 * checks) and the Discord service layer (bot permission checks).
 * Bitfields follow the Discord API v10 permission flags.
 */
export const Permission = {
  Administrator: 1n << 3n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ManageMessages: 1n << 13n,
  ManageRoles: 1n << 28n,
  ManageWebhooks: 1n << 29n,
} as const;

export type PermissionName = keyof typeof Permission;

export function hasPermission(bitfield: string | bigint, perm: bigint): boolean {
  const bits = typeof bitfield === "string" ? BigInt(bitfield || "0") : bitfield;
  if ((bits & Permission.Administrator) === Permission.Administrator) return true;
  return (bits & perm) === perm;
}

/** Can this member administer server design (channels/roles/settings)? */
export function canDesignGuild(permissions: string | bigint): boolean {
  return (
    hasPermission(permissions, Permission.ManageGuild) ||
    hasPermission(permissions, Permission.Administrator)
  );
}

export function missingPermissions(
  bitfield: string | bigint,
  required: PermissionName[],
): PermissionName[] {
  return required.filter((name) => !hasPermission(bitfield, Permission[name]));
}
