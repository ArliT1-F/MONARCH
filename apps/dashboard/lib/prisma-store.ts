import type { MockState } from "@monarch/discord";
import type { ServerDesign } from "@monarch/schemas";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { getPrisma } from "./prisma";
import { decryptSecret, encryptSecret } from "./secure-token";
import type {
  AuditRecord,
  DraftRecord,
  GuildSettingsRecord,
  MonarchStore,
  SessionRecord,
  SnapshotRecord,
} from "./store";

/**
 * PrismaStore — production persistence for Monarch (PostgreSQL via Prisma).
 *
 * Implements the same MonarchStore interface as the file store; selected by
 * getStore() whenever DATABASE_URL is set. Routes never change.
 *
 * Mapping notes:
 * - Session username/avatar live on the User relation, not the session row.
 * - OAuth access tokens are stored encrypted (Session.accessTokenEnc,
 *   AES-256-GCM — see lib/secure-token.ts). Plaintext never touches disk.
 * - Guild/User rows are upserted as needed so FK targets always exist; the
 *   source of truth for guild *metadata* is Discord (or the mock gateway),
 *   the database is only persistence.
 * - DesignDraft ↔ DraftRecord, DesignVersion ↔ SnapshotRecord,
 *   GuildSettings columns ↔ the designatedChannels record.
 */

/** Mirror of the session cookie maxAge in lib/session.ts (14 days). */
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

export type SessionRow = {
  id: string;
  userId: string;
  accessTokenEnc: string | null;
  createdAt: Date;
  expiresAt: Date;
};

export type UserRow = { id: string; username: string; avatarUrl: string | null };

export type DraftRow = {
  guildId: string;
  userId: string;
  design: unknown;
  baseDesign: unknown;
  updatedAt: Date;
};

export type SnapshotRow = {
  id: string;
  guildId: string;
  name: string;
  kind: string;
  design: unknown;
  createdAt: Date;
};

export type GuildSettingsRow = {
  guildId: string;
  welcomeChannelId: string | null;
  announcementsChannelId: string | null;
  testingChannelId: string | null;
  templateTestingChannelId: string | null;
};

export type AuditRow = {
  id: string;
  guildId: string;
  userId: string;
  action: string;
  summary: string;
  createdAt: Date;
};

// ── row ↔ record mappers (pure; unit-tested without a database) ──────

export function sessionRowToRecord(
  session: SessionRow,
  user: UserRow,
): SessionRecord {
  const accessToken = decryptSecret(session.accessTokenEnc);
  const record: SessionRecord = {
    id: session.id,
    userId: session.userId,
    username: user.username,
    avatarUrl: user.avatarUrl,
    createdAt: session.createdAt.toISOString(),
  };
  if (accessToken) record.accessToken = accessToken;
  return record;
}

