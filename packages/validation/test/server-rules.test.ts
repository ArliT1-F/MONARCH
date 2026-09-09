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

  it("keeps emoji and non-ASCII separators, drops ASCII punctuation", () => {
    expect(normalizeTextChannelName("📘︱Rules")).toBe("📘︱rules");
    expect(normalizeTextChannelName("rules & info!")).toBe("rules-info");
    expect(normalizeTextChannelName("dev_talk|misc")).toBe("dev_talkmisc");
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

  it("does not nag about names Discord will merely lowercase or dash", () => {
    const d = emptyServerDesign("g", "G");
    d.channels = [
      { id: "a", name: "General Chat", type: "text", position: 0 },
      { id: "b", name: "📘︱rules", type: "text", position: 1 },
    ];
    const report = validateServerDesign(d);
    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it("errors only when a text channel name would collapse to nothing", () => {
    const d = emptyServerDesign("g", "G");
    d.channels = [
      { id: "a", name: "!!!", type: "text", position: 0 },
      { id: "b", name: "📘", type: "text", position: 1 },
    ];
    const report = validateServerDesign(d);
    expect(report.errors.map((e) => e.code)).toEqual(["channel.name.invalid"]);
    expect(report.errors[0]?.target?.id).toBe("a");
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

describe("validateServerDesign — roles", () => {
  it("accepts well-formed roles", () => {
    const d = emptyServerDesign("g", "G");
    d.roles = [
      { id: "r1", name: "Member", position: 1, color: "#88c0d0", managed: false },
      { id: "r2", name: "Mod", position: 5, color: "#ff8800", managed: false },
    ];
    const report = validateServerDesign(d);
    expect(report.errors).toHaveLength(0);
  });

  it("flags role names that are too long", () => {
    const d = emptyServerDesign("g", "G");
    d.roles = [
      { id: "r1", name: "x".repeat(DiscordLimits.role.nameMax + 1), position: 1, managed: false },
    ];
    const report = validateServerDesign(d);
    expect(report.errors.map((e) => e.code)).toContain("role.name.length");
  });

  it("flags malformed role colors", () => {
    const d = emptyServerDesign("g", "G");
    d.roles = [{ id: "r1", name: "Bad", position: 1, color: "red", managed: false }];
    const report = validateServerDesign(d);
    expect(report.errors.map((e) => e.code)).toContain("role.color.format");
  });

  it("flags designs that exceed the role count limit", () => {
    const d = emptyServerDesign("g", "G");
    d.roles = Array.from({ length: DiscordLimits.guild.maxRoles + 1 }, (_, i) => ({
      id: `r${i}`,
      name: `R${i}`,
      position: i,
      managed: false,
    }));
    const report = validateServerDesign(d);
    expect(report.errors.map((e) => e.code)).toContain("guild.roles.max");
  });

  it("warns about duplicate role names but does not error", () => {
    const d = emptyServerDesign("g", "G");
    d.roles = [
      { id: "a", name: "Mod", position: 1, managed: false },
      { id: "b", name: "Mod", position: 2, managed: false },
    ];
    const report = validateServerDesign(d);
    expect(report.warnings.map((w) => w.code)).toContain("role.name.duplicate");
    expect(report.valid).toBe(true);
  });

  it("does not flag managed roles for any rule", () => {
    const d = emptyServerDesign("g", "G");
    d.roles = [
      { id: "r1", name: "MEE6", position: 50, managed: true },
      { id: "r2", name: "MEE6", position: 51, managed: true },
    ];
    const report = validateServerDesign(d);
    expect(report.issues).toHaveLength(0);
  });
});
