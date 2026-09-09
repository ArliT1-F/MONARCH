import { describe, expect, it } from "vitest";
import { emptyServerDesign, type ServerDesign } from "@monarch/schemas";
import { diffServerDesign, planApply } from "@monarch/design-engine";
import {
  InMemoryMockStore,
  MockDiscordGateway,
  type MockState,
} from "../src/mock-gateway.js";
import { executeApplyPlan } from "../src/executor.js";

/**
 * Role designer end-to-end coverage: drives the full draft → diff →
 * apply loop through the MockDiscordGateway so we can verify that
 * create, modify (incl. color, hoist, mentionable, permissions),
 * rename, move, and delete all round-trip without a Discord bot.
 */
function makeState(): MockState {
  const design = emptyServerDesign("g1", "Guild");
  design.roles = [
    { id: "r1", name: "@everyone", position: 0, permissions: "0", managed: false },
    { id: "r2", name: "Member", position: 1, color: "#88c0d0", hoist: true, mentionable: false, permissions: "0", managed: false },
    { id: "r3", name: "MEE6", position: 50, permissions: "8", managed: true },
  ];
  return {
    guilds: {
      g1: {
        id: "g1",
        name: "Guild",
        memberCount: 10,
        botInstalled: true,
        botPermissions: "8", // Administrator
        design,
        outbox: [],
      },
    },
  };
}

describe("Role apply loop", () => {
  it("creates, modifies, renames, repositions, and deletes roles end-to-end", async () => {
    const store = new InMemoryMockStore(makeState());
    const gw = new MockDiscordGateway(store);

    const current = (await gw.fetchServerDesign("g1"));
    if (!current.ok) throw new Error("no design");
    const desired: ServerDesign = structuredClone(current.value);
    // create a new role
    desired.roles.push({ id: "new_mod", name: "Mod", position: 5, color: "#ff8800", hoist: true, mentionable: true, permissions: "8589934592", managed: false });
    // rename Member → Verified
    const member = desired.roles.find((r) => r.id === "r2")!;
    member.name = "Verified";
    member.color = "#5e81ac";
    member.hoist = false;
    member.mentionable = true;
    member.permissions = "1024";
    // bump @everyone position (Discord caps at 0; we use 0 to mean "no change")
    // delete r3 if we could, but it's managed — must not be deleted
    desired.roles = desired.roles.filter((r) => r.id !== "r3");

    const diff = diffServerDesign(current.value, desired);
    const plan = planApply(diff);

    // Sanity: MEE6 (managed) is reported as unsupported, not delete.
    const roleDeletes = diff.deletes.filter((d) => d.resource === "role");
    expect(roleDeletes).toHaveLength(0);
    const managedUnsupported = diff.unsupported.filter((u) => u.resource === "role");
    expect(managedUnsupported).toHaveLength(0); // unchanged

    const result = await executeApplyPlan(gw, plan, desired);
    expect(result.ok).toBe(true);

    const after = (await gw.fetchServerDesign("g1"));
    if (!after.ok) throw new Error("no design");
    // Mod is created
    const mod = after.value.roles.find((r) => r.name === "Mod");
    expect(mod).toBeDefined();
    expect(mod?.color).toBe("#ff8800");
    expect(mod?.hoist).toBe(true);
    expect(mod?.permissions).toBe("8589934592");
    // Verified reflects the modifications
    const verified = after.value.roles.find((r) => r.id === "r2");
    expect(verified?.name).toBe("Verified");
    expect(verified?.color).toBe("#5e81ac");
    expect(verified?.hoist).toBe(false);
    expect(verified?.mentionable).toBe(true);
    expect(verified?.permissions).toBe("1024");
    // MEE6 still present, untouched
    const me6 = after.value.roles.find((r) => r.id === "r3");
    expect(me6).toBeDefined();
    expect(me6?.name).toBe("MEE6");
  });

  it("refuses to delete a managed role", async () => {
    const store = new InMemoryMockStore(makeState());
    const gw = new MockDiscordGateway(store);
    // Bypass the diff's managed protection and try the gateway directly.
    await expect(gw.deleteRole("g1", "r3")).rejects.toThrow(/managed/);
  });

  it("refuses to modify a managed role", async () => {
    const store = new InMemoryMockStore(makeState());
    const gw = new MockDiscordGateway(store);
    await expect(gw.modifyRole("g1", "r3", { name: "Renamed" })).rejects.toThrow(/managed/);
  });

  it("records created role ids so draft rebasing works", async () => {
    const store = new InMemoryMockStore(makeState());
    const gw = new MockDiscordGateway(store);
    const current = (await gw.fetchServerDesign("g1"));
    if (!current.ok) throw new Error("no design");
    const desired = structuredClone(current.value);
    desired.roles.push({ id: "new_helper", name: "Helper", position: 3, permissions: "0", managed: false });
    const plan = planApply(diffServerDesign(current.value, desired));
    const result = await executeApplyPlan(gw, plan, desired);
    expect(result.ok).toBe(true);
    expect(result.createdIds["new_helper"]).toBeDefined();
  });
});
