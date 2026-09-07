import { describe, expect, it } from "vitest";
import { emptyEmbedDesign, emptyMessageDesign, type EmbedDesign } from "@monarch/schemas";
import { validateEmbedDesign, validateMessageDesign } from "../src/content-rules.js";

describe("validateEmbedDesign", () => {
  it("rejects an empty embed", () => {
    const report = validateEmbedDesign(emptyEmbedDesign());
    expect(report.valid).toBe(false);
    expect(report.errors[0]?.code).toBe("embed.empty");
  });

  it("accepts a populated embed", () => {
    const embed: EmbedDesign = { title: "Hello", description: "World", fields: [] };
    expect(validateEmbedDesign(embed).valid).toBe(true);
  });

  it("rejects embeds over 6000 total characters", () => {
    const embed: EmbedDesign = {
      title: "x".repeat(256),
      description: "y".repeat(4096),
      fields: [{ name: "n", value: "v".repeat(1700) }],
    };
    const report = validateEmbedDesign(embed);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "embed.total-length")).toBe(true);
  });

  it("rejects more than 25 fields", () => {
    const embed: EmbedDesign = {
      title: "T",
      fields: Array.from({ length: 26 }, (_, i) => ({ name: `f${i}`, value: "v" })),
    };
    const report = validateEmbedDesign(embed);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "embed.fields-count")).toBe(true);
  });
});

describe("validateMessageDesign", () => {
  it("rejects an empty message", () => {
    const report = validateMessageDesign(emptyMessageDesign());
    expect(report.valid).toBe(false);
    expect(report.errors[0]?.code).toBe("message.empty");
  });

  it("rejects content over 2000 characters", () => {
    const report = validateMessageDesign({ content: "x".repeat(2001), embeds: [], buttons: [] });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "message.content-length")).toBe(true);
  });

  it("rejects more than 10 embeds", () => {
    const report = validateMessageDesign({
      content: "hi",
      embeds: Array.from({ length: 11 }, () => ({ title: "t", fields: [] })),
      buttons: [],
    });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "message.embeds-count")).toBe(true);
  });

  it("requires a URL on link buttons", () => {
    const report = validateMessageDesign({
      content: "hi",
      embeds: [],
      buttons: [{ id: "b1", label: "Go", style: "link" }],
    });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "button.link-missing-url")).toBe(true);
  });

  it("warns when a non-link button carries a URL", () => {
    const report = validateMessageDesign({
      content: "hi",
      embeds: [],
      buttons: [{ id: "b1", label: "Go", style: "primary", url: "https://example.com" }],
    });
    expect(report.valid).toBe(true);
    expect(report.warnings.some((e) => e.code === "button.url-on-interaction")).toBe(true);
  });
});
