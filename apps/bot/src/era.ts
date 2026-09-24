import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandFile } from "./context.js";

/**
 * `!era` — a hidden easter egg, not a Monarch feature.
 *
 * It is prefix-only, absent from the command catalog (so `!help`, `/monarch
 * help` and the dashboard Help page cannot mention it), and it answers only
 * the server owner and the bot owner (`MONARCH_OWNER_USER_ID`). Everyone else
 * gets silence, the same as an unknown `!word`, so guessing the name doesn't
 * confirm it exists.
 *
 * `!era zhvishu` posts as a fixed Discord user (name + avatar, via a webhook):
 * one saved line, picked at random, then a random image from `era_img/`. The
 * line is stored as typed and sent as `<message> @invoker`. Lines live in
 * `era_img/messages.json`, per server, so one server's owner can't plant a
 * line that pings people in another server. Photos are the shared folder.
 */

/** The account `!era zhvishu` posts as — name and avatar, not the bot's. */
export const ERA_PERSONA_USER_ID = "1484616497568550985";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** A saved line plus the invoker mention has to fit in one Discord message. */
export const ERA_MESSAGE_MAX_LENGTH = 500;
/** Cap so `!era messages` stays readable and a typo can't fill the disk. */
export const ERA_MESSAGE_MAX_COUNT = 100;

const MESSAGES_FILE = "messages.json";

// This file lives at apps/bot/src/era.ts, so three levels up from here is the
// repo root — that holds whether the bot runs from the repo root (the docker
// image's WORKDIR) or from apps/bot (`npm run dev:bot`), because it never
// depends on process.cwd().
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Overridable for tests / a non-standard layout; defaults to `<repo>/era_img`. */
export const ERA_IMG_DIR = process.env.ERA_IMG_DIR?.trim() || path.join(REPO_ROOT, "era_img");

export function eraMessagesPath(imgDir = ERA_IMG_DIR): string {
  return path.join(imgDir, MESSAGES_FILE);
}

/** Server owner, or the bot's owner. Nobody else — not even an administrator. */
export function canUseEra(who: {
  userId: string;
  guildOwnerId: string | null;
  botOwnerId: string | null;
}): boolean {
  if (who.guildOwnerId && who.userId === who.guildOwnerId) return true;
  const botOwner = who.botOwnerId?.trim();
  return Boolean(botOwner && who.userId === botOwner);
}

/** Image filenames in `dir`, sorted. Missing folder and non-images are empty. */
export async function listImages(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

/** Picks one image at random out of `dir`. Null when there's nothing usable there. */
export async function pickRandomImage(
  dir: string,
  random: () => number = Math.random,
): Promise<string | null> {
  return pickOne(await listImages(dir), random);
}

export function pickOne<T>(items: readonly T[], random: () => number = Math.random): T | null {
  if (items.length === 0) return null;
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)));
  return items[index] ?? null;
}

/**
 * The text after `era add`, taken from the raw message so a mention stays
 * `<@id>` (the tokenizer would have reduced it to a bare snowflake). One
 * layer of wrapping quotes is dropped — people quote a phrase out of habit.
 */
export function eraAddText(rawContent: string): string {
  const match = /^\s*era\s+add\s+([\s\S]*)$/i.exec(rawContent);
  const text = match?.[1]?.trim() ?? "";
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/** `<message> @user` — the invoker, not the persona the webhook posts as. */
export function formatEraLine(message: string, userId: string): string {
  return `${message.trim()} <@${userId}>`;
}

export interface EraOutgoing {
  content?: string;
  files?: CommandFile[];
  /** User ids the webhook is allowed to ping. Empty means ping nobody. */
  mentionUserIds?: string[];
}

/**
 * What `!era` needs from the worker. Kept narrow so the commands can be
 * tested without a gateway: posting as the persona is the worker's job
 * (a webhook with that user's name and avatar).
 */
export interface EraContext {
  readonly commandPrefix: string;
  readonly userId: string;
  readonly guildId: string;
  readonly guildOwnerId: string | null;
  readonly botOwnerId: string | null;
  /** Everything after the prefix, original casing — `era add hello <@123>`. */
  readonly rawContent: string;
  readonly args: readonly string[];
  /** Owner-only replies. DM when possible; the channel is the fallback. */
  replyPrivate(content: string): Promise<unknown>;
  postAsPersona(posts: EraOutgoing[]): Promise<void>;
  log?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

export interface EraRunOptions {
  imgDir?: string;
  messagesFile?: string;
  random?: () => number;
}

/** Thrown when the messages file exists but isn't readable — never overwrite it. */
export class EraStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EraStoreError";
  }
}

/** A post failed in a way the owner can act on. `message` is safe to show them. */
export class EraPostError extends Error {
  constructor(
    readonly code: "persona" | "webhook" | "send",
    message: string,
  ) {
    super(message);
    this.name = "EraPostError";
  }
}

