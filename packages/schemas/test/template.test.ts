import { describe, expect, it } from "vitest";
import { emptyServerDesign, parseServerTemplate, TEMPLATE_FORMAT } from "../src/index.js";
import { renderVariableExamples, renderVariables } from "@monarch/shared";

describe("template envelope", () => {
  it("accepts a valid v1 server template", () => {
    const design = emptyServerDesign("123", "My Guild");
    const res = parseServerTemplate({
      format: TEMPLATE_FORMAT,
      version: 1,
      type: "server",
      data: { ...design, guildId: undefined },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects foreign json with a friendly error", () => {
    const res = parseServerTemplate({ hello: "world" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not a Monarch template/);
  });

  it("rejects future versions", () => {
    const res = parseServerTemplate({ format: TEMPLATE_FORMAT, version: 99, type: "server", data: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/newer/);
  });
});

describe("variable system", () => {
  it("resolves core variables from context", () => {
    const out = renderVariables("Hi {user}, welcome to {server}! ({member_count})", {
      user: { id: "42", username: "kai" },
      guild: { id: "1", name: "Nebula", memberCount: 1234 },
    });
    expect(out).toBe("Hi <@42>, welcome to Nebula! (1,234)");
  });

  it("leaves unknown variables untouched", () => {
    expect(renderVariables("{nope}", {})).toBe("{nope}");
  });

  it("renders examples for previews", () => {
    expect(renderVariableExamples("Welcome {user}")).toBe("Welcome @NewMember");
  });
});
