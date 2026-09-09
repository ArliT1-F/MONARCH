import { REST } from "@discordjs/rest";
import {
  Routes,
  ChannelType,
  type APIChannel,
  type APIGuild,
  type APIGuildChannel,
} from "discord-api-types/v10";
import type { ServerDesign } from "@monarch/schemas";
import { emptyServerDesign } from "@monarch/schemas";
import { ok, err, type Result, createLogger } from "@monarch/shared";
import {
  channelKindToDiscordType,
  discordTypeToChannelKind,
  supportsTopic,
} from "@monarch/renderer";
import {
  computeBotPermissions,
  type BotGuildInfo,
  type CreatedChannel,
  type DiscordGateway,
  type DiscordMemberInfo,
  type DiscordRoleInfo,
  type MessagePayload,
} from "./gateway.js";
import { isNotInGuildError, translateDiscordError } from "./errors.js";

const log = createLogger("discord.rest");

/**
 * Real Discord gateway using the bot token via @discordjs/rest
 * (which handles rate limiting and retries — Monarch never hardcodes
 * rate-limit values).
 */
export class RestDiscordGateway implements DiscordGateway {
  private rest: REST;
  /** The bot's own user id (`GET /users/@me`), resolved once per process. */
  private botUserId: Promise<string> | null = null;

  constructor(botToken: string) {
    this.rest = new REST({ version: "10" }).setToken(botToken);
  }

