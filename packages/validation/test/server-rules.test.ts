import { describe, expect, it } from "vitest";
import { emptyServerDesign } from "@monarch/schemas";
import { validateServerDesign, normalizeTextChannelName } from "../src/server-rules.js";
import { DiscordLimits } from "../src/limits.js";

describe("normalizeTextChannelName", () => {
  it("lowercases and dashes like Discord", () => {
    expect(normalizeTextChannelName("General Chat")).toBe("general-chat");
    expect(normalizeTextChannelName("  Hello   World ")).toBe("hello-world");
    expect(normalizeTextChannelName("média-café")).toBe("média-café");
  });
});

describe("validateServerDesign", () => {
  it("passes a clean design", () => {
    const d = emptyServerDesign("g", "G");
    d.categories = [{ id: "c1", name: "INFO", position: 0 }];
    d.channels = [{ id: "ch1", name: "welcome", type: "text", position: 0, parentId: "c1" }];
    const report = validateServerDesign(d);
    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it("errors on empty and overlong names", () => {
    const d = emptyServerDesign("g", "G");
    d.channels = [
      { id: "a", name: "", type: "text", position: 0 },
      { id: "b", name: "x".repeat(101), type: "text", position: 1 },
    ];
    const report = validateServerDesign(d);
    expect(report.valid).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain("channel.name.length");
    expect(report.errors).toHaveLength(2);
  });

  it("warns when Discord will normalize a text channel name", () => {
    const d = emptyServerDesign("g", "G");
    d.channels = [{ id: "a", name: "General Chat", type: "text", position: 0 }];
    const report = validateServerDesign(d);
    expect(report.valid).toBe(true);
    expect(report.warnings[0]?.code).toBe("channel.name.normalized");
    expect(report.warnings[0]?.fix).toContain("general-chat");
  });

  it("errors on orphaned channels and overlong topics", () => {
    const d = emptyServerDesign("g", "G");
    d.channels = [
      { id: "a", name: "chat", type: "text", position: 0, parentId: "ghost" },
      { id: "b", name: "info", type: "text", position: 1, topic: "y".repeat(DiscordLimits.channel.topicMax + 1) },
    ];
    const report = validateServerDesign(d);
    const codes = report.errors.map((e) => e.code);
    expect(codes).toContain("channel.parent.missing");
    expect(codes).toContain("channel.topic.length");
  });

  it("enforces category capacity", () => {
    const d = emptyServerDesign("g", "G");
    d.categories = [{ id: "c1", name: "BIG", position: 0 }];
    d.channels = Array.from({ length: 51 }, (_, i) => ({
      id: `ch${i}`,
      name: `chan-${i}`,
      type: "text" as const,
      position: i,
      parentId: "c1",
    }));
    const report = validateServerDesign(d);
    expect(report.errors.map((e) => e.code)).toContain("category.channels.max");
  });
});
