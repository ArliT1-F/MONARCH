import { describe, expect, it } from "vitest";
import { emptyServerDesign } from "@monarch/schemas";
import {
  MockDiscordGateway,
  InMemoryMockStore,
  type MockState,
} from "../src/mock-gateway.js";
import { resolveTarget } from "../src/target-resolver.js";
import { diffServerDesign, planApply } from "@monarch/design-engine";
import { executeApplyPlan } from "../src/executor.js";

function makeState(): MockState {
  const design = emptyServerDesign("g1", "Guild");
  design.categories = [{ id: "cat1", name: "INFO", position: 0 }];
  design.channels = [
    { id: "ch1", name: "welcome", type: "text", position: 0, parentId: "cat1" },
    { id: "ch2", name: "lounge", type: "voice", position: 1, parentId: "cat1" },
  ];
  design.designatedChannels = { testing: "ch1" };
  return {
    guilds: {
      g1: {
        id: "g1",
        name: "Guild",
        memberCount: 10,
        botInstalled: true,
        botPermissions: "8",
        design,
        outbox: [],
      },
    },
  };
}

describe("resolveTarget", () => {
  it("resolves a designated channel", async () => {
    const gw = new MockDiscordGateway(new InMemoryMockStore(makeState()));
    const res = await resolveTarget(gw, "g1", { kind: "designated", key: "testing" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.channelName).toBe("welcome");
  });

  it("fails with guidance when nothing is designated", async () => {
    const gw = new MockDiscordGateway(new InMemoryMockStore(makeState()));
    const res = await resolveTarget(gw, "g1", { kind: "designated", key: "welcome" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("target.not-designated");
  });

  it("refuses cross-guild explicit targets", async () => {
    const gw = new MockDiscordGateway(new InMemoryMockStore(makeState()));
    const res = await resolveTarget(gw, "g1", {
      kind: "explicit",
      guildId: "other",
      channelId: "ch1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("target.wrong-guild");
  });

  it("refuses voice channels as message targets", async () => {
    const gw = new MockDiscordGateway(new InMemoryMockStore(makeState()));
    const res = await resolveTarget(gw, "g1", {
      kind: "explicit",
      guildId: "g1",
      channelId: "ch2",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("target.channel-kind");
  });
});

describe("executeApplyPlan against the mock gateway", () => {
  it("applies create/rename/move/delete and resolves local parent ids", async () => {
    const store = new InMemoryMockStore(makeState());
    const gw = new MockDiscordGateway(store);

    const current = (await gw.fetchServerDesign("g1"));
    if (!current.ok) throw new Error("no design");
    const desired = structuredClone(current.value);
    desired.categories.push({ id: "new_cat", name: "COMMUNITY", position: 1 });
    desired.channels.push({ id: "new_ch", name: "general", type: "text", position: 0, parentId: "new_cat" });
    desired.channels[0]!.name = "start-here";
    desired.channels = desired.channels.filter((c) => c.id !== "ch2");

    const plan = planApply(diffServerDesign(current.value, desired));
    const result = await executeApplyPlan(gw, plan, desired);
    expect(result.ok).toBe(true);

    const after = await gw.fetchServerDesign("g1");
    if (!after.ok) throw new Error("no design");
    expect(after.value.categories.map((c) => c.name)).toContain("COMMUNITY");
    const created = after.value.channels.find((c) => c.name === "general");
    expect(created).toBeDefined();
    // the new channel's parent must be the REAL id of the created category
    const newCat = after.value.categories.find((c) => c.name === "COMMUNITY");
    expect(created?.parentId).toBe(newCat?.id);
    expect(after.value.channels.find((c) => c.id === "ch1")?.name).toBe("start-here");
    expect(after.value.channels.find((c) => c.id === "ch2")).toBeUndefined();

    // re-diffing fresh state against the desired design shows no drift
    const rediff = diffServerDesign(after.value, {
      ...desired,
      categories: desired.categories.map((c) => (c.id === "new_cat" ? { ...c, id: result.createdIds["new_cat"]! } : c)),
      channels: desired.channels.map((c) => ({
        ...c,
        id: c.id === "new_ch" ? result.createdIds["new_ch"]! : c.id,
        parentId: c.parentId === "new_cat" ? result.createdIds["new_cat"]! : c.parentId,
      })),
    });
    expect(rediff.isEmpty).toBe(true);
  });
});
