import {
  MockDiscordGateway,
  RestDiscordGateway,
  buildGuildSummaries,
  type DiscordGateway,
  type MockState,
  type MockStateStore,
  type UserGuild,
} from "@monarch/discord";
import { emptyServerDesign, type GuildSummary, type ServerDesign } from "@monarch/schemas";
import { canDesignGuild, createLogger } from "@monarch/shared";
import { env, isDemoMode } from "./env";
import { getStore, type SessionRecord } from "./store";

const log = createLogger("dashboard.discord");

/**
 * Gateway wiring: picks the real REST gateway or the mock gateway.
 * Everything above this file only sees the DiscordGateway interface.
 */

class StoreBackedMockStore implements MockStateStore {
  async load(): Promise<MockState> {
    const existing = await getStore().getMockState();
    if (existing) return existing;
    const seeded = seedMockState();
    await getStore().putMockState(seeded);
    return seeded;
  }
  async save(state: MockState): Promise<void> {
    await getStore().putMockState(state);
  }
}

let gateway: DiscordGateway | null = null;
let mockGateway: MockDiscordGateway | null = null;

export function getGateway(): DiscordGateway {
  if (gateway) return gateway;
  if (isDemoMode()) {
    mockGateway = new MockDiscordGateway(new StoreBackedMockStore());
    gateway = mockGateway;
    log.info("running with MockDiscordGateway (demo mode)");
  } else {
    gateway = new RestDiscordGateway(env.discordBotToken);
    log.info("running with RestDiscordGateway");
  }
  return gateway;
}

function getMockGateway(): MockDiscordGateway {
  getGateway();
  if (!mockGateway) throw new Error("mock gateway only exists in demo mode");
  return mockGateway;
}

// ── user guilds ──────────────────────────────────────────────────────

export async function fetchUserGuilds(session: SessionRecord): Promise<UserGuild[]> {
  if (isDemoMode()) return getMockGateway().listUserGuilds();
  const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  if (!res.ok) {
    log.warn("failed to fetch user guilds", { status: res.status });
    return [];
  }
  return (await res.json()) as UserGuild[];
}

export async function listGuildSummaries(session: SessionRecord): Promise<GuildSummary[]> {
  const gw = getGateway();
  const [userGuilds, botGuildIds] = await Promise.all([
    fetchUserGuilds(session),
    gw.listBotGuildIds(),
  ]);
  const extras = new Map<string, { memberCount: number | null; botPermissions: string | null }>();
  await Promise.all(
    userGuilds.map(async (g) => {
      if (!botGuildIds.has(g.id)) {
        extras.set(g.id, { memberCount: null, botPermissions: null });
        return;
      }
      const [memberCount, info] = await Promise.all([
        gw.getMemberCount(g.id),
        gw.getBotGuildInfo(g.id),
      ]);
      extras.set(g.id, { memberCount, botPermissions: info?.botPermissions ?? null });
    }),
  );
  return buildGuildSummaries(userGuilds, botGuildIds, extras, canDesignGuild);
}

export async function getGuildSummary(
  session: SessionRecord,
  guildId: string,
): Promise<GuildSummary | null> {
  const all = await listGuildSummaries(session);
  return all.find((g) => g.id === guildId) ?? null;
}

/**
 * Current design as Discord sees it, merged with Monarch's stored guild
 * settings (designated channels live in Monarch, not Discord).
 */
export async function fetchCurrentDesign(guildId: string): Promise<ServerDesign | null> {
  const res = await getGateway().fetchServerDesign(guildId);
  if (!res.ok) return null;
  const settings = await getStore().getGuildSettings(guildId);
  res.value.designatedChannels = settings.designatedChannels;
  return res.value;
}

// ── demo seed ────────────────────────────────────────────────────────

function seedMockState(): MockState {
  const nebula = emptyServerDesign("100000000000000001", "Nebula Community");
  nebula.categories = [
    { id: "201", name: "INFORMATION", position: 0 },
    { id: "202", name: "COMMUNITY", position: 1 },
    { id: "203", name: "VOICE", position: 2 },
  ];
  nebula.channels = [
    { id: "301", name: "welcome", type: "text", position: 0, parentId: "201", topic: "Start here — say hi!" },
    { id: "302", name: "rules", type: "text", position: 1, parentId: "201", topic: "Read before posting." },
    { id: "303", name: "announcements", type: "announcement", position: 2, parentId: "201" },
    { id: "304", name: "general", type: "text", position: 0, parentId: "202", topic: "Daily chatter" },
    { id: "305", name: "media", type: "text", position: 1, parentId: "202" },
    { id: "306", name: "off-topic", type: "text", position: 2, parentId: "202", slowmode: 5 },
    { id: "307", name: "General", type: "voice", position: 0, parentId: "203" },
    { id: "308", name: "Gaming", type: "voice", position: 1, parentId: "203" },
  ];
  nebula.roles = [
    { id: "401", name: "Owner", color: "#e8b64c", position: 5 },
    { id: "402", name: "Admin", color: "#eb4d4b", position: 4 },
    { id: "403", name: "Moderator", color: "#5865f2", position: 3 },
    { id: "404", name: "VIP", color: "#9b59b6", position: 2 },
    { id: "405", name: "Member", color: "#95a5a6", position: 1 },
  ];

  const arcade = emptyServerDesign("100000000000000002", "Pixel Arcade");
  arcade.categories = [{ id: "211", name: "ARCADE", position: 0 }];
  arcade.channels = [
    { id: "311", name: "lobby", type: "text", position: 0, parentId: "211" },
    { id: "312", name: "highscores", type: "text", position: 1, parentId: "211" },
    { id: "313", name: "Game Night", type: "voice", position: 2, parentId: "211" },
  ];

  const lounge = emptyServerDesign("100000000000000003", "Design Lounge");
  lounge.channels = [{ id: "321", name: "general", type: "text", position: 0 }];

  return {
    guilds: {
      [nebula.guildId]: {
        id: nebula.guildId,
        name: nebula.name,
        memberCount: 12482,
        botInstalled: true,
        botPermissions: "8",
        design: nebula,
        outbox: [],
      },
      [arcade.guildId]: {
        id: arcade.guildId,
        name: arcade.name,
        memberCount: 4821,
        botInstalled: true,
        botPermissions: "268445776",
        design: arcade,
        outbox: [],
      },
      [lounge.guildId]: {
        id: lounge.guildId,
        name: lounge.name,
        memberCount: 96,
        botInstalled: false,
        botPermissions: "0",
        design: lounge,
        outbox: [],
      },
    },
  };
}
