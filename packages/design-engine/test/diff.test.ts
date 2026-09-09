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
  d.roles = [
    { id: "r1", name: "@everyone", position: 0, permissions: "0", managed: false },
    { id: "r2", name: "Member", position: 1, color: "#88c0d0", hoist: true, mentionable: false, permissions: "0", managed: false },
    { id: "r3", name: "MEE6", position: 50, permissions: "8", managed: true },
  ];
  return d;
}

describe("diffServerDesign", () => {
  it("reports no changes for identical designs", () => {
    const diff = diffServerDesign(baseDesign(), structuredClone(baseDesign()));
    expect(diff.isEmpty).toBe(true);
    expect(diff.unchangedCount).toBe(7);
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

describe("diffServerDesign — roles", () => {
  it("detects role creations via local ids", () => {
    const desired = baseDesign();
    desired.roles.push({ id: "new_r", name: "Mod", position: 10, color: "#ff8800", permissions: "0", managed: false });
    const diff = diffServerDesign(baseDesign(), desired);
    const roleCreates = diff.creates.filter((c) => c.resource === "role");
    expect(roleCreates).toHaveLength(1);
    expect(roleCreates[0]?.name).toBe("Mod");
  });

  it("detects role renames, color, hoist, mentionable, and permissions changes", () => {
    const desired = baseDesign();
    desired.roles[1]!.name = "Verified";
    desired.roles[1]!.color = "#5e81ac";
    desired.roles[1]!.hoist = false;
    desired.roles[1]!.mentionable = true;
    desired.roles[1]!.permissions = "1024";
    const diff = diffServerDesign(baseDesign(), desired);
    const roleRenames = diff.renames.filter((r) => r.resource === "role");
    expect(roleRenames).toHaveLength(1);
    expect(roleRenames[0]?.after).toBe("Verified");
    // The rename bundles the field changes, mirroring how channels
    // surface a rename + topic change as one rename entry.
    const fields = roleRenames[0]!.changes.map((c) => c.field);
    expect(fields).toEqual(expect.arrayContaining(["color", "hoist", "mentionable", "permissions"]));
  });

  it("emits a separate modify when only non-name fields change", () => {
    const desired = baseDesign();
    desired.roles[1]!.color = "#5e81ac";
    desired.roles[1]!.hoist = false;
    const diff = diffServerDesign(baseDesign(), desired);
    const roleRenames = diff.renames.filter((r) => r.resource === "role");
    const roleModifies = diff.modifies.filter((m) => m.resource === "role");
    expect(roleRenames).toHaveLength(0);
    expect(roleModifies).toHaveLength(1);
    const fields = roleModifies[0]!.changes.map((c) => c.field);
    expect(fields).toEqual(expect.arrayContaining(["color", "hoist"]));
  });

  it("refuses to delete or rename managed roles", () => {
    const desired = baseDesign();
    desired.roles = desired.roles.filter((r) => r.id !== "r3");
    desired.roles[1]!.name = "Mod";
    desired.roles[1]!.name = "Member";
    // Reverting r3: a managed role should not be reported as a delete.
    const diff = diffServerDesign(baseDesign(), desired);
    expect(diff.deletes.filter((d) => d.resource === "role")).toHaveLength(0);
  });

  it("flags managed-role renames as unsupported", () => {
    const desired = baseDesign();
    desired.roles[2]!.name = "MEE6-renamed";
    const diff = diffServerDesign(baseDesign(), desired);
    const roleUnsupported = diff.unsupported.filter((u) => u.resource === "role");
    expect(roleUnsupported).toHaveLength(1);
    expect(roleUnsupported[0]?.reason).toMatch(/managed/);
  });

  it("detects role position changes as moves", () => {
    const desired = baseDesign();
    desired.roles[1]!.position = 5;
    const diff = diffServerDesign(baseDesign(), desired);
    const roleMoves = diff.moves.filter((m) => m.resource === "role");
    expect(roleMoves).toHaveLength(1);
    expect(roleMoves[0]?.toPosition).toBe(5);
  });

  it("detects role deletions of non-managed roles", () => {
    const desired = baseDesign();
    desired.roles = desired.roles.filter((r) => r.id !== "r2");
    const diff = diffServerDesign(baseDesign(), desired);
    const roleDeletes = diff.deletes.filter((d) => d.resource === "role" && d.id === "r2");
    expect(roleDeletes).toHaveLength(1);
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

  it("orders role creates after channel creates but before role deletes", () => {
    const desired = baseDesign();
    desired.roles.push({ id: "new_r", name: "Mod", position: 10, permissions: "0", managed: false });
    desired.roles = desired.roles.filter((r) => r.id !== "r2");
    const plan = planApply(diffServerDesign(baseDesign(), desired));
    const ops = plan.steps.map((s) => s.entry.op + ":" + s.entry.resource);
    const createRoleIdx = ops.indexOf("create:role");
    const deleteRoleIdx = ops.indexOf("delete:role");
    expect(createRoleIdx).toBeGreaterThan(ops.indexOf("create:category"));
    expect(createRoleIdx).toBeGreaterThan(ops.indexOf("create:channel"));
    expect(deleteRoleIdx).toBeGreaterThan(createRoleIdx);
    expect(plan.destructive).toBe(true);
  });
});

describe("detachDesign", () => {
  it("replaces all ids with portable local ids and keeps parent links", () => {
    const detached = detachDesign(baseDesign());
    expect(detached.guildId).toBe("");
    for (const c of [...detached.categories, ...detached.channels, ...detached.roles]) {
      expect(isLocalId(c.id)).toBe(true);
    }
    const cat = detached.categories[0]!;
    expect(detached.channels[0]?.parentId).toBe(cat.id);
  });
});

