import { promises as fs } from "node:fs";
import path from "node:path";
import type { EmbedDesign, MessageDesign, ServerDesign } from "@monarch/schemas";
import type { MockState } from "@monarch/discord";
import { CONFESSION_COOLDOWN_MS } from "@monarch/shared";
import { env } from "./env";
import { PrismaStore } from "./prisma-store";
import { snapshotIdsToPrune } from "./retention";

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

/**
 * Confession channels for a guild. `channelId` = where anonymous confession
 * embeds are posted (null = confessions off); `logChannelId` = the optional
 * staff-only channel that receives a full "who/when/link" entry for every
 * confession (null = fully anonymous, no logs).
 */
export interface ConfessionChannelRecord {
  guildId: string;
  channelId: string | null;
  logChannelId: string | null;
}

/**
 * Confession cooldown for one Discord user — **global across every server**
 * (confessing in server A is what makes you wait in server B).
 * `nextAllowedAt` (ISO-8601) is the earliest moment they may confess again;
 * null means they are free right now.
 */
export interface ConfessionCooldownRecord {
  userId: string;
  nextAllowedAt: string | null;
}

/**
 * Answer to "may this person confess now?". Exactly one of several
 * concurrent claims wins; the loser gets the winner's `nextAllowedAt` so the
 * bot can tell them when they are back instead of guessing.
 */
export type ConfessionCooldownClaim =
  { claimed: true; nextAllowedAt: string } | { claimed: false; nextAllowedAt: string };

/** How a caller may override the confession window (tests; the route never does). */
export interface ConfessionCooldownWindow {
  /** Defaults to CONFESSION_COOLDOWN_MS (6h) from @monarch/shared. */
  windowMs?: number;
  /** Defaults to the current time. */
  now?: Date;
}

export interface AuditRecord {
  id: string;
  guildId: string;
  userId: string;
  action: string;
  summary: string;
  createdAt: string;
}

/**
 * Per-guild autosaved content designs (Embed Builder / Message Designer).
 * Design-time values keep {variable} placeholders; they are only resolved
 * at send time.
 */
export interface GuildWorkspaceRecord {
  guildId: string;
  embed: EmbedDesign | null;
  message: MessageDesign | null;
  updatedAt: string;
}

/**
 * A saved template in a user's library (FEATURE 7). The envelope columns
 * (type/format) are split from the portable design payload so a download
 * can rebuild a valid `monarch-template` envelope, exactly as exported.
 * `data` never contains live snowflakes (id-detached on save).
 */
