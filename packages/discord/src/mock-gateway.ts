import type { ServerDesign } from "@monarch/schemas";
import { ok, err, monarchError, type Result } from "@monarch/shared";
import type { BotGuildInfo, CreatedChannel, DiscordGateway, UserGuild } from "./gateway.js";

/**
 * MockDiscordGateway — in-memory Discord used for demo mode and tests.
 *
 * It implements the exact same contract as RestDiscordGateway, including
 * mutations, so the full draft → diff → apply loop can be exercised
 * without credentials. State is held by a pluggable store so the dashboard
 * can persist mock guilds across restarts in dev.
 */

export interface MockState {
  guilds: Record<string, MockGuild>;
}

export interface MockGuild {
  id: string;
  name: string;
  memberCount: number;
  botInstalled: boolean;
  botPermissions: string;
  design: ServerDesign;
  /** Messages "sent" in demo mode, for test-send verification. */
  outbox: { channelId: string; content: string; at: string }[];
}

export interface MockStateStore {
  load(): Promise<MockState>;
  save(state: MockState): Promise<void>;
}

export class InMemoryMockStore implements MockStateStore {
  constructor(private state: MockState) {}
  async load() {
    return this.state;
  }
  async save(state: MockState) {
    this.state = state;
  }
}

let snowflakeCounter = 900000000000000000n;
export function mockSnowflake(): string {
  snowflakeCounter += 7n;
  return snowflakeCounter.toString();
}

export class MockDiscordGateway implements DiscordGateway {
  constructor(private store: MockStateStore) {}

  private async guild(guildId: string): Promise<MockGuild | null> {
    const state = await this.store.load();
    return state.guilds[guildId] ?? null;
  }

  private async mutate<T>(
    guildId: string,
    fn: (g: MockGuild) => T,
  ): Promise<Result<T>> {
    const state = await this.store.load();
    const g = state.guilds[guildId];
    if (!g || !g.botInstalled) {
      return err(
        monarchError("discord.not-found", "Monarch isn't installed in this server.", {
          fix: "Invite the Monarch bot to this server first.",
        }),
      );
    }
    const value = fn(g);
    await this.store.save(state);
    return ok(value);
  }

  async listBotGuildIds(): Promise<Set<string>> {
    const state = await this.store.load();
    return new Set(Object.values(state.guilds).filter((g) => g.botInstalled).map((g) => g.id));
  }

  async getBotGuildInfo(guildId: string): Promise<BotGuildInfo | null> {
    const g = await this.guild(guildId);
    if (!g || !g.botInstalled) return null;
    return { id: guildId, botPermissions: g.botPermissions, botHighestRolePosition: 90 };
  }

  async getMemberCount(guildId: string): Promise<number | null> {
    return (await this.guild(guildId))?.memberCount ?? null;
  }

  async fetchServerDesign(guildId: string): Promise<Result<ServerDesign>> {
    const g = await this.guild(guildId);
    if (!g) {
      return err(monarchError("discord.not-found", "Monarch couldn't find this server."));
    }
    // deep copy so callers can't mutate the "live" state
    return ok(structuredClone(g.design));
  }

  async createCategory(guildId: string, payload: { name: string; position?: number }) {
    return this.mutate<CreatedChannel>(guildId, (g) => {
      const id = mockSnowflake();
      g.design.categories.push({ id, name: payload.name, position: payload.position ?? g.design.categories.length });
      return { id, name: payload.name };
    });
  }

  async createChannel(
    guildId: string,
    payload: { name: string; kind: string; topic?: string; parentId?: string; nsfw?: boolean; slowmode?: number; position?: number },
  ) {
    return this.mutate<CreatedChannel>(guildId, (g) => {
      const id = mockSnowflake();
      g.design.channels.push({
        id,
        name: payload.name,
        type: payload.kind as never,
        topic: payload.topic,
        position: payload.position ?? 0,
        parentId: payload.parentId,
        nsfw: payload.nsfw,
        slowmode: payload.slowmode,
      });
      return { id, name: payload.name };
    });
  }

  async modifyChannel(
    guildId: string,
    channelId: string,
    payload: { name?: string; topic?: string | null; nsfw?: boolean; slowmode?: number; parentId?: string | null; position?: number },
  ) {
    return this.mutate<void>(guildId, (g) => {
      const cat = g.design.categories.find((c) => c.id === channelId);
      if (cat) {
        if (payload.name !== undefined) cat.name = payload.name;
        if (payload.position !== undefined) cat.position = payload.position;
        return;
      }
      const ch = g.design.channels.find((c) => c.id === channelId);
      if (!ch) throw new Error("channel missing");
      if (payload.name !== undefined) ch.name = payload.name;
      if (payload.topic !== undefined) ch.topic = payload.topic ?? undefined;
      if (payload.nsfw !== undefined) ch.nsfw = payload.nsfw;
      if (payload.slowmode !== undefined) ch.slowmode = payload.slowmode || undefined;
      if (payload.parentId !== undefined) ch.parentId = payload.parentId ?? undefined;
      if (payload.position !== undefined) ch.position = payload.position;
    });
  }

  async deleteChannel(guildId: string, channelId: string) {
    return this.mutate<void>(guildId, (g) => {
      g.design.categories = g.design.categories.filter((c) => c.id !== channelId);
      g.design.channels = g.design.channels.filter((c) => c.id !== channelId);
    });
  }

  async sendMessage(channelId: string, content: string) {
    const state = await this.store.load();
    for (const g of Object.values(state.guilds)) {
      if (g.design.channels.some((c) => c.id === channelId)) {
        g.outbox.push({ channelId, content, at: new Date().toISOString() });
        await this.store.save(state);
        return ok({ messageId: mockSnowflake() });
      }
    }
    return err(monarchError("discord.not-found", "That channel doesn't exist."));
  }

  /** Demo-mode helper: the "user guilds" a mock OAuth session would see. */
  async listUserGuilds(): Promise<UserGuild[]> {
    const state = await this.store.load();
    return Object.values(state.guilds).map((g) => ({
      id: g.id,
      name: g.name,
      icon: null,
      owner: true,
      permissions: "8", // Administrator in demo
    }));
  }
}