interface MessageFile {
  version: 1;
  guilds: Record<string, string[]>;
}

const writeLocks = new Map<string, Promise<unknown>>();

function withLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(filePath) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  writeLocks.set(filePath, settled);
  void settled.finally(() => {
    if (writeLocks.get(filePath) === settled) writeLocks.delete(filePath);
  });
  return run;
}

function emptyFile(): MessageFile {
  return { version: 1, guilds: {} };
}

function normalize(value: unknown): MessageFile {
  if (!value || typeof value !== "object") return emptyFile();
  const guilds = (value as { guilds?: unknown }).guilds;
  if (!guilds || typeof guilds !== "object") return emptyFile();
  const out: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(guilds)) {
    if (!Array.isArray(list)) continue;
    const messages = list.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
    if (messages.length > 0) out[id] = messages;
  }
  return { version: 1, guilds: out };
}

async function readMessages(filePath: string): Promise<MessageFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return emptyFile();
    throw new EraStoreError(`Couldn't read the saved messages (${String(e)}).`);
  }
  try {
    return normalize(JSON.parse(raw));
  } catch (e) {
    if (e instanceof EraStoreError) throw e;
    throw new EraStoreError(
      `The saved messages file isn't valid JSON, so I left it alone (${filePath}).`,
    );
  }
}