export interface TemplateRecord {
  id: string;
  /** Discord user id of the library owner — always scoped by it on read. */
  ownerId: string;
  name: string;
  /** Envelope type, e.g. "server". Future: "embed" | "message". */
  type: string;
  /** Template format version (envelope `version`). */
  format: number;
  /** Portable design payload (envelope `data`). */
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MonarchStore {
  getSession(id: string): Promise<SessionRecord | null>;
  putSession(session: SessionRecord): Promise<void>;
  deleteSession(id: string): Promise<void>;

  getDraft(guildId: string, userId: string): Promise<DraftRecord | null>;
  putDraft(userId: string, draft: DraftRecord): Promise<void>;
  deleteDraft(guildId: string, userId: string): Promise<void>;

  listSnapshots(guildId: string): Promise<SnapshotRecord[]>;
  /** Scoped by guild so a snapshot id from another server can never be restored. */
  getSnapshot(guildId: string, id: string): Promise<SnapshotRecord | null>;
  /**
   * Store one snapshot and enforce retention (lib/retention.ts): manual
   * backups are kept forever, the automatic `pre-apply` / `post-apply` pair
   * written by every apply is capped per kind. Implementations must prune
   * inside the same call, so no caller can accidentally store without a cap.
   */
  addSnapshot(snapshot: SnapshotRecord): Promise<void>;

  getGuildSettings(guildId: string): Promise<GuildSettingsRecord>;
  putGuildSettings(settings: GuildSettingsRecord): Promise<void>;

  addAudit(entry: AuditRecord): Promise<void>;
  listAudit(guildId: string, limit?: number): Promise<AuditRecord[]>;

  getWorkspace(guildId: string): Promise<GuildWorkspaceRecord>;
  putWorkspace(workspace: GuildWorkspaceRecord): Promise<void>;

  /**
   * Design Analyzer "mark as intentional" list (FEATURE 9), per guild.
   * Kept separate from GuildSettingsRecord so the designated-channels
   * form can never clobber it and vice versa.
   */
  getAnalyzerDismissals(guildId: string): Promise<string[]>;
  putAnalyzerDismissals(guildId: string, checkIds: string[]): Promise<void>;

  /**
   * Prefix commands: this guild's text-command prefix, or null for the
   * shared default (DEFAULT_COMMAND_PREFIX in @monarch/shared). Written by
   * the bot (`!prefix set …`) through the internal API — kept out of
   * GuildSettingsRecord so the designated-channels form can't clobber it.
   */
  getCommandPrefix(guildId: string): Promise<string | null>;
  putCommandPrefix(guildId: string, prefix: string | null): Promise<void>;

  /**
   * Confessions: this guild's anonymous confession channel (null = the
   * feature is off) and its optional staff-only log channel (null = no
   * logs). Written by the bot (`/monarch confession setup`) through the
   * internal API — kept out of GuildSettingsRecord so the designated-
   * channels form can't clobber it (same rule as the command prefix).
   */
  getConfessionChannels(guildId: string): Promise<ConfessionChannelRecord>;
  putConfessionChannels(guildId: string, channels: ConfessionChannelRecord): Promise<void>;

  /**
   * Confession cooldowns — keyed by Discord **user**, not guild, because the
   * window is global: one confession per person per `CONFESSION_COOLDOWN_MS`
   * (6h) across every server. `claim` is a compare-and-set (two submissions
   * racing for the same person produce exactly one winner) and `release`
   * hands the window back, which the bot uses when posting the confession
   * failed — a deleted channel must not lock somebody out for six hours.
   */
  getConfessionCooldown(userId: string): Promise<ConfessionCooldownRecord>;
  claimConfessionCooldown(
    userId: string,
    window?: ConfessionCooldownWindow,
  ): Promise<ConfessionCooldownClaim>;
  releaseConfessionCooldown(userId: string): Promise<void>;

  /**
   * Template library (FEATURE 7). Every read is scoped by ownerId so one
   * user can never list, fetch, overwrite or delete another user's files.
   */
  listTemplates(ownerId: string): Promise<TemplateRecord[]>;
  getTemplate(ownerId: string, id: string): Promise<TemplateRecord | null>;
  putTemplate(template: TemplateRecord): Promise<void>;
  deleteTemplate(ownerId: string, id: string): Promise<void>;

  /** Demo-mode mock Discord state (unused in production). */
  getMockState(): Promise<MockState | null>;
  putMockState(state: MockState): Promise<void>;
}

// ── File store implementation ────────────────────────────────────────

/** Override with MONARCH_DATA_DIR (tests point it at a temp directory). */
const DATA_DIR =
  process.env.MONARCH_DATA_DIR ?? path.join(process.cwd(), "..", "..", ".monarch-data");

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

// ── confession cooldowns (file store) ────────────────────────────────

/** userId → ISO `nextAllowedAt`. Global per user: the file has no guilds in it. */
const COOLDOWN_FILE = "confession-cooldowns.json";

async function readCooldowns(): Promise<Record<string, string>> {
  const all = await readJson<Record<string, string>>(COOLDOWN_FILE);
  // A hand-edited or half-written file degrades to "nobody is cooling down"
  // rather than throwing — the bot fails open on this by design.
  return all && typeof all === "object" && !Array.isArray(all) ? all : {};
}

/**
 * Write back with the expired windows dropped, so the file cant grow forever
 * (every confessor ever would otherwise leave a row behind).
 */
async function writeCooldowns(all: Record<string, string>, now: Date): Promise<void> {
  const live: Record<string, string> = {};
  for (const [userId, until] of Object.entries(all)) {
    const at = Date.parse(until);
    if (Number.isFinite(at) && at > now.getTime()) live[userId] = until;
  }
  await writeJson(COOLDOWN_FILE, live);
}

/** The stored window for a user, or null when it is missing/expired/malformed. */
function liveCooldown(all: Record<string, string>, userId: string, now: Date): string | null {
  const until = all[userId];
  if (typeof until !== "string") return null;
  const at = Date.parse(until);
  return Number.isFinite(at) && at > now.getTime() ? until : null;
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
    return all
      .filter((s) => s.guildId === guildId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getSnapshot(guildId: string, id: string) {
    const all = (await readJson<SnapshotRecord[]>("snapshots.json")) ?? [];
    return all.find((s) => s.id === id && s.guildId === guildId) ?? null;
  }
  async addSnapshot(snapshot: SnapshotRecord) {
    const all = (await readJson<SnapshotRecord[]>("snapshots.json")) ?? [];
    all.push(snapshot);
    // Retention runs here, not in the callers, so every writer is covered —
    // and the whole rewrite it prevents is exactly why the cap exists.
    const doomed = new Set(snapshotIdsToPrune(all.filter((s) => s.guildId === snapshot.guildId)));
    await writeJson(
      "snapshots.json",
      doomed.size === 0 ? all : all.filter((s) => !doomed.has(s.id)),
    );
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

  async getWorkspace(guildId: string) {
    const all = (await readJson<Record<string, GuildWorkspaceRecord>>("workspace.json")) ?? {};
    return (
      all[guildId] ?? {
        guildId,
        embed: null,
        message: null,
        updatedAt: new Date().toISOString(),
      }
    );
  }
  async putWorkspace(workspace: GuildWorkspaceRecord) {
    const all = (await readJson<Record<string, GuildWorkspaceRecord>>("workspace.json")) ?? {};
    all[workspace.guildId] = workspace;
    await writeJson("workspace.json", all);
  }

  async getAnalyzerDismissals(guildId: string) {
    const all = (await readJson<Record<string, string[]>>("analyzer-dismissals.json")) ?? {};
    return all[guildId] ?? [];
  }
  async putAnalyzerDismissals(guildId: string, checkIds: string[]) {
    const all = (await readJson<Record<string, string[]>>("analyzer-dismissals.json")) ?? {};
    if (checkIds.length === 0) delete all[guildId];
    else all[guildId] = [...new Set(checkIds)];
    await writeJson("analyzer-dismissals.json", all);
  }

  async getCommandPrefix(guildId: string) {
    const all = (await readJson<Record<string, string>>("command-prefixes.json")) ?? {};
    return all[guildId] ?? null;
  }
  async putCommandPrefix(guildId: string, prefix: string | null) {
    const all = (await readJson<Record<string, string>>("command-prefixes.json")) ?? {};
    if (prefix === null) delete all[guildId];
    else all[guildId] = prefix;
    await writeJson("command-prefixes.json", all);
  }

  async getConfessionChannels(guildId: string): Promise<ConfessionChannelRecord> {
    const all =
      (await readJson<Record<string, { channelId?: string; logChannelId?: string }>>(
        "confession-channels.json",
      )) ?? {};
    const row = all[guildId];
    return {
      guildId,
      channelId: typeof row?.channelId === "string" ? row.channelId : null,
      logChannelId: typeof row?.logChannelId === "string" ? row.logChannelId : null,
    };
  }
  async putConfessionChannels(guildId: string, channels: ConfessionChannelRecord): Promise<void> {
    const all =
      (await readJson<Record<string, { channelId?: string; logChannelId?: string }>>(
        "confession-channels.json",
      )) ?? {};
    if (channels.channelId === null && channels.logChannelId === null) {
      delete all[guildId];
    } else {
      all[guildId] = {
        channelId: channels.channelId ?? undefined,
        logChannelId: channels.logChannelId ?? undefined,
      };
    }
    await writeJson("confession-channels.json", all);
  }

  // Confession cooldowns: keyed by user id, so one file covers every server.
  // Read-modify-write is serialized per file by writeJson's queue; the JSON
  // store is dev/demo only, so that is as much atomicity as it needs (the
  // PrismaStore below does a real compare-and-set).
  async getConfessionCooldown(userId: string): Promise<ConfessionCooldownRecord> {
    const all = await readCooldowns();
    return { userId, nextAllowedAt: liveCooldown(all, userId, new Date()) };
  }
  async claimConfessionCooldown(
    userId: string,
    window: ConfessionCooldownWindow = {},
  ): Promise<ConfessionCooldownClaim> {
    const now = window.now ?? new Date();
    const windowMs = window.windowMs ?? CONFESSION_COOLDOWN_MS;
    const all = await readCooldowns();
    const existing = liveCooldown(all, userId, now);
    if (existing) return { claimed: false, nextAllowedAt: existing };
    const nextAllowedAt = new Date(now.getTime() + windowMs).toISOString();
    all[userId] = nextAllowedAt;
    await writeCooldowns(all, now);
    return { claimed: true, nextAllowedAt };
  }
  async releaseConfessionCooldown(userId: string): Promise<void> {
    const all = await readCooldowns();
    if (!(userId in all)) return;
    delete all[userId];
    await writeCooldowns(all, new Date());
  }

  async listTemplates(ownerId: string) {
    const all = (await readJson<Record<string, TemplateRecord>>("templates.json")) ?? {};
    return Object.values(all)
      .filter((t) => t.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getTemplate(ownerId: string, id: string) {
    const all = (await readJson<Record<string, TemplateRecord>>("templates.json")) ?? {};
    const t = all[id];
    return t && t.ownerId === ownerId ? t : null;
  }
  async putTemplate(template: TemplateRecord) {
    const all = (await readJson<Record<string, TemplateRecord>>("templates.json")) ?? {};
    // Ownership is immutable: an id that already belongs to someone else
    // must never be overwritten (mirrors the PrismaStore owner-scoped
    // update). Reaching this is a programming error — fail loudly.
    const existing = all[template.id];
    if (existing && existing.ownerId !== template.ownerId) {
      throw new Error(`template ${template.id} belongs to a different owner`);
    }
    all[template.id] = template;
    await writeJson("templates.json", all);
  }
  async deleteTemplate(ownerId: string, id: string) {
    const all = (await readJson<Record<string, TemplateRecord>>("templates.json")) ?? {};
    const t = all[id];
    if (t && t.ownerId === ownerId) delete all[id];
    await writeJson("templates.json", all);
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
