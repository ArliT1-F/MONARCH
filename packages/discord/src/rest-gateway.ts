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
import type { BotGuildInfo, CreatedChannel, DiscordGateway } from "./gateway.js";
import { translateDiscordError } from "./errors.js";

const log = createLogger("discord.rest");

/**
 * Real Discord gateway using the bot token via @discordjs/rest
 * (which handles rate limiting and retries — Monarch never hardcodes
 * rate-limit values).
 */
export class RestDiscordGateway implements DiscordGateway {
  private rest: REST;

  constructor(botToken: string) {
    this.rest = new REST({ version: "10" }).setToken(botToken);
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
    try {
      const me = (await this.rest.get(Routes.userGuildMember(guildId))) as {
        roles: string[];
      };
      const roles = (await this.rest.get(Routes.guildRoles(guildId))) as {
        id: string;
        position: number;
        permissions: string;
      }[];
      const myRoles = roles.filter((r) => me.roles.includes(r.id));
      let permissions = 0n;
      let highest = 0;
      for (const r of myRoles) {
        permissions |= BigInt(r.permissions);
        highest = Math.max(highest, r.position);
      }
      const everyone = roles.find((r) => r.id === guildId);
      if (everyone) permissions |= BigInt(everyone.permissions);
      return { id: guildId, botPermissions: permissions.toString(), botHighestRolePosition: highest };
    } catch (e) {
      log.warn("failed to get bot guild info", { guildId, error: String(e) });
      return null;
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

  async sendMessage(channelId: string, content: string) {
    try {
      const msg = (await this.rest.post(Routes.channelMessages(channelId), {
        body: { content },
      })) as { id: string };
      return ok({ messageId: msg.id });
    } catch (e) {
      return err(translateDiscordError(e, "send this message"));
    }
  }
}
