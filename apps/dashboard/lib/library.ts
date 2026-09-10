import { createLogger } from "@monarch/shared";
import { TEMPLATE_FORMAT, parseServerTemplate, type ServerTemplate } from "@monarch/schemas";
import { buildTemplate, templateFileName } from "./backups";
import { fetchCurrentDesign } from "./discord";
import { getStore, newId, type TemplateRecord } from "./store";

/**
 * Template library (FEATURE 7) — the service behind `/s/:id/library` and
 * `/api/library/templates/*`. The library is per-user (a Template row is
 * owned by its creator); installing into a guild reuses the existing
 * `stageImport` pipeline, so an install is never a direct write to Discord
 * — it stages a draft the user reviews in the Server Designer.
 */
const log = createLogger("library");

export type LibrarySaveOutcome =
  | { ok: true; template: TemplateRecord }
  | { ok: false; status: number; code: string; message: string; fix?: string; detail?: unknown };

/** Save the live structure of a guild as the user's template. */
export async function saveTemplateFromGuild(opts: {
  guildId: string;
  userId: string;
  username: string;
  name?: string;
}): Promise<LibrarySaveOutcome> {
  const current = await fetchCurrentDesign(opts.guildId);
  if (!current) {
    return {
      ok: false,
      status: 502,
      code: "guild.state",
      message: "Monarch couldn't read this server's structure.",
    };
  }
  const template = buildTemplate(current);
  return persistTemplate({
    ownerId: opts.userId,
    name: opts.name?.trim() || template.name || current.name,
    data: template.data as Record<string, unknown>,
    guildId: opts.guildId,
    summarySource: current.name,
  });
}

/** Save an uploaded `monarch-template` JSON payload into the library. */
export async function saveTemplateFromUpload(opts: {
  userId: string;
  json: unknown;
  name?: string;
}): Promise<LibrarySaveOutcome> {
  const parsed = parseServerTemplate(opts.json);
  if (!parsed.ok) {
    return { ok: false, status: 400, code: "template.invalid", message: parsed.error };
  }
  return persistTemplate({
    ownerId: opts.userId,
    name: opts.name?.trim() || parsed.template.name || "Imported template",
    data: parsed.template.data as Record<string, unknown>,
  });
}

async function persistTemplate(opts: {
  ownerId: string;
  name: string;
  data: Record<string, unknown>;
  guildId?: string;
  summarySource?: string;
}): Promise<LibrarySaveOutcome> {
  const now = new Date().toISOString();
  const record: TemplateRecord = {
    id: newId("tpl"),
    ownerId: opts.ownerId,
    name: opts.name.slice(0, 100) || "Untitled template",
    type: "server",
    format: 1,
    data: opts.data,
    createdAt: now,
    updatedAt: now,
  };
  const store = getStore();
  await store.putTemplate(record);
  if (opts.guildId) {
    await store.addAudit({
      id: newId("audit"),
      guildId: opts.guildId,
      userId: opts.ownerId,
      action: "template.library-save",
      summary: `Template "${record.name}" saved to the library (${templateCounts(record).categories} categories, ${templateCounts(record).channels} channels)`,
      createdAt: now,
    });
  }
  log.info("template saved to library", {
    id: record.id,
    ownerId: opts.ownerId,
    guildId: opts.guildId,
  });
  return { ok: true, template: record };
}

/** Rename (or otherwise update the metadata of) an owned template. */
export async function renameTemplate(opts: {
  ownerId: string;
  templateId: string;
  name: string;
}): Promise<LibrarySaveOutcome> {
  const store = getStore();
  const existing = await store.getTemplate(opts.ownerId, opts.templateId);
  if (!existing) {
    return { ok: false, status: 404, code: "template.not-found", message: "That template doesn't exist in your library." };
  }
  const name = opts.name.trim().slice(0, 100);
  if (!name) {
    return { ok: false, status: 400, code: "template.name", message: "Template names need at least one character." };
  }
  const updated: TemplateRecord = { ...existing, name, updatedAt: new Date().toISOString() };
  await store.putTemplate(updated);
  return { ok: true, template: updated };
}

export async function duplicateTemplate(opts: {
  ownerId: string;
  templateId: string;
}): Promise<LibrarySaveOutcome> {
  const store = getStore();
  const existing = await store.getTemplate(opts.ownerId, opts.templateId);
  if (!existing) {
    return { ok: false, status: 404, code: "template.not-found", message: "That template doesn't exist in your library." };
  }
  const now = new Date().toISOString();
  const copy: TemplateRecord = {
    ...existing,
    id: newId("tpl"),
    name: `${existing.name} (copy)`.slice(0, 100),
    createdAt: now,
    updatedAt: now,
  };
  await store.putTemplate(copy);
  return { ok: true, template: copy };
}

export type LibraryDeleteOutcome =
  | { ok: true; id: string }
  | { ok: false; status: number; code: string; message: string };

export async function deleteTemplate(opts: {
  ownerId: string;
  templateId: string;
}): Promise<LibraryDeleteOutcome> {
  const store = getStore();
  const existing = await store.getTemplate(opts.ownerId, opts.templateId);
  if (!existing) {
    return { ok: false, status: 404, code: "template.not-found", message: "That template doesn't exist in your library." };
  }
  await store.deleteTemplate(opts.ownerId, opts.templateId);
  return { ok: true, id: opts.templateId };
}

/**
 * Rebuild a valid `monarch-template` envelope from the stored columns.
 * Parse it back before sending so a row written by an older/buggier
 * version degrades to a clear 404-style error instead of a corrupt file.
 */
export function templateEnvelope(record: TemplateRecord):
  | { ok: true; template: ServerTemplate; fileName: string }
  | { ok: false; status: number; code: string; message: string } {
  const envelope = {
    format: TEMPLATE_FORMAT,
    version: record.format,
    type: record.type,
    name: record.name,
    data: record.data,
  };
  const parsed = parseServerTemplate(envelope);
  if (!parsed.ok) {
    return { ok: false, status: 410, code: "template.corrupt", message: parsed.error };
  }
  return { ok: true, template: parsed.template, fileName: templateFileName(record.name) };
}

export interface TemplateMeta {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  categories: number;
  channels: number;
  roles: number;
}

/** Summary for list views — derived from the payload, never stored. */
export function templateMeta(record: TemplateRecord): TemplateMeta {
  const counts = templateCounts(record);
  const { data: _data, ...meta } = record;
  return { ...meta, ...counts };
}

export function templateCounts(record: TemplateRecord): { categories: number; channels: number; roles: number } {
  const list = (key: string): unknown[] => {
    const value = record.data[key];
    return Array.isArray(value) ? value : [];
  };
  return {
    categories: list("categories").length,
    channels: list("channels").length,
    roles: list("roles").length,
  };
}
