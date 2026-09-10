import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyServerDesign, type ServerDesign } from "@monarch/schemas";

/**
 * Template library (FEATURE 7): store round-trips against the FileStore and
 * the library service against a stubbed Discord read — the same shape as
 * backups.test.ts. Covers owner scoping (the security property), the
 * envelope rebuild, and the install handoff into the existing import
 * pipeline.
 */
const dataDir = mkdtempSync(path.join(tmpdir(), "monarch-library-"));
process.env.MONARCH_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;

let live: ServerDesign;

vi.mock("@/lib/discord", () => ({
  fetchCurrentDesign: vi.fn(async () => structuredClone(live)),
}));

const {
  saveTemplateFromGuild,
  saveTemplateFromUpload,
  renameTemplate,
  duplicateTemplate,
  deleteTemplate,
  templateEnvelope,
  templateMeta,
  templateCounts,
} = await import("@/lib/library");
const { getStore } = await import("@/lib/store");
const { stageImport } = await import("@/lib/backups");

function liveDesign(): ServerDesign {
  const d = emptyServerDesign("900", "Live Guild");
  d.categories = [{ id: "c1", name: "INFO", position: 0 }];
  d.channels = [
    { id: "ch1", name: "rules", type: "text", position: 0, parentId: "c1", topic: "Read first" },
    { id: "ch2", name: "general", type: "text", position: 1, parentId: "c1" },
  ];
  d.roles = [
    { id: "r1", name: "Admin", color: "#ff0000", position: 1 },
    { id: "r2", name: "@everyone", position: 0 },
  ];
  // Designated channels are guild settings — a portable template must
  // never carry them.
  d.designatedChannels = { testing: "ch2" };
  return d;
}

