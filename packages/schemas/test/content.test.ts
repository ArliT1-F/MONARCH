import { describe, expect, it } from "vitest";
import {
  emptyEmbedDesign,
  emptyMessageDesign,
  EmbedDesignSchema,
  GuildWorkspaceSchema,
  MessageDesignSchema,
} from "../src/content.js";

describe("content schemas", () => {
  it("defaults an empty embed", () => {
    const e = emptyEmbedDesign();
    expect(e.fields).toEqual([]);
    expect(EmbedDesignSchema.parse(e)).toEqual(e);
  });

  it("defaults an empty message", () => {
    const m = emptyMessageDesign();
    expect(m).toMatchObject({ content: "", embeds: [], buttons: [] });
  });

  it("rejects invalid colors", () => {
    expect(EmbedDesignSchema.safeParse({ fields: [], color: "red" }).success).toBe(false);
    expect(EmbedDesignSchema.safeParse({ fields: [], color: "#ff0000" }).success).toBe(true);
  });

  it("allows the 'now' timestamp sentinel", () => {
    expect(EmbedDesignSchema.safeParse({ fields: [], timestamp: "now" }).success).toBe(true);
  });

  it("parses a guild workspace with nullable designs", () => {
    const w = GuildWorkspaceSchema.parse({ guildId: "g1", embed: null, message: null });
    expect(w).toEqual({ guildId: "g1", embed: null, message: null });
    const full = GuildWorkspaceSchema.parse({
      guildId: "g1",
      embed: { title: "t", fields: [] },
      message: { content: "hi" },
    });
    expect(full.message?.content).toBe("hi");
  });

  it("rejects more than 10 embeds at the schema level", () => {
    expect(
      MessageDesignSchema.safeParse({
        content: "x",
        embeds: Array.from({ length: 11 }, () => ({ title: "t" })),
      }).success,
    ).toBe(false);
  });
});