async function writeMessages(filePath: string, data: MessageFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

export class EraMessages {
  constructor(readonly filePath: string) {}

  list(guildId: string): Promise<string[]> {
    return withLock(this.filePath, async () => {
      const data = await readMessages(this.filePath);
      return [...(data.guilds[guildId] ?? [])];
    });
  }

  add(
    guildId: string,
    text: string,
  ): Promise<
    { ok: true; count: number } | { ok: false; reason: "empty" | "long" | "full" | "duplicate" }
  > {
    const message = text.trim();
    if (!message) return Promise.resolve({ ok: false, reason: "empty" });
    if (message.length > ERA_MESSAGE_MAX_LENGTH)
      return Promise.resolve({ ok: false, reason: "long" });
    return withLock(this.filePath, async () => {
      const data = await readMessages(this.filePath);
      const list = data.guilds[guildId] ?? [];
      if (list.includes(message)) return { ok: false, reason: "duplicate" } as const;
      if (list.length >= ERA_MESSAGE_MAX_COUNT) return { ok: false, reason: "full" } as const;
      data.guilds[guildId] = [...list, message];
      await writeMessages(this.filePath, data);
      return { ok: true, count: data.guilds[guildId]!.length } as const;
    });
  }

  remove(
    guildId: string,
    index1: number,
  ): Promise<
    { ok: true; removed: string; count: number } | { ok: false; reason: "missing" | "range" }
  > {
    if (!Number.isInteger(index1) || index1 < 1)
      return Promise.resolve({ ok: false, reason: "range" });
    return withLock(this.filePath, async () => {
      const data = await readMessages(this.filePath);
      const list = data.guilds[guildId] ?? [];
      if (list.length === 0) return { ok: false, reason: "missing" } as const;
      if (index1 > list.length) return { ok: false, reason: "range" } as const;
      const removed = list[index1 - 1]!;
      const next = list.filter((_, i) => i !== index1 - 1);
      if (next.length === 0) delete data.guilds[guildId];
      else data.guilds[guildId] = next;
      await writeMessages(this.filePath, data);
      return { ok: true, removed, count: next.length } as const;
    });
  }
}

function ownerHint(prefix: string): string {
  return [
    "That's between us — it isn't on the help list.",
    `• \`${prefix}era zhvishu\` — a random saved line, then a random photo`,
    `• \`${prefix}era add <message>\` — save a line (\`<message> @them\`)`,
    `• \`${prefix}era messages\` — the saved lines`,
    `• \`${prefix}era photos\` — the photos`,
    `• \`${prefix}era remove <number>\` — drop a line`,
  ].join("\n");
}

async function tell(ctx: EraContext, content: string): Promise<void> {
  for (const chunk of chunkText(content)) {
    await ctx.replyPrivate(chunk);
  }
}

/** Split a reply so it fits in one Discord message, preferring line breaks. */
export function chunkText(content: string, max = 1800): string[] {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const piece = line.length > max ? line.slice(0, max) : line;
    const next = current ? `${current}\n${piece}` : piece;
    if (next.length > max && current) {
      chunks.push(current);
      current = piece;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function loadImageFile(dir: string, name: string): Promise<CommandFile> {
  const data = await readFile(path.join(dir, name));
  return { name, body: data.toString("base64"), encoding: "base64" };
}

function storeErrorText(e: unknown): string {
  return e instanceof EraStoreError ? e.message : `Couldn't use the saved messages — ${String(e)}`;
}

/**
 * Run one `!era` command. Non-owners are ignored — no reply, no hint.
 * `sub` is the word after `era` (`zhvishu`, `add`, `messages`, `photos`,
 * `remove`); empty means they typed the bare root.
 */
export async function runEra(
  ctx: EraContext,
  sub: string,
  options: EraRunOptions = {},
): Promise<void> {
  if (!canUseEra(ctx)) {
    ctx.log?.warn("era command refused", {
      userId: ctx.userId,
      guildId: ctx.guildId,
      sub: sub || "(none)",
    });
    return;
  }

  const command = sub.trim().toLowerCase();
  const imgDir = options.imgDir ?? ERA_IMG_DIR;
  const messages = new EraMessages(options.messagesFile ?? eraMessagesPath(imgDir));
  const random = options.random ?? Math.random;
  const prefix = ctx.commandPrefix;

  try {
    switch (command) {
      case "zhvishu":
        await sendZhvishu(ctx, imgDir, messages, random);
        return;
      case "add":
        await addMessage(ctx, messages, prefix);
        return;
      case "messages":
        await showMessages(ctx, messages, prefix);
        return;
      case "photos":
        await showPhotos(ctx, imgDir);
        return;
      case "remove":
        await removeMessage(ctx, messages, prefix);
        return;
      default:
        await tell(ctx, ownerHint(prefix));
    }
  } catch (e) {
    await tell(ctx, storeErrorText(e));
  }
}

async function sendZhvishu(
  ctx: EraContext,
  imgDir: string,
  messages: EraMessages,
  random: () => number,
): Promise<void> {
  const images = await listImages(imgDir);
  const picked = pickOne(images, random);
  if (!picked) {
    await tell(
      ctx,
      "Nothing in `era_img/` yet — drop an image in that folder at the repo root and try again.",
    );
    return;
  }

  const saved = await messages.list(ctx.guildId);
  const line = pickOne(saved, random);
  const posts: EraOutgoing[] = [];
  if (line) {
    posts.push({
      content: formatEraLine(line, ctx.userId),
      mentionUserIds: [ctx.userId],
    });
  }
  try {
    const file = await loadImageFile(imgDir, picked);
    posts.push({ files: [file] });
    await ctx.postAsPersona(posts);
  } catch (e) {
    const text = e instanceof EraPostError ? e.message : `Couldn't post that photo — ${String(e)}`;
    await tell(ctx, text);
  }
}

async function addMessage(ctx: EraContext, messages: EraMessages, prefix: string): Promise<void> {
  const text = eraAddText(ctx.rawContent);
  const result = await messages.add(ctx.guildId, text);
  if (!result.ok) {
    const why =
      result.reason === "empty"
        ? `Give me the line to save — \`${prefix}era add <message>\`.`
        : result.reason === "long"
          ? `That's too long. Keep it under ${ERA_MESSAGE_MAX_LENGTH} characters.`
          : result.reason === "full"
            ? `The list is full (${ERA_MESSAGE_MAX_COUNT}). Drop one with \`${prefix}era remove <number>\`.`
            : "That's already saved.";
    await tell(ctx, why);
    return;
  }
  await tell(
    ctx,
    `Saved. There are ${result.count} now — one is picked at random and sent as \`<message> @them\` right before the photo.`,
  );
}

async function showMessages(ctx: EraContext, messages: EraMessages, prefix: string): Promise<void> {
  const list = await messages.list(ctx.guildId);
  if (list.length === 0) {
    await tell(ctx, `No saved lines yet. Add one with \`${prefix}era add <message>\`.`);
    return;
  }
  const body = list.map((message, i) => `${i + 1}. ${message}`).join("\n");
  await tell(ctx, `**Saved lines** (${list.length})\n${body}`);
}

async function showPhotos(ctx: EraContext, imgDir: string): Promise<void> {
  const images = await listImages(imgDir);
  if (images.length === 0) {
    await tell(ctx, "No photos in `era_img/` yet.");
    return;
  }
  const body = images.map((name) => `• ${name}`).join("\n");
  await tell(ctx, `**Photos** (${images.length})\n${body}`);
}

async function removeMessage(
  ctx: EraContext,
  messages: EraMessages,
  prefix: string,
): Promise<void> {
  const raw = ctx.args[0]?.trim() ?? "";
  const index = Number(raw);
  if (!raw || !Number.isInteger(index)) {
    await tell(
      ctx,
      `Which one? \`${prefix}era messages\` numbers them, then \`${prefix}era remove <number>\`.`,
    );
    return;
  }
  const result = await messages.remove(ctx.guildId, index);
  if (!result.ok) {
    await tell(
      ctx,
      result.reason === "missing"
        ? "There are no saved lines."
        : `There's no line ${index}. \`${prefix}era messages\` shows what's there.`,
    );
    return;
  }
  await tell(ctx, `Removed ${index}. ${result.count} left.`);
}
