import { promises as fs } from "node:fs";
import path from "node:path";
import type { ServerDesign } from "@monarch/schemas";
import type { MockState } from "@monarch/discord";
import { env } from "./env";
import { PrismaStore } from "./prisma-store";

/**
 * Monarch persistence layer.
 *
 * Interface first: routes talk to `MonarchStore`, never to a concrete
 * backend. Two implementations:
 *
 * - PrismaStore (PostgreSQL, apps/dashboard/lib/prisma-store.ts) — used
 *   whenever DATABASE_URL is set. This is the production target and what
 *   runs on Vercel.
 * - FileStore — a JSON file store rooted at .monarch-data/, used when no
 *   DATABASE_URL is configured. Development/demo only.
 *
 * The swap happens here only; routes never change.
 */

export interface SessionRecord {
  id: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  /** Discord OAuth access token (absent in demo mode). Server-side only. */
  accessToken?: string;
  createdAt: string;
}

export interface DraftRecord {
  guildId: string;
  design: ServerDesign;
  /** Design captured from Discord when the draft was created (diff base). */
  baseDesign: ServerDesign;
  updatedAt: string;
}

export interface SnapshotRecord {
  id: string;
  guildId: string;
  name: string;
  kind: "manual" | "pre-apply" | "post-apply";
  design: ServerDesign;
  createdAt: string;
}

export interface GuildSettingsRecord {
  guildId: string;
  designatedChannels: Record<string, string | undefined>;
}

export interface AuditRecord {
  id: string;
  guildId: string;
  userId: string;
  action: string;
  summary: string;
  createdAt: string;
}

export interface MonarchStore {
  getSession(id: string): Promise<SessionRecord | null>;
  putSession(session: SessionRecord): Promise<void>;
  deleteSession(id: string): Promise<void>;

  getDraft(guildId: string, userId: string): Promise<DraftRecord | null>;
  putDraft(userId: string, draft: DraftRecord): Promise<void>;
  deleteDraft(guildId: string, userId: string): Promise<void>;

  listSnapshots(guildId: string): Promise<SnapshotRecord[]>;
  addSnapshot(snapshot: SnapshotRecord): Promise<void>;

  getGuildSettings(guildId: string): Promise<GuildSettingsRecord>;
  putGuildSettings(settings: GuildSettingsRecord): Promise<void>;

  addAudit(entry: AuditRecord): Promise<void>;
  listAudit(guildId: string, limit?: number): Promise<AuditRecord[]>;

  /** Demo-mode mock Discord state (unused in production). */
  getMockState(): Promise<MockState | null>;
  putMockState(state: MockState): Promise<void>;
}

// ── File store implementation ────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), "..", "..", ".monarch-data");

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, file), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const writeQueues = new Map<string, Promise<void>>();

async function writeJson(file: string, data: unknown): Promise<void> {
  // Serialize writes per file and use a unique tmp name — route handlers can
  // hit the store concurrently (multiple compiled bundles share the FS).
  const prev = writeQueues.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const target = path.join(DATA_DIR, file);
      const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      await fs.rename(tmp, target);
    });
  writeQueues.set(file, next);
  return next;
}

class FileStore implements MonarchStore {
  async getSession(id: string) {
    const all = (await readJson<Record<string, SessionRecord>>("sessions.json")) ?? {};
    return all[id] ?? null;
  }
  async putSession(session: SessionRecord) {
    const all = (await readJson<Record<string, SessionRecord>>("sessions.json")) ?? {};
    all[session.id] = session;
    await writeJson("sessions.json", all);
  }
  async deleteSession(id: string) {
    const all = (await readJson<Record<string, SessionRecord>>("sessions.json")) ?? {};
    delete all[id];
    await writeJson("sessions.json", all);
  }

  private draftKey(guildId: string, userId: string) {
    return `${guildId}:${userId}`;
  }
  async getDraft(guildId: string, userId: string) {
    const all = (await readJson<Record<string, DraftRecord>>("drafts.json")) ?? {};
    return all[this.draftKey(guildId, userId)] ?? null;
  }
  async putDraft(userId: string, draft: DraftRecord) {
    const all = (await readJson<Record<string, DraftRecord>>("drafts.json")) ?? {};
    all[this.draftKey(draft.guildId, userId)] = draft;
    await writeJson("drafts.json", all);
  }
  async deleteDraft(guildId: string, userId: string) {
    const all = (await readJson<Record<string, DraftRecord>>("drafts.json")) ?? {};
    delete all[this.draftKey(guildId, userId)];
    await writeJson("drafts.json", all);
  }

  async listSnapshots(guildId: string) {
    const all = (await readJson<SnapshotRecord[]>("snapshots.json")) ?? [];
    return all.filter((s) => s.guildId === guildId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async addSnapshot(snapshot: SnapshotRecord) {
    const all = (await readJson<SnapshotRecord[]>("snapshots.json")) ?? [];
    all.push(snapshot);
    await writeJson("snapshots.json", all);
  }

  async getGuildSettings(guildId: string) {
    const all = (await readJson<Record<string, GuildSettingsRecord>>("guild-settings.json")) ?? {};
    return all[guildId] ?? { guildId, designatedChannels: {} };
  }
  async putGuildSettings(settings: GuildSettingsRecord) {
    const all = (await readJson<Record<string, GuildSettingsRecord>>("guild-settings.json")) ?? {};
    all[settings.guildId] = settings;
    await writeJson("guild-settings.json", all);
  }

  async addAudit(entry: AuditRecord) {
    const all = (await readJson<AuditRecord[]>("audit.json")) ?? [];
    all.push(entry);
    await writeJson("audit.json", all.slice(-2000));
  }
  async listAudit(guildId: string, limit = 50) {
    const all = (await readJson<AuditRecord[]>("audit.json")) ?? [];
    return all
      .filter((a) => a.guildId === guildId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async getMockState() {
    return readJson<MockState>("mock-discord.json");
  }
  async putMockState(state: MockState) {
    await writeJson("mock-discord.json", state);
  }
}

/**
 * The JSON file store is local-only. It writes under .monarch-data next to
 * the process, so on Vercel/serverless (read-only, ephemeral filesystem) it
 * fails with ENOENT when a route first does `mkdir`. Detect that environment
 * and fail fast with a config error instead of silently falling back.
 */
function isServerlessRuntime(): boolean {
  return process.env.VERCEL === "1" || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
}

let storeSingleton: MonarchStore | null = null;

export function getStore(): MonarchStore {
  if (!storeSingleton) {
    if (env.databaseUrl) {
      storeSingleton = new PrismaStore();
    } else if (isServerlessRuntime()) {
      throw new Error(
        "DATABASE_URL is not set. Monarch's file store is not supported on Vercel/serverless; " +
          "configure a Postgres database (see docs/deploying-vercel.md).",
      );
    } else {
      storeSingleton = new FileStore();
    }
  }
  return storeSingleton;
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