beforeEach(() => {
  live = liveDesign();
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("template library store", () => {
  it("round-trips a template and lists newest-first", async () => {
    const now = new Date().toISOString();
    const store = getStore();
    const older = { id: "tpl_a", ownerId: "u1", name: "Older", type: "server", format: 1, data: {}, createdAt: "2026-01-01T00:00:00Z", updatedAt: now };
    const newer = { ...older, id: "tpl_b", name: "Newer", createdAt: "2026-02-01T00:00:00Z" };
    await store.putTemplate(older);
    await store.putTemplate(newer);

    const list = await store.listTemplates("u1");
    expect(list.map((t) => t.id)).toEqual(["tpl_b", "tpl_a"]);
    expect((await store.getTemplate("u1", "tpl_a"))?.name).toBe("Older");
  });

  it("scopes reads, overwrites and deletes by owner", async () => {
    const store = getStore();
    const record = { id: "tpl_owner", ownerId: "u1", name: "Mine", type: "server", format: 1, data: { categories: [] }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await store.putTemplate(record);

    // Another user sees nothing, cannot overwrite, cannot delete.
    expect(await store.getTemplate("u2", "tpl_owner")).toBeNull();
    expect(await store.listTemplates("u2")).toEqual([]);
    await expect(store.putTemplate({ ...record, ownerId: "u2", name: "Hijacked" })).rejects.toThrow(
      /different owner/,
    );
    expect((await store.getTemplate("u1", "tpl_owner"))?.name).toBe("Mine");
    await store.deleteTemplate("u2", "tpl_owner");
    expect(await store.getTemplate("u1", "tpl_owner")).not.toBeNull();

    // The owner can overwrite and delete.
    await store.putTemplate({ ...record, name: "Renamed" });
    expect((await store.getTemplate("u1", "tpl_owner"))?.name).toBe("Renamed");
    await store.deleteTemplate("u1", "tpl_owner");
    expect(await store.getTemplate("u1", "tpl_owner")).toBeNull();
  });
});

describe("saveTemplateFromGuild", () => {
  it("saves a detached copy of the live structure and audits it", async () => {
    const outcome = await saveTemplateFromGuild({ guildId: "900", userId: "svc", username: "Ada", name: "  My layout  " });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.template.name).toBe("My layout");
    // Snowflakes detached: no live ids remain anywhere in the payload.
    const raw = JSON.stringify(outcome.template.data);
    expect(raw).not.toContain('"c1"');
    expect(raw).not.toContain('"ch1"');

    const counts = templateCounts(outcome.template);
    expect(counts).toEqual({ categories: 1, channels: 2, roles: 2 });

    const audit = await getStore().listAudit("900", 5);
    expect(audit[0]?.action).toBe("template.library-save");
  });

  it("never carries designated channels into the template", async () => {
    const outcome = await saveTemplateFromGuild({ guildId: "900", userId: "svc", username: "Ada" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.template.data.designatedChannels).toEqual({});
  });

  it("defaults the name to the server name", async () => {
    const outcome = await saveTemplateFromGuild({ guildId: "900", userId: "svc", username: "Ada" });
    if (!outcome.ok) throw new Error("should be ok");
    expect(outcome.template.name).toBe("Live Guild");
  });

  it("fails with a readable error when Discord can't be read", async () => {
    live = null as unknown as ServerDesign;
    const outcome = await saveTemplateFromGuild({ guildId: "900", userId: "u1", username: "Ada" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("guild.state");
  });
});

describe("saveTemplateFromUpload", () => {
  it("validates the envelope and rejects junk", async () => {
    const bad = await saveTemplateFromUpload({ userId: "u1", json: { format: "nope" } });
    expect(bad.ok).toBe(false);

    const good = await saveTemplateFromUpload({
      userId: "u1",
      json: {
        format: "monarch-template",
        version: 1,
        type: "server",
        name: "Starter",
        data: { guildId: undefined, name: "Starter", categories: [], channels: [], roles: [] },
      },
    });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.template.name).toBe("Starter");
  });

  it("prefers an explicit name over the envelope name", async () => {
    const outcome = await saveTemplateFromUpload({
      userId: "u1",
      name: "Custom",
      json: {
        format: "monarch-template",
        version: 1,
        type: "server",
        name: "Envelope",
        data: { name: "Envelope", categories: [], channels: [], roles: [] },
      },
    });
    if (!outcome.ok) throw new Error("should be ok");
    expect(outcome.template.name).toBe("Custom");
  });
});

describe("rename / duplicate / delete service", () => {
  it("renames only owned templates", async () => {
    const saved = await saveTemplateFromGuild({ guildId: "900", userId: "svc-rename", username: "Ada" });
    if (!saved.ok) throw new Error("should be ok");

    const foreign = await renameTemplate({ ownerId: "someone-else", templateId: saved.template.id, name: "Stolen" });
    expect(foreign.ok).toBe(false);

    const renamed = await renameTemplate({ ownerId: "svc-rename", templateId: saved.template.id, name: "  Better  " });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.template.name).toBe("Better");

    const empty = await renameTemplate({ ownerId: "svc-rename", templateId: saved.template.id, name: "   " });
    expect(empty.ok).toBe(false);
  });

  it("duplicates with a new id and '(copy)' suffix", async () => {
    const saved = await saveTemplateFromGuild({ guildId: "900", userId: "svc-duplicate", username: "Ada", name: "Original" });
    if (!saved.ok) throw new Error("should be ok");
    const copy = await duplicateTemplate({ ownerId: "svc-duplicate", templateId: saved.template.id });
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    expect(copy.template.id).not.toBe(saved.template.id);
    expect(copy.template.name).toBe("Original (copy)");
    const list = await getStore().listTemplates("svc-duplicate");
    expect(list).toHaveLength(2);
  });

  it("deletes only owned templates", async () => {
    const saved = await saveTemplateFromGuild({ guildId: "900", userId: "svc-delete", username: "Ada" });
    if (!saved.ok) throw new Error("should be ok");
    expect((await deleteTemplate({ ownerId: "someone-else", templateId: saved.template.id })).ok).toBe(false);
    const gone = await deleteTemplate({ ownerId: "svc-delete", templateId: saved.template.id });
    expect(gone.ok).toBe(true);
    expect(await getStore().getTemplate("u1", saved.template.id)).toBeNull();
  });
});

describe("templateEnvelope", () => {
  it("rebuilds a parseable monarch-template envelope with a file name", async () => {
    const saved = await saveTemplateFromGuild({ guildId: "900", userId: "env", username: "Ada", name: "Cool Layout" });
    if (!saved.ok) throw new Error("should be ok");
    const envelope = templateEnvelope(saved.template);
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(envelope.template.format).toBe("monarch-template");
    expect(envelope.template.version).toBe(1);
    expect(envelope.template.type).toBe("server");
    expect(envelope.template.name).toBe("Cool Layout");
    expect(envelope.fileName).toBe("cool-layout-monarch-template.json");
  });

  it("flags a corrupt row instead of downloading junk", async () => {
    const bad = templateEnvelope({
      id: "tpl_x",
      ownerId: "u1",
      name: "Broken",
      type: "server",
      format: 99,
      data: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("template.corrupt");
  });
});

describe("library meta", () => {
  it("summarizes counts and strips the payload", async () => {
    const saved = await saveTemplateFromGuild({ guildId: "900", userId: "meta", username: "Ada" });
    if (!saved.ok) throw new Error("should be ok");
    const meta = templateMeta(saved.template);
    expect(meta.categories).toBe(1);
    expect(meta.channels).toBe(2);
    expect(meta.roles).toBe(2);
    expect("data" in meta).toBe(false);
  });
});

describe("install into a guild", () => {
  it("hands off to stageImport: staged as a draft, live ids untouched", async () => {
    const saved = await saveTemplateFromGuild({ guildId: "900", userId: "inst", username: "Ada", name: "Installer" });
    if (!saved.ok) throw new Error("should be ok");
    const envelope = templateEnvelope(saved.template);
    if (!envelope.ok) throw new Error("envelope should parse");

    const outcome = await stageImport({ guildId: "900", userId: "inst", json: envelope.template, mode: "add" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.templateName).toBe("Installer");
    expect(outcome.designerUrl).toBe("/s/900/designer");

    const draft = await getStore().getDraft("900", "inst");
    expect(draft?.design.categories.length).toBe(2); // live + imported
    expect(draft?.design.roles).toEqual(live.roles); // roles always come from live
  });
});
