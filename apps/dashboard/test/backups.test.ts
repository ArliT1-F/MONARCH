import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyServerDesign, parseServerTemplate, type ServerDesign } from "@monarch/schemas";
import { diffServerDesign } from "@monarch/design-engine";

/**
 * Backups / restore / export / import against the FileStore and a stubbed
 * Discord read. Exercises the whole staging pipeline the routes and the bot
 * share (lib/backups.ts) without a network or a database.
 */
const dataDir = mkdtempSync(path.join(tmpdir(), "monarch-backups-"));
process.env.MONARCH_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;

let live: ServerDesign;

vi.mock("@/lib/discord", () => ({
  fetchCurrentDesign: vi.fn(async () => structuredClone(live)),
}));

const { createBackup, stageRestore, exportTemplate, stageImport, buildTemplate, templateFileName } =
  await import("@/lib/backups");
const { getStore } = await import("@/lib/store");

function liveDesign(): ServerDesign {
  const d = emptyServerDesign("900", "Live Guild");
  d.categories = [{ id: "c1", name: "INFO", position: 0 }];
  d.channels = [
    { id: "ch1", name: "rules", type: "text", position: 0, parentId: "c1" },
    { id: "ch2", name: "general", type: "text", position: 1, parentId: "c1" },
  ];
  d.roles = [{ id: "r1", name: "Admin", position: 1 }];
  d.designatedChannels = { testing: "ch2" };
  return d;
}

beforeEach(() => {
  live = liveDesign();
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("createBackup", () => {
  it("snapshots the live structure and writes an audit entry", async () => {
    const outcome = await createBackup({ guildId: "900", userId: "u1", name: "  first  " });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.snapshot.kind).toBe("manual");
    expect(outcome.snapshot.name).toBe("first");
    expect(outcome.channelCount).toBe(2);

    const stored = await getStore().getSnapshot("900", outcome.snapshot.id);
    expect(stored?.design.channels.map((c) => c.name)).toEqual(["rules", "general"]);
    expect(await getStore().getSnapshot("other-guild", outcome.snapshot.id)).toBeNull();

    const audit = await getStore().listAudit("900", 5);
    expect(audit[0]?.action).toBe("backup.create");
  });

  it("uses a timestamped default name", async () => {
    const outcome = await createBackup({ guildId: "900", userId: "u1" });
    expect(outcome.ok && outcome.snapshot.name.startsWith("Backup · ")).toBe(true);
  });
});

describe("stageRestore", () => {
  it("stages a draft that recreates deleted channels and reverts renames", async () => {
    const backup = await createBackup({ guildId: "900", userId: "u1", name: "before" });
    if (!backup.ok) throw new Error("backup failed");

    // Meanwhile: #rules deleted, #general renamed, #spam added.
    live.channels = [
      { id: "ch2", name: "chat", type: "text", position: 0, parentId: "c1" },
      { id: "ch3", name: "spam", type: "text", position: 1, parentId: "c1" },
    ];

    const outcome = await stageRestore({ guildId: "900", userId: "u1", snapshotId: backup.snapshot.id });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.recreated).toBe(1);
    expect(outcome.designerUrl).toBe("/s/900/designer");

    const draft = await getStore().getDraft("900", "u1");
    expect(draft).not.toBeNull();
    const diff = diffServerDesign(draft!.baseDesign, draft!.design);
    expect(diff.unsupported).toHaveLength(0);
    expect(diff.creates.map((c) => c.name)).toEqual(["rules"]);
    expect(diff.renames.map((r) => `${r.before}→${r.after}`)).toEqual(["chat→general"]);
    expect(diff.deletes.map((d) => d.name)).toEqual(["spam"]);
    // Guild-level values always come from the live server.
    expect(draft!.design.designatedChannels).toEqual({ testing: "ch2" });
    expect(draft!.design.guildId).toBe("900");
  });

  it("404s for unknown or foreign snapshots", async () => {
    const backup = await createBackup({ guildId: "900", userId: "u1" });
    if (!backup.ok) throw new Error("backup failed");
    const foreign = await stageRestore({ guildId: "901", userId: "u1", snapshotId: backup.snapshot.id });
    expect(foreign).toMatchObject({ ok: false, status: 404 });
    const missing = await stageRestore({ guildId: "900", userId: "u1", snapshotId: "snap_nope" });
    expect(missing).toMatchObject({ ok: false, status: 404 });
  });
});

describe("export / import", () => {
  it("exports a detached, re-parseable template", async () => {
    const outcome = await exportTemplate("900");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fileName).toBe("live-guild-monarch-template.json");
    const roundTrip = parseServerTemplate(JSON.parse(JSON.stringify(outcome.template)));
    expect(roundTrip.ok).toBe(true);
    if (!roundTrip.ok) return;
    expect(roundTrip.template.data.guildId).toBeUndefined();
    expect(roundTrip.template.data.designatedChannels).toEqual({});
    for (const ch of roundTrip.template.data.channels) expect(ch.id.startsWith("new_")).toBe(true);
    expect(templateFileName("  ✨ Fancy // Name ✨ ")).toBe("fancy-name-monarch-template.json");
  });

  it("imports in add mode by appending under the live structure", async () => {
    const template = buildTemplate(liveDesign());
    const outcome = await stageImport({ guildId: "900", userId: "u2", json: template, mode: "add" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome).toMatchObject({ mode: "add", categoryCount: 1, channelCount: 2 });

    const draft = await getStore().getDraft("900", "u2");
    const diff = diffServerDesign(draft!.baseDesign, draft!.design);
    expect(diff.creates).toHaveLength(3);
    expect(diff.deletes).toHaveLength(0);
    expect(draft!.design.roles).toEqual(live.roles);
  });

  it("imports in replace mode so the diff removes what the template lacks", async () => {
    const source = liveDesign();
    source.channels = [source.channels[0]!];
    const template = buildTemplate(source);
    const outcome = await stageImport({ guildId: "900", userId: "u3", json: template, mode: "replace" });
    expect(outcome.ok).toBe(true);

    const draft = await getStore().getDraft("900", "u3");
    const diff = diffServerDesign(draft!.baseDesign, draft!.design);
    expect(diff.creates.map((c) => c.name).sort()).toEqual(["INFO", "rules"]);
    expect(diff.deletes.map((d) => d.name).sort()).toEqual(["INFO", "general", "rules"]);
  });

  it("rejects files that are not Monarch templates", async () => {
    const outcome = await stageImport({ guildId: "900", userId: "u4", json: { hello: "world" }, mode: "add" });
    expect(outcome).toMatchObject({ ok: false, status: 400, code: "template.invalid" });
    expect(await getStore().getDraft("900", "u4")).toBeNull();
  });

  it("rejects templates that would violate Discord limits", async () => {
    const source = liveDesign();
    source.channels[0]!.name = "";
    const template = buildTemplate(source);
    const outcome = await stageImport({ guildId: "900", userId: "u5", json: template, mode: "add" });
    expect(outcome).toMatchObject({ ok: false, status: 422, code: "template.validation" });
  });
});
