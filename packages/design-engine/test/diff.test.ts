import { describe, expect, it } from "vitest";
import { emptyServerDesign, type ServerDesign } from "@monarch/schemas";
import { diffServerDesign } from "../src/diff.js";
import { planApply } from "../src/apply-plan.js";
import { detachDesign } from "../src/detach.js";
import { isLocalId } from "@monarch/shared";

function baseDesign(): ServerDesign {
  const d = emptyServerDesign("g1", "Test Guild");
  d.categories = [{ id: "cat1", name: "INFORMATION", position: 0 }];
  d.channels = [
    { id: "ch1", name: "welcome", type: "text", position: 0, parentId: "cat1" },
    { id: "ch2", name: "general", type: "text", position: 1, parentId: "cat1", topic: "chat" },
    { id: "ch3", name: "Voice Lounge", type: "voice", position: 0 },
  ];
  return d;
}

describe("diffServerDesign", () => {
  it("reports no changes for identical designs", () => {
    const diff = diffServerDesign(baseDesign(), structuredClone(baseDesign()));
    expect(diff.isEmpty).toBe(true);
    expect(diff.unchangedCount).toBe(4);
  });

  it("detects creations via local ids", () => {
    const desired = baseDesign();
    desired.channels.push({ id: "new_abc", name: "media", type: "text", position: 2, parentId: "cat1" });
    const diff = diffServerDesign(baseDesign(), desired);
    expect(diff.creates).toHaveLength(1);
    expect(diff.creates[0]?.name).toBe("media");
    expect(diff.isEmpty).toBe(false);
  });

  it("detects renames separately from modifies", () => {
    const desired = baseDesign();
    desired.channels[0]!.name = "start-here";
    desired.channels[1]!.topic = "new topic";
    const diff = diffServerDesign(baseDesign(), desired);
    expect(diff.renames).toHaveLength(1);
    expect(diff.renames[0]?.before).toBe("welcome");
    expect(diff.renames[0]?.after).toBe("start-here");
    expect(diff.modifies).toHaveLength(1);
    expect(diff.modifies[0]?.changes[0]?.field).toBe("topic");
  });

  it("detects moves between categories and deletions", () => {
    const desired = baseDesign();
    desired.channels[2] = { ...desired.channels[2]!, parentId: "cat1", position: 2 };
    desired.channels = desired.channels.filter((c) => c.id !== "ch2");
    const diff = diffServerDesign(baseDesign(), desired);
    expect(diff.moves).toHaveLength(1);
    expect(diff.moves[0]?.toParent).toBe("cat1");
    expect(diff.deletes.map((d) => d.id)).toEqual(["ch2"]);
  });

  it("flags impossible type conversions as unsupported", () => {
    const desired = baseDesign();
    desired.channels[0] = { ...desired.channels[0]!, type: "voice" };
    const diff = diffServerDesign(baseDesign(), desired);
    expect(diff.unsupported).toHaveLength(1);
    expect(diff.unsupported[0]?.reason).toMatch(/does not support converting/);
  });
});

describe("planApply", () => {
  it("orders creates before modifies before deletes, categories first", () => {
    const desired = baseDesign();
    desired.categories.push({ id: "new_cat", name: "COMMUNITY", position: 1 });
    desired.channels.push({ id: "new_ch", name: "off-topic", type: "text", position: 0, parentId: "new_cat" });
    desired.channels[1]!.topic = "changed";
    desired.channels = desired.channels.filter((c) => c.id !== "ch3");

    const plan = planApply(diffServerDesign(baseDesign(), desired));
    const ops = plan.steps.map((s) => s.entry.op + ":" + s.entry.resource);
    expect(ops[0]).toBe("create:category");
    expect(ops[1]).toBe("create:channel");
    expect(ops.at(-1)).toBe("delete:channel");
    expect(plan.destructive).toBe(true);
  });
});

describe("detachDesign", () => {
  it("replaces all ids with portable local ids and keeps parent links", () => {
    const detached = detachDesign(baseDesign());
    expect(detached.guildId).toBe("");
    for (const c of [...detached.categories, ...detached.channels]) {
      expect(isLocalId(c.id)).toBe(true);
    }
    const cat = detached.categories[0]!;
    expect(detached.channels[0]?.parentId).toBe(cat.id);
  });
});
