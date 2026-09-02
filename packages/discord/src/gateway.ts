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

  /** Send a plain message (used by Send Test via the Target Resolver). */
  sendMessage(channelId: string, content: string): Promise<Result<{ messageId: string }>>;
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