export function draftRowToRecord(row: DraftRow): DraftRecord {
  return {
    guildId: row.guildId,
    design: row.design as ServerDesign,
    baseDesign: row.baseDesign as ServerDesign,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function snapshotRowToRecord(row: SnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    kind: row.kind as SnapshotRecord["kind"],
    design: row.design as ServerDesign,
    createdAt: row.createdAt.toISOString(),
  };
}

export function settingsRowToRecord(row: GuildSettingsRow | null): GuildSettingsRecord {
  if (!row) return { guildId: "", designatedChannels: {} };
  const designatedChannels: Record<string, string | undefined> = {};
  if (row.welcomeChannelId) designatedChannels.welcome = row.welcomeChannelId;
  if (row.announcementsChannelId) designatedChannels.announcements = row.announcementsChannelId;
  if (row.testingChannelId) designatedChannels.testing = row.testingChannelId;
  if (row.templateTestingChannelId) designatedChannels.templateTesting = row.templateTestingChannelId;
  return { guildId: row.guildId, designatedChannels };
}

export function designatedChannelsToColumns(designatedChannels: Record<string, string | undefined>) {
  return {
    welcomeChannelId: designatedChannels.welcome ?? null,
    announcementsChannelId: designatedChannels.announcements ?? null,
    testingChannelId: designatedChannels.testing ?? null,
    templateTestingChannelId: designatedChannels.templateTesting ?? null,
  };
}

export function auditRowToRecord(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    userId: row.userId,
    action: row.action,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── PrismaStore ──────────────────────────────────────────────────────

export class PrismaStore implements MonarchStore {
  private db: PrismaClient;

  constructor(db: PrismaClient = getPrisma()) {
    this.db = db;
  }

  /** FK targets must exist before dependent rows can reference them. */
  private async ensureUser(user: { id: string; username: string; avatarUrl: string | null }) {
    await this.db.user.upsert({
      where: { id: user.id },
      create: user,
      update: { username: user.username, avatarUrl: user.avatarUrl },
    });
  }

  private async ensureGuild(guildId: string, name = "") {
    await this.db.guild.upsert({
      where: { id: guildId },
      create: { id: guildId, name },
      update: name ? { name } : {},
    });
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const row = await this.db.session.findUnique({ where: { id }, include: { user: true } });
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.db.session.delete({ where: { id } }).catch(() => {});
      return null;
    }
    return sessionRowToRecord(row, row.user);
  }

  async putSession(session: SessionRecord): Promise<void> {
    await this.ensureUser({
      id: session.userId,
      username: session.username,
      avatarUrl: session.avatarUrl ?? null,
    });
    const createdAt = new Date(session.createdAt);
    const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
    await this.db.session.upsert({
      where: { id: session.id },
      create: {
        id: session.id,
        userId: session.userId,
        accessTokenEnc: session.accessToken ? encryptSecret(session.accessToken) : null,
        createdAt,
        expiresAt,
      },
      update: {
        userId: session.userId,
        accessTokenEnc: session.accessToken ? encryptSecret(session.accessToken) : null,
        expiresAt,
      },
    });
  }

  async deleteSession(id: string): Promise<void> {
    await this.db.session.delete({ where: { id } }).catch(() => {});
  }

  async getDraft(guildId: string, userId: string): Promise<DraftRecord | null> {
    const row = await this.db.designDraft.findUnique({
      where: { guildId_userId: { guildId, userId } },
    });
    return row ? draftRowToRecord(row) : null;
  }

  async putDraft(userId: string, draft: DraftRecord): Promise<void> {
    await this.ensureGuild(draft.guildId);
    await this.ensureUser({ id: userId, username: "unknown", avatarUrl: null });
    await this.db.designDraft.upsert({
      where: { guildId_userId: { guildId: draft.guildId, userId } },
      create: {
        guildId: draft.guildId,
        userId,
        design: draft.design as object,
        baseDesign: draft.baseDesign as object,
        updatedAt: new Date(draft.updatedAt),
      },
      update: {
        design: draft.design as object,
        baseDesign: draft.baseDesign as object,
        updatedAt: new Date(draft.updatedAt),
      },
    });
  }

  async deleteDraft(guildId: string, userId: string): Promise<void> {
    await this.db.designDraft.delete({ where: { guildId_userId: { guildId, userId } } }).catch(() => {});
  }

  async listSnapshots(guildId: string): Promise<SnapshotRecord[]> {
    const rows = await this.db.designVersion.findMany({
      where: { guildId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(snapshotRowToRecord);
  }

  async addSnapshot(snapshot: SnapshotRecord): Promise<void> {
    await this.ensureGuild(snapshot.guildId);
    await this.db.designVersion.create({
      data: {
        id: snapshot.id,
        guildId: snapshot.guildId,
        name: snapshot.name,
        kind: snapshot.kind,
        design: snapshot.design as object,
        createdAt: new Date(snapshot.createdAt),
      },
    });
  }

  async getGuildSettings(guildId: string): Promise<GuildSettingsRecord> {
    const row = await this.db.guildSettings.findUnique({ where: { guildId } });
    if (!row) return { guildId, designatedChannels: {} };
    return settingsRowToRecord(row);
  }

  async putGuildSettings(settings: GuildSettingsRecord): Promise<void> {
    await this.ensureGuild(settings.guildId);
    const columns = designatedChannelsToColumns(settings.designatedChannels);
    await this.db.guildSettings.upsert({
      where: { guildId: settings.guildId },
      create: { guildId: settings.guildId, ...columns },
      update: columns,
    });
  }

  async addAudit(entry: AuditRecord): Promise<void> {
    await this.ensureGuild(entry.guildId);
    await this.ensureUser({ id: entry.userId, username: "unknown", avatarUrl: null });
    await this.db.auditEntry.create({
      data: {
        id: entry.id,
        guildId: entry.guildId,
        userId: entry.userId,
        action: entry.action,
        summary: entry.summary,
        createdAt: new Date(entry.createdAt),
      },
    });
  }

  async listAudit(guildId: string, limit = 50): Promise<AuditRecord[]> {
    const rows = await this.db.auditEntry.findMany({
      where: { guildId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(auditRowToRecord);
  }

  async getMockState(): Promise<MockState | null> {
    const row = await this.db.mockDiscordState.findUnique({ where: { id: "singleton" } });
    return row ? (row.state as unknown as MockState) : null;
  }

  async putMockState(state: MockState): Promise<void> {
    await this.db.mockDiscordState.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", state: state as object },
      update: { state: state as object },
    });
  }
}
