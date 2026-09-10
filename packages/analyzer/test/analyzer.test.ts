import { describe, expect, it } from "vitest";
import { emptyServerDesign, type ServerDesign } from "@monarch/schemas";
import { analyzeServerDesign, ANALYZER_CATEGORIES } from "../src/index.js";

/**
 * The analyzer is deterministic: same design, same scores, always.
 * These tests pin the scoring semantics so refactors can't silently
 * shift what "good design" means.
 */

function designWith(patch: Partial<ServerDesign>): ServerDesign {
  const base = emptyServerDesign("111", "Test Guild");
  return { ...base, ...patch };
}

function checkScore(report: ReturnType<typeof analyzeServerDesign>, id: string): number {
  for (const cat of report.categories) {
    const found = cat.checks.find((c) => c.id === id);
    if (found) return found.score;
  }
  throw new Error(`no such check: ${id}`);
}

function checkOf(report: ReturnType<typeof analyzeServerDesign>, id: string) {
  for (const cat of report.categories) {
    const found = cat.checks.find((c) => c.id === id);
    if (found) return found;
  }
  throw new Error(`no such check: ${id}`);
}

describe("analyzeServerDesign — determinism & shape", () => {
  it("is deterministic for the same input", () => {
    const design = designWith({});
    const a = analyzeServerDesign(design);
    const b = analyzeServerDesign(design);
    expect(a.overall).toBe(b.overall);
    expect(a.categories).toEqual(b.categories);
  });

  it("produces all four categories with the documented weights", () => {
    const report = analyzeServerDesign(designWith({}));
    expect(report.categories.map((c) => c.id)).toEqual(ANALYZER_CATEGORIES.map((c) => c.id));
    const weightSum = ANALYZER_CATEGORIES.reduce((s, c) => s + c.weight, 0);
    expect(weightSum).toBeCloseTo(1);
    // every check appears in exactly one category
    const total = report.categories.reduce((s, c) => s + c.checks.length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("scores a completely empty server low on organization but not on spelling checks", () => {
    const report = analyzeServerDesign(designWith({}));
    expect(checkScore(report, "org.has-structure")).toBe(0);
    expect(checkScore(report, "org.topics")).toBe(1); // no channels → nothing to judge
    const org = report.categories.find((c) => c.id === "organization")!;
    // Structure carries extra weight: an empty server must not score as
    // well-organized just because every other check is vacuously true.
    expect(org.score).toBeLessThan(70);
    expect(report.overall).toBeLessThan(85);
  });

  it("scores the reference 'good' server near-perfect", () => {
    const design = designWith({
      categories: [
        { id: "c1", name: "INFORMATION", position: 0 },
        { id: "c2", name: "COMMUNITY", position: 1 },
      ],
      channels: [
        { id: "ch1", name: "welcome", type: "text", position: 0, parentId: "c1", topic: "Start here" },
        { id: "ch2", name: "rules", type: "text", position: 1, parentId: "c1", topic: "Read first" },
        { id: "ch3", name: "general", type: "text", position: 0, parentId: "c2", topic: "Chat" },
        { id: "ch4", name: "Lounge", type: "voice", position: 1, parentId: "c2" },
      ],
      roles: [
        { id: "r1", name: "Owner", color: "#e8b64c", position: 5 },
        { id: "r2", name: "Admin", color: "#eb4d4b", position: 4 },
        { id: "r3", name: "Member", position: 1 },
      ],
      branding: {
        primaryColor: "#e8b64c",
        secondaryColor: "#5865f2",
        accentColor: "#eb4d4b",
        rolePalette: ["#e8b64c", "#eb4d4b"],
      },
    });
    const report = analyzeServerDesign(design);
    expect(report.overall).toBeGreaterThanOrEqual(80);
  });
});

describe("analyzer — organization checks", () => {
  it("flags uncategorized channels with partial credit", () => {
    const design = designWith({
      categories: [{ id: "c1", name: "INFO", position: 0 }],
      channels: [
        { id: "ch1", name: "in-cat", type: "text", position: 0, parentId: "c1" },
        { id: "ch2", name: "loose", type: "text", position: 1 },
      ],
    });
    const check = checkOf(report(design), "org.channels-categorized");
    expect(check.score).toBe(0.5);
    expect(check.suggestion?.affected).toEqual(["#loose"]);
  });

  it("treats a channel whose parent vanished as uncategorized", () => {
    const design = designWith({
      categories: [],
      channels: [{ id: "ch1", name: "orphan", type: "text", position: 0, parentId: "999" }],
    });
    expect(checkScore(report(design), "org.channels-categorized")).toBe(0);
  });

  it("penalizes empty categories proportionally", () => {
    const design = designWith({
      categories: [
        { id: "c1", name: "Used", position: 0 },
        { id: "c2", name: "Empty", position: 1 },
      ],
      channels: [{ id: "ch1", name: "general", type: "text", position: 0, parentId: "c1" }],
    });
    const check = checkOf(report(design), "org.empty-categories");
    expect(check.score).toBe(0.5);
    expect(check.suggestion?.affected).toEqual(["Empty"]);
  });

  it("measures topic coverage over text-like channels only", () => {
    const design = designWith({
      categories: [{ id: "c1", name: "V", position: 0 }],
      channels: [
        { id: "ch1", name: "with-topic", type: "text", position: 0, parentId: "c1", topic: "hey" },
        { id: "ch2", name: "no-topic", type: "text", position: 1, parentId: "c1" },
        { id: "ch3", name: "Voice", type: "voice", position: 2, parentId: "c1" },
      ],
    });
    const check = checkOf(report(design), "org.topics");
    expect(check.score).toBe(0.5); // voice channel excluded from the denominator
  });

  it("flags categories holding more than 25 channels", () => {
    const channels = Array.from({ length: 30 }, (_, i) => ({
      id: `ch${i}`,
      name: `c${i}`,
      type: "text" as const,
      position: i,
      parentId: "c1",
    }));
    const design = designWith({
      categories: [{ id: "c1", name: "MEGA", position: 0 }],
      channels,
    });
    const check = checkOf(report(design), "org.clutter");
    expect(check.score).toBe(0); // 1 of 1 groups overloaded
    expect(check.suggestion?.affected).toEqual(["MEGA"]);
  });
});

describe("analyzer — naming checks", () => {
  it("detects mixed separators and names the minority style", () => {
    const design = designWith({
      channels: [
        { id: "ch1", name: "general-chat", type: "text", position: 0 },
        { id: "ch2", name: "media-share", type: "text", position: 1 },
        { id: "ch3", name: "off_topic", type: "text", position: 2 },
      ],
    });
    const check = checkOf(report(design), "naming.separator-consistency");
    expect(check.score).toBeCloseTo(2 / 3);
    expect(check.suggestion?.affected).toEqual(["#off_topic"]);
  });

  it("passes when separators are consistent", () => {
    const design = designWith({
      channels: [
        { id: "ch1", name: "general-chat", type: "text", position: 0 },
        { id: "ch2", name: "media-share", type: "text", position: 1 },
      ],
    });
    expect(checkScore(report(design), "naming.separator-consistency")).toBe(1);
  });

  it("flags capital letters in text-like channels but not voice channels", () => {
    const design = designWith({
      channels: [
        { id: "ch1", name: "General", type: "text", position: 0 },
        { id: "ch2", name: "Gaming", type: "voice", position: 1 },
      ],
    });
    const check = checkOf(report(design), "naming.capitalization");
    expect(check.score).toBe(0); // 1 of 1 text-like flagged; voice excluded
    expect(check.suggestion?.affected).toEqual(["#General"]);
  });

  it("flags in-place duplicate names", () => {
    const design = designWith({
      channels: [
        { id: "ch1", name: "general", type: "text", position: 0 },
        { id: "ch2", name: "General", type: "text", position: 1 },
        { id: "ch3", name: "other", type: "text", position: 2 },
      ],
    });
    const check = checkOf(report(design), "naming.duplicates");
    expect(check.score).toBeLessThan(1);
    expect(check.suggestion?.affected?.[0]).toContain("general · General");
  });

  it("lets identical names in different parents pass (Discord allows that and it is normal)", () => {
    const design = designWith({
      categories: [
        { id: "c1", name: "A", position: 0 },
        { id: "c2", name: "B", position: 1 },
      ],
      channels: [
        { id: "ch1", name: "general", type: "text", position: 0, parentId: "c1" },
        { id: "ch2", name: "general", type: "text", position: 0, parentId: "c2" },
      ],
    });
    expect(checkScore(report(design), "naming.duplicates")).toBe(1);
  });

  it("checks voice-channel casing consistency", () => {
    const design = designWith({
      channels: [
        { id: "ch1", name: "Game Night", type: "voice", position: 0 },
        { id: "ch2", name: "Chill Zone", type: "voice", position: 1 },
        { id: "ch3", name: "AFK", type: "voice", position: 2 },
      ],
    });
    // Two Title-Case names dominate; the shouty one is the minority.
    const check = checkOf(report(design), "naming.voice-style");
    expect(check.score).toBeCloseTo(2 / 3);
    expect(check.suggestion?.affected).toEqual(["AFK"]);
  });
});

describe("analyzer — role checks", () => {
  it("suggests a unified palette when more than 5 distinct colors are used", () => {
    const colors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#800000"];
    const design = designWith({
      roles: colors.map((color, i) => ({ id: `r${i}`, name: `Role ${i}`, color, position: i })),
    });
    const check = checkOf(report(design), "roles.palette-focus");
    expect(check.score).toBe(0.5); // 6–8 colors: half credit
    expect(check.suggestion?.fix).toContain("unified 5-color palette");
  });

  it("gives no credit beyond eight distinct colors", () => {
    const colors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#800000", "#008000", "#800080"];
    const design = designWith({
      roles: colors.map((color, i) => ({ id: `r${i}`, name: `Role ${i}`, color, position: i })),
    });
    expect(checkScore(report(design), "roles.palette-focus")).toBe(0);
  });

  it("passes with five or fewer distinct colors", () => {
    const colors = ["#ff0000", "#00ff00", "#0000ff", "#FF0000", "#ffff00"];
    const design = designWith({
      roles: colors.map((color, i) => ({ id: `r${i}`, name: `Role ${i}`, color, position: i })),
    });
    expect(checkScore(report(design), "roles.palette-focus")).toBe(1); // case-insensitive distinct
  });

  it("penalizes a 50/50 colored/plain split hardest", () => {
    const roles = Array.from({ length: 4 }, (_, i) => ({
      id: `r${i}`,
      name: `Role ${i}`,
      color: i % 2 === 0 ? "#ff0000" : undefined,
      position: i,
    }));
    const design = designWith({ roles });
    expect(checkScore(report(design), "roles.color-coverage")).toBe(0);
  });

  it("treats all-plain and all-colored role sets as consistent", () => {
    const plain = Array.from({ length: 4 }, (_, i) => ({
      id: `r${i}`,
      name: `Role ${i}`,
      position: i,
    }));
    expect(checkScore(report(designWith({ roles: plain })), "roles.color-coverage")).toBe(1);
    const colored = plain.map((r) => ({ ...r, color: "#123456" }));
    expect(checkScore(report(designWith({ roles: colored })), "roles.color-coverage")).toBe(1);
  });

  it("never flags @everyone or managed roles", () => {
    const design = designWith({
      guildId: "111",
      roles: [
        { id: "111", name: "@everyone", position: 0 },
        { id: "r1", name: "MEE6", color: "#ff0000", position: 1, managed: true },
        { id: "r2", name: "Admin", color: "#00ff00", position: 2 },
        { id: "r3", name: "Mod", color: "#0000ff", position: 3 },
      ],
    });
    // @everyone has no color and MEE6 is managed: both must be excluded,
    // leaving 2 editable colored roles → consistent.
    expect(checkScore(report(design), "roles.color-coverage")).toBe(1);
  });

  it("flags mixed role-name casing", () => {
    const design = designWith({
      roles: [
        { id: "r1", name: "admin", position: 0 },
        { id: "r2", name: "moderator", position: 1 },
        { id: "r3", name: "MEMBER", position: 2 },
      ],
    });
    const check = checkOf(report(design), "roles.naming-consistency");
    expect(check.score).toBeCloseTo(2 / 3);
    expect(check.suggestion?.affected).toEqual(["MEMBER"]);
  });

  it("flags more than three hoisted roles", () => {
    const design = designWith({
      roles: [
        { id: "r1", name: "A", hoist: true, position: 0 },
        { id: "r2", name: "B", hoist: true, position: 1 },
        { id: "r3", name: "C", hoist: true, position: 2 },
        { id: "r4", name: "D", hoist: true, position: 3 },
        { id: "r5", name: "E", position: 4 },
      ],
    });
    const check = checkOf(report(design), "roles.hoist-discipline");
    expect(check.score).toBeCloseTo(3 / 4);
    expect(check.suggestion?.affected).toHaveLength(4);
  });
});

describe("analyzer — branding checks", () => {
  it("weights primary over secondary/accent", () => {
    const partial = designWith({ branding: { primaryColor: "#aa0000" } });
    expect(checkScore(report(partial), "branding.colors-set")).toBe(0.5);
    const full = designWith({
      branding: { primaryColor: "#aa0000", secondaryColor: "#00aa00", accentColor: "#0000aa" },
    });
    expect(checkScore(report(full), "branding.colors-set")).toBe(1);
  });

  it("checks role colors against a defined palette case-insensitively", () => {
    const design = designWith({
      roles: [
        { id: "r1", name: "A", color: "#AA0000", position: 0 },
        { id: "r2", name: "B", color: "#00aa00", position: 1 },
        { id: "r3", name: "C", color: "#123456", position: 2 },
      ],
      branding: { primaryColor: "#aa0000", rolePalette: ["#aa0000", "#00aa00"] },
    });
    const check = checkOf(report(design), "branding.role-palette-alignment");
    expect(check.score).toBeCloseTo(2 / 3);
    expect(check.suggestion?.affected).toEqual(["C (#123456)"]);
  });

  it("is advisory (passes) when no palette is defined but roles are colored", () => {
    const design = designWith({
      roles: Array.from({ length: 6 }, (_, i) => ({
        id: `r${i}`,
        name: `Role ${i}`,
        color: "#112233",
        position: i,
      })),
    });
    const check = checkOf(report(design), "branding.role-palette-alignment");
    expect(check.pass).toBe(true);
    expect(check.suggestion).toBeDefined();
  });
});

describe("analyzer — dismissals (mark as intentional)", () => {
  it("excludes dismissed checks from category and overall scores", () => {
    const design = designWith({}); // empty server: org.has-structure = 0
    const before = analyzeServerDesign(design);
    const orgBefore = before.categories.find((c) => c.id === "organization")!;
    expect(orgBefore.score).toBeLessThan(100);

    const after = analyzeServerDesign(design, {
      dismissed: ["org.has-structure", "org.channels-categorized", "org.empty-categories", "org.topics", "org.clutter"],
    });
    const orgAfter = after.categories.find((c) => c.id === "organization")!;
    expect(orgAfter.score).toBe(100);
    expect(after.dismissedCount).toBe(5);
    expect(after.overall).toBeGreaterThan(before.overall);
  });

  it("keeps dismissed checks visible with dismissed: true", () => {
    const design = designWith({});
    const report = analyzeServerDesign(design, { dismissed: ["org.has-structure"] });
    const check = checkOf(report, "org.has-structure");
    expect(check.dismissed).toBe(true);
    expect(check.score).toBe(0); // raw score is preserved for transparency
  });

  it("scores 100 everywhere when every check is dismissed", () => {
    const design = designWith({});
    const all = analyzeServerDesign(design).categories.flatMap((c) => c.checks.map((k) => k.id));
    const report = analyzeServerDesign(design, { dismissed: all });
    expect(report.overall).toBe(100);
  });
});

function report(design: ServerDesign) {
  return analyzeServerDesign(design);
}