  /**
   * Discord has no documented `GET /guilds/:id/members/@me`; the member
   * endpoint wants a real user id. Resolve the bot's id from `/users/@me`
   * once and reuse it (a failure is not cached so the next call retries).
   */
  private getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      this.botUserId = (this.rest.get(Routes.user("@me")) as Promise<{ id: string }>)
        .then((u) => u.id)
        .catch((e) => {
          this.botUserId = null;
          throw e;
        });
    }
    return this.botUserId;
  }

  async listBotGuildIds(): Promise<Set<string>> {
    try {
      const guilds = (await this.rest.get(Routes.userGuilds())) as { id: string }[];
      return new Set(guilds.map((g) => g.id));
    } catch (e) {
      log.error("failed to list bot guilds", { error: String(e) });
      return new Set();
    }
  }

  async getBotGuildInfo(guildId: string): Promise<BotGuildInfo | null> {
    // Step 1 — is the bot a member of this guild at all?
    // A definitive "no" (Unknown Guild / Unknown Member / Missing Access)
    // returns null. Anything else (rate limit, 5xx, network) is NOT "not
    // installed": we degrade to permissions-unknown and let Discord enforce
    // at send time, instead of blocking Publish with a misleading
    // "Monarch isn't installed in this server" error.
    let me: DiscordMemberInfo;
    try {
      const botUserId = await this.getBotUserId();
      me = (await this.rest.get(Routes.guildMember(guildId, botUserId))) as DiscordMemberInfo;
    } catch (e) {
      if (isNotInGuildError(e)) {
        log.info("bot is not a member of guild", { guildId, error: String(e) });
        return null;
      }
      log.warn("could not read bot member (transient) — permissions unknown", {
        guildId,
        error: String(e),
      });
      return { id: guildId, botPermissions: null, botHighestRolePosition: 0 };
    }

    // Step 2 — compute permissions. Discord already includes the computed
    // `permissions` bitfield on the member object for bot requests; roles
    // are only needed as a fallback and for the hierarchy position, so a
    // failure here must never turn into "not installed" either.
    try {
      const roles = (await this.rest.get(Routes.guildRoles(guildId))) as DiscordRoleInfo[];
      const botPermissions = computeBotPermissions(me, roles, guildId);
      let highest = 0;
      for (const r of roles) {
        if (me.roles.includes(r.id)) highest = Math.max(highest, r.position);
      }
      return { id: guildId, botPermissions, botHighestRolePosition: highest };
    } catch (e) {
      log.warn("could not read guild roles — using member permissions only", {
        guildId,
        error: String(e),
      });
      const fromMember =
        typeof me.permissions === "string" && me.permissions.length > 0 ? me.permissions : null;
      return { id: guildId, botPermissions: fromMember, botHighestRolePosition: 0 };
    }
  }

  async getMemberCount(guildId: string): Promise<number | null> {
    try {
      const guild = (await this.rest.get(Routes.guild(guildId), {
        query: new URLSearchParams({ with_counts: "true" }),
      })) as APIGuild & { approximate_member_count?: number };
      return guild.approximate_member_count ?? null;
    } catch {
      return null;
    }
  }

  async fetchServerDesign(guildId: string): Promise<Result<ServerDesign>> {
    try {
      const guild = (await this.rest.get(Routes.guild(guildId))) as APIGuild;
      const channels = (await this.rest.get(Routes.guildChannels(guildId))) as APIChannel[];
      const roles = (await this.rest.get(Routes.guildRoles(guildId))) as {
        id: string; name: string; color: number; position: number; managed: boolean;
        hoist: boolean; mentionable: boolean; permissions: string;
      }[];

      const design = emptyServerDesign(guildId, guild.name);
      for (const raw of channels) {
        const ch = raw as APIGuildChannel<ChannelType>;
        if (ch.type === ChannelType.GuildCategory) {
          design.categories.push({ id: ch.id, name: ch.name ?? "", position: ch.position ?? 0 });
          continue;
        }
        const kind = discordTypeToChannelKind(ch.type);
        if (!kind) continue; // threads, DMs etc. — not designed by Monarch
        design.channels.push({
          id: ch.id,
          name: ch.name ?? "",
          type: kind,
          topic: (ch as { topic?: string | null }).topic ?? undefined,
          position: ch.position ?? 0,
          parentId: ch.parent_id ?? undefined,
          nsfw: (ch as { nsfw?: boolean }).nsfw,
          slowmode: (ch as { rate_limit_per_user?: number }).rate_limit_per_user || undefined,
        });
      }
      design.roles = roles
        .sort((a, b) => b.position - a.position)
        .map((r) => ({
          id: r.id,
          name: r.name,
          color: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : undefined,
          hoist: r.hoist,
          mentionable: r.mentionable,
          position: r.position,
          permissions: r.permissions,
          managed: r.managed,
        }));
      return ok(design);
    } catch (e) {
      return err(translateDiscordError(e, "read this server's structure"));
    }
  }

  async createCategory(guildId: string, payload: { name: string; position?: number }) {
    try {
      const created = (await this.rest.post(Routes.guildChannels(guildId), {
        body: { name: payload.name, type: ChannelType.GuildCategory, position: payload.position },
      })) as { id: string; name: string };
      return ok<CreatedChannel>({ id: created.id, name: created.name });
    } catch (e) {
      return err(translateDiscordError(e, `create category "${payload.name}"`));
    }
  }

  async createChannel(
    guildId: string,
    payload: { name: string; kind: string; topic?: string; parentId?: string; nsfw?: boolean; slowmode?: number; position?: number },
  ) {
    try {
      const body: Record<string, unknown> = {
        name: payload.name,
        type: channelKindToDiscordType(payload.kind as never),
        position: payload.position,
      };
      if (payload.parentId) body.parent_id = payload.parentId;
      if (payload.topic && supportsTopic(payload.kind as never)) body.topic = payload.topic;
      if (payload.nsfw !== undefined) body.nsfw = payload.nsfw;
      if (payload.slowmode) body.rate_limit_per_user = payload.slowmode;
      const created = (await this.rest.post(Routes.guildChannels(guildId), { body })) as {
        id: string; name: string;
      };
      return ok<CreatedChannel>({ id: created.id, name: created.name });
    } catch (e) {
      return err(translateDiscordError(e, `create channel "${payload.name}"`));
    }
  }

  async modifyChannel(
    _guildId: string,
    channelId: string,
    payload: { name?: string; topic?: string | null; nsfw?: boolean; slowmode?: number; parentId?: string | null; position?: number },
  ) {
    try {
      const body: Record<string, unknown> = {};
      if (payload.name !== undefined) body.name = payload.name;
      if (payload.topic !== undefined) body.topic = payload.topic;
      if (payload.nsfw !== undefined) body.nsfw = payload.nsfw;
      if (payload.slowmode !== undefined) body.rate_limit_per_user = payload.slowmode;
      if (payload.parentId !== undefined) body.parent_id = payload.parentId;
      if (payload.position !== undefined) body.position = payload.position;
      await this.rest.patch(Routes.channel(channelId), { body });
      return ok(undefined);
    } catch (e) {
      return err(translateDiscordError(e, "update this channel"));
    }
  }

  async deleteChannel(_guildId: string, channelId: string) {
    try {
      await this.rest.delete(Routes.channel(channelId));
      return ok(undefined);
    } catch (e) {
      return err(translateDiscordError(e, "delete this channel"));
    }
  }

  async sendMessage(channelId: string, payload: MessagePayload) {
    try {
      const body: Record<string, unknown> = {};
      if (payload.content) body.content = payload.content;
      if (payload.embeds && payload.embeds.length > 0) body.embeds = payload.embeds;
      if (payload.components && payload.components.length > 0) body.components = payload.components;
      const msg = (await this.rest.post(Routes.channelMessages(channelId), {
        body,
      })) as { id: string };
      return ok({ messageId: msg.id });
    } catch (e) {
      return err(translateDiscordError(e, "send this message"));
    }
  }

  /**
   * Convert a Monarch color (`#rrggbb`) to Discord's integer form.
   * Discord stores colors as the lower 24 bits of an integer (0xRRGGBB);
   * no alpha. Returns 0 for falsy values so a missing color is the
   * "no color" state, matching how the rest gateway captures roles.
   */
  private colorToInt(color: string | undefined | null): number {
    if (!color) return 0;
    const m = /^#?([0-9a-fA-F]{6})$/.exec(color);
    if (!m) return 0;
    return parseInt(m[1]!, 16);
  }

  async createRole(
    guildId: string,
    payload: { name: string; color?: string; hoist?: boolean; mentionable?: boolean; permissions?: string; position?: number },
  ) {
    try {
      const body: Record<string, unknown> = { name: payload.name };
      if (payload.color) body.color = this.colorToInt(payload.color);
      if (payload.hoist !== undefined) body.hoist = payload.hoist;
      if (payload.mentionable !== undefined) body.mentionable = payload.mentionable;
      if (payload.permissions) body.permissions = payload.permissions;
      if (payload.position !== undefined) body.position = payload.position;
      const created = (await this.rest.post(Routes.guildRoles(guildId), { body })) as { id: string; name: string };
      return ok<CreatedChannel>({ id: created.id, name: created.name });
    } catch (e) {
      return err(translateDiscordError(e, `create role "${payload.name}"`));
    }
  }

  async modifyRole(
    guildId: string,
    roleId: string,
    payload: { name?: string; color?: string | null; hoist?: boolean; mentionable?: boolean; permissions?: string; position?: number },
  ) {
    try {
      const body: Record<string, unknown> = {};
      if (payload.name !== undefined) body.name = payload.name;
      if (payload.color !== undefined) body.color = this.colorToInt(payload.color);
      if (payload.hoist !== undefined) body.hoist = payload.hoist;
      if (payload.mentionable !== undefined) body.mentionable = payload.mentionable;
      if (payload.permissions !== undefined) body.permissions = payload.permissions;
      if (payload.position !== undefined) body.position = payload.position;
      await this.rest.patch(Routes.guildRole(guildId, roleId), { body });
      return ok(undefined);
    } catch (e) {
      return err(translateDiscordError(e, `update role "${roleId}"`));
    }
  }

  async deleteRole(_guildId: string, roleId: string) {
    try {
      // The real REST route is DELETE /guilds/:id/roles/:roleId. discord-api-types
      // exposes it as `Routes.guildRole(guildId, roleId)` with method=DELETE; the
      // @discordjs/rest client accepts `Routes.x` for the path, so we hand it the
      // route plus an explicit method.
      await this.rest.delete(Routes.guildRole(_guildId, roleId));
      return ok(undefined);
    } catch (e) {
      return err(translateDiscordError(e, `delete role "${roleId}"`));
    }
  }
}
