import type { ServerDesign } from "@monarch/schemas";
import type { GuildSummary } from "@monarch/schemas";
import type { Result } from "@monarch/shared";

/**
 * DiscordGateway — Monarch's abstraction boundary over Discord.
 *
 * Everything above this interface (dashboard, API routes, design engine)
 * is Discord-library agnostic. Two implementations exist:
 *
 *   RestDiscordGateway  — real Discord API v10 via @discordjs/rest
 *   MockDiscordGateway  — in-memory guilds for demo mode & tests
 *
 * Add capabilities here first; never let features import @discordjs/rest
 * or discord.js directly.
 */

export interface BotGuildInfo {
  id: string;
  botPermissions: string;
  botHighestRolePosition: number;
}

export interface CreatedChannel {
  id: string;
  name: string;
}

/** Minimal guild-member shape returned by GET /guilds/:id/members/@me. */
export interface DiscordMemberInfo {
  roles: string[];
  /** Discord-computed guild permission bitfield (decimal string). */
  permissions?: string | null;
}

/** Minimal role shape returned by GET /guilds/:id/roles. */
export interface DiscordRoleInfo {
  id: string;
  permissions: string;
  position: number;
}

/**
 * Compute the bot's guild-level permission bitfield.
 *
 * Prefers Discord's computed `member.permissions` when present; otherwise
 * ORs the permission bitfields of every role the member holds (including
 * @everyone, whose role id equals the guild id). Administrator ("8") is
 * kept as-is — `hasPermission` treats it as granting every permission,
 * exactly like Discord does.
 */
export function computeBotPermissions(
  member: DiscordMemberInfo,
  roles: DiscordRoleInfo[],
  guildId: string,
): string {
  if (typeof member.permissions === "string" && member.permissions.length > 0) {
    return member.permissions;
  }
  let permissions = 0n;
  for (const r of roles) {
    if (member.roles.includes(r.id)) permissions |= BigInt(r.permissions);
  }
  const everyone = roles.find((r) => r.id === guildId);
  if (everyone) permissions |= BigInt(everyone.permissions);
  return permissions.toString();
}

/**
 * A message Monarch sends. Discord API payload bodies (embeds/components)
 * are produced exclusively by @monarch/renderer — the gateway only
 * transports them.
 */
export interface MessagePayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
}

export interface DiscordGateway {
  /** Guilds the BOT is installed in (ids). */
  listBotGuildIds(): Promise<Set<string>>;

  /** Bot-side info for a guild the bot is in (permissions, hierarchy). */
  getBotGuildInfo(guildId: string): Promise<BotGuildInfo | null>;

  /** Approximate member count, if available. */
  getMemberCount(guildId: string): Promise<number | null>;

  /**
   * Capture the guild's current structure as a ServerDesign snapshot.
   * Channel types Monarch doesn't manage are omitted (surfaced as
   * unsupported elsewhere, never silently destroyed).
   */
  fetchServerDesign(guildId: string): Promise<Result<ServerDesign>>;

  // ── mutations (called only by the apply executor) ─────────────
  createCategory(guildId: string, payload: { name: string; position?: number }): Promise<Result<CreatedChannel>>;
  createChannel(
    guildId: string,
    payload: {
      name: string;
      kind: string;
      topic?: string;
      parentId?: string;
      nsfw?: boolean;
      slowmode?: number;
      position?: number;
    },
  ): Promise<Result<CreatedChannel>>;
  modifyChannel(
    guildId: string,
    channelId: string,
    payload: { name?: string; topic?: string | null; nsfw?: boolean; slowmode?: number; parentId?: string | null; position?: number },
  ): Promise<Result<void>>;
  deleteChannel(guildId: string, channelId: string): Promise<Result<void>>;

  /** Send a message (Send Test / publish) through the Target Resolver. */
  sendMessage(channelId: string, payload: MessagePayload): Promise<Result<{ messageId: string }>>;
}

/** OAuth-side guild info, obtained with the USER's token, not the bot's. */
export interface UserGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

export function buildGuildSummaries(
  userGuilds: UserGuild[],
  botGuildIds: Set<string>,
  extras: Map<string, { memberCount: number | null; botPermissions: string | null }>,
  canDesign: (permissions: string) => boolean,
): GuildSummary[] {
  return userGuilds.map((g) => {
    const extra = extras.get(g.id);
    return {
      id: g.id,
      name: g.name,
      iconUrl: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128` : null,
      memberCount: extra?.memberCount ?? null,
      botInstalled: botGuildIds.has(g.id),
      userCanDesign: g.owner || canDesign(g.permissions),
      botPermissions: extra?.botPermissions ?? null,
    };
  });
}
