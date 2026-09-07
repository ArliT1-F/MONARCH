import { describe, expect, it } from "vitest";
import type { EmbedDesign, MessageDesign } from "@monarch/schemas";
import {
  applyVariablesToEmbed,
  applyVariablesToMessage,
  renderEmbedPayload,
  renderMessagePayload,
} from "../src/content-renderer.js";

describe("renderEmbedPayload", () => {
  it("maps a full embed design to a Discord APIEmbed", () => {
    const embed: EmbedDesign = {
      title: "Hello",
      description: "World",
      url: "https://example.com",
      color: "#5865f2",
      author: { name: "Author", url: "https://example.com/a", iconUrl: "https://example.com/i.png" },
      footer: { text: "foot", iconUrl: "https://example.com/f.png" },
      imageUrl: "https://example.com/big.png",
      thumbnailUrl: "https://example.com/small.png",
      timestamp: "2026-01-02T03:04:05.000Z",
      fields: [{ name: "A", value: "B", inline: true }],
    };
    const p = renderEmbedPayload(embed);
    expect(p.title).toBe("Hello");
    expect(p.color).toBe(0x5865f2);
    expect(p.author).toEqual({ name: "Author", url: "https://example.com/a", icon_url: "https://example.com/i.png" });
    expect(p.footer).toEqual({ text: "foot", icon_url: "https://example.com/f.png" });
    expect(p.image).toEqual({ url: "https://example.com/big.png" });
    expect(p.thumbnail).toEqual({ url: "https://example.com/small.png" });
    expect(p.timestamp).toBe("2026-01-02T03:04:05.000Z");
    expect(p.fields).toEqual([{ name: "A", value: "B", inline: true }]);
  });

  it("stamps 'now' timestamps with the current time", () => {
    const before = Date.now();
    const p = renderEmbedPayload({ fields: [], timestamp: "now" });
    const after = Date.now();
    const ts = new Date(p.timestamp!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("renderMessagePayload", () => {
  it("renders content, embeds and buttons in action rows", () => {
    const message: MessageDesign = {
      content: "Hello!",
      embeds: [{ title: "E", fields: [] }],
      buttons: Array.from({ length: 6 }, (_, i) => ({
        id: `b${i}`,
        label: `B${i}`,
        style: "link",
        url: `https://example.com/${i}`,
      })),
    };
    const p = renderMessagePayload(message);
    expect(p.content).toBe("Hello!");
    expect(p.embeds).toHaveLength(1);
    expect(p.components).toHaveLength(2); // 6 buttons → 2 rows
    expect(p.components![0]!.components).toHaveLength(5);
    expect(p.components![1]!.components).toHaveLength(1);
    expect(p.components![0]!.components[0]).toMatchObject({ type: 2, style: 5, url: "https://example.com/0" });
  });

  it("omits empty fields", () => {
    const p = renderMessagePayload({ content: "", embeds: [], buttons: [] });
    expect(p.content).toBeUndefined();
    expect(p.embeds).toBeUndefined();
    expect(p.components).toBeUndefined();
  });
});

describe("variable resolution", () => {
  const ctx = {
    user: { id: "u1", username: "ada" },
    guild: { id: "g1", name: "Nebula", memberCount: 12 },
    channel: { id: "c1", name: "welcome" },
  };

  it("resolves variables in message content, embeds and buttons", () => {
    const message: MessageDesign = {
      content: "Hi {user} on {server}!",
      embeds: [{ title: "{server}", description: "{member_count} members", fields: [{ name: "{channel}", value: "hi {display_name}" }] }],
      buttons: [{ id: "b", label: "Join {server}", style: "link", url: "https://example.com" }],
    };
    const out = applyVariablesToMessage(message, ctx);
    expect(out.content).toBe("Hi <@u1> on Nebula!");
    expect(out.embeds[0]!.title).toBe("Nebula");
    expect(out.embeds[0]!.description).toBe("12 members");
    expect(out.embeds[0]!.fields[0]).toEqual({ name: "<#c1>", value: "hi ada" });
    expect(out.buttons[0]!.label).toBe("Join Nebula");
  });

  it("resolves variables in embed-only fields", () => {
    const out = applyVariablesToEmbed({ title: "{server}", fields: [] }, ctx);
    expect(out.title).toBe("Nebula");
  });
});
