import { describe, expect, it } from "vitest";
import { parseStoredWorkspace } from "@/lib/workspace";

/**
 * Stored workspace designs must degrade gracefully: a row written by an
 * older/newer schema (or hand-edited corruption) must open as an empty
 * editor — never throw and 500 the workspace route (which used to crash
 * the Embed Builder / Message Designer with a raw `JSON.parse…` string).
 */
describe("parseStoredWorkspace", () => {
  it("returns nulls for an empty workspace", () => {
    expect(parseStoredWorkspace({ embed: null, message: null })).toEqual({
      embed: null,
      message: null,
    });
  });

  it("passes valid stored designs through", () => {
    const stored = {
      embed: { title: "Hi {server}", fields: [{ name: "n", value: "v", inline: false }] },
      message: { content: "hello", embeds: [], buttons: [] },
    };
    const parsed = parseStoredWorkspace(stored);
    expect(parsed.embed?.title).toBe("Hi {server}");
    expect(parsed.message?.content).toBe("hello");
  });

  it("drops corrupt stored designs instead of throwing", () => {
    expect(() =>
      parseStoredWorkspace({ embed: { title: 123 }, message: "nope" }),
    ).not.toThrow();
    expect(parseStoredWorkspace({ embed: { title: 123 }, message: "nope" })).toEqual({
      embed: null,
      message: null,
    });
  });

  it("keeps the valid half when only one side is corrupt", () => {
    const parsed = parseStoredWorkspace({
      embed: { description: "still good", fields: [] },
      message: { content: 42 },
    });
    expect(parsed.embed?.description).toBe("still good");
    expect(parsed.message).toBeNull();
  });
});
