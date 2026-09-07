import { describe, expect, it } from "vitest";
import { emptyServerDesign, type ServerDesign } from "@monarch/schemas";
import { isLocalId } from "@monarch/shared";
import { diffServerDesign } from "../src/diff.js";
import { detachDesign } from "../src/detach.js";
import { mergeDesigns, rebaseDesign } from "../src/compose.js";

function snapshot(): ServerDesign {
  const d = emptyServerDesign("g1", "Guild");
  d.categories = [
    { id: "cat1", name: "INFO", position: 0 },
    { id: "cat2", name: "COMMUNITY", position: 1 },
  ];
  d.channels = [
    { id: "ch1", name: "rules", type: "text", position: 0, parentId: "cat1" },
    { id: "ch2", name: "general", type: "text", position: 0, parentId: "cat2" },
    { id: "ch3", name: "memes", type: "text", position: 1, parentId: "cat2" },
  ];
  d.roles = [{ id: "r1", name: "Admin", position: 1 }];
  return d;
}

describe("rebaseDesign (restore)", () => {
  it("recreates entities that were deleted since the snapshot, keeping parents", () => {
    const current = snapshot();
    // Someone deleted the whole COMMUNITY category and its channels.
    current.categories = current.categories.filter((c) => c.id !== "cat2");
    current.channels = current.channels.filter((c) => c.parentId !== "cat2");

    const { design, recreated, adopted } = rebaseDesign(current, snapshot());
    expect(recreated).toBe(3);
    expect(adopted).toBe(0);
    const cat = design.categories.find((c) => c.name === "COMMUNITY")!;
    expect(isLocalId(cat.id)).toBe(true);
    const general = design.channels.find((c) => c.name === "general")!;
    expect(general.parentId).toBe(cat.id);

    const diff = diffServerDesign(current, design);
    expect(diff.unsupported).toHaveLength(0);
    expect(diff.creates.map((c) => c.name).sort()).toEqual(["COMMUNITY", "general", "memes"]);
    expect(diff.deletes).toHaveLength(0);
  });

  it("leaves live ids alone and deletes what the snapshot did not have", () => {
    const current = snapshot();
    current.channels.push({ id: "ch4", name: "spam", type: "text", position: 2, parentId: "cat2" });
    current.channels[0]!.name = "renamed-rules";

    const { design, recreated } = rebaseDesign(current, snapshot());
    expect(recreated).toBe(0);
    const diff = diffServerDesign(current, design);
    expect(diff.deletes.map((d) => d.name)).toEqual(["spam"]);
    expect(diff.renames).toHaveLength(1);
    expect(diff.renames[0]?.after).toBe("rules");
  });

  it("adopts a same-named live channel instead of deleting and recreating it", () => {
    const current = snapshot();
    // #general was deleted and recreated by hand (new snowflake), then a
    // second category with a same-named channel exists elsewhere.
    current.channels = current.channels.map((c) => (c.id === "ch2" ? { ...c, id: "ch2b" } : c));
    current.channels.push({ id: "ch9", name: "general", type: "text", position: 0, parentId: "cat1" });

    const { design, recreated, adopted } = rebaseDesign(current, snapshot());
    expect(recreated).toBe(0);
    expect(adopted).toBe(1);
    // Same-category match wins over the one in INFO.
    const general = design.channels.find((c) => c.name === "general")!;
    expect(general.id).toBe("ch2b");
    const diff = diffServerDesign(current, design);
    expect(diff.creates).toHaveLength(0);
    expect(diff.deletes.map((d) => d.id)).toEqual(["ch9"]);
  });

  it("never adopts a channel of a different type", () => {
    const current = snapshot();
    current.channels = current.channels.map((c) =>
      c.id === "ch3" ? { ...c, id: "voice1", type: "voice" as const } : c,
    );
    const { design, recreated, adopted } = rebaseDesign(current, snapshot());
    expect(adopted).toBe(0);
    expect(recreated).toBe(1);
    const diff = diffServerDesign(current, design);
    expect(diff.creates.map((c) => c.name)).toEqual(["memes"]);
    expect(diff.deletes.map((d) => d.id)).toEqual(["voice1"]);
  });

  it("always carries the live guild identity, roles and designated channels", () => {
    const current = snapshot();
    current.name = "Renamed Guild";
    current.designatedChannels = { testing: "ch1" };
    const old = snapshot();
    old.roles = [];
    const { design } = rebaseDesign(current, old);
    expect(design.guildId).toBe("g1");
    expect(design.name).toBe("Renamed Guild");
    expect(design.roles).toEqual(current.roles);
    expect(design.designatedChannels).toEqual({ testing: "ch1" });
  });
});

describe("mergeDesigns (template import, add mode)", () => {
  it("appends a detached template after the existing structure", () => {
    const current = snapshot();
    const template = detachDesign(snapshot());
    const merged = mergeDesigns(current, template);

    expect(merged.categories).toHaveLength(4);
    expect(merged.channels).toHaveLength(6);
    // Existing structure untouched.
    expect(merged.categories.slice(0, 2)).toEqual(current.categories);
    // Imported categories are placed after existing ones.
    expect(merged.categories.slice(2).map((c) => c.position)).toEqual([2, 3]);
    // Imported channels still point at their imported parents.
    const importedInfo = merged.categories[2]!;
    const importedRules = merged.channels.find((c) => c.name === "rules" && isLocalId(c.id))!;
    expect(importedRules.parentId).toBe(importedInfo.id);

    const diff = diffServerDesign(current, merged);
    expect(diff.creates).toHaveLength(5);
    expect(diff.deletes).toHaveLength(0);
    expect(diff.modifies.length + diff.renames.length + diff.moves.length).toBe(0);
  });

  it("never lets a stray snowflake in a template touch a live channel", () => {
    const current = snapshot();
    const sloppy = snapshot(); // not detached: still carries ch1/cat1 …
    sloppy.channels[0]!.name = "hacked";
    const merged = mergeDesigns(current, sloppy);
    const diff = diffServerDesign(current, merged);
    expect(diff.renames).toHaveLength(0);
    expect(diff.creates.map((c) => c.name)).toContain("hacked");
    expect(diff.unsupported).toHaveLength(0);
  });
});
