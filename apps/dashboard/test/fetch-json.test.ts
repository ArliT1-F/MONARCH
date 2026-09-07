import { describe, expect, it } from "vitest";
import { apiErrorMessage, networkErrorMessage, readJsonSafe } from "@/lib/fetch-json";

/**
 * Regression tests for the `JSON.parse: unexpected end of data…` crash on
 * the Embed Builder / Message Designer: API responses with empty or
 * non-JSON bodies must never throw — they degrade to friendly messages.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("readJsonSafe", () => {
  it("parses a JSON body", async () => {
    const res = jsonResponse({ workspace: { embed: null } });
    await expect(readJsonSafe(res)).resolves.toEqual({ workspace: { embed: null } });
  });

  it("returns null for an empty body instead of throwing", async () => {
    const res = new Response("", { status: 500 });
    await expect(readJsonSafe(res)).resolves.toBeNull();
  });

  it("returns null for a non-JSON body such as an HTML error page", async () => {
    const res = new Response("<html><body>Internal Server Error</body></html>", { status: 500 });
    await expect(readJsonSafe(res)).resolves.toBeNull();
  });
});

describe("apiErrorMessage", () => {
  it("prefers the server error message with reason and fix", () => {
    const data = {
      error: {
        code: "guild.bot-missing",
        message: "Monarch isn't installed in this server yet.",
        fix: "Invite the Monarch bot, then reload.",
      },
    };
    const res = jsonResponse(data, 409);
    expect(apiErrorMessage(data, res, "fallback")).toBe(
      "Monarch isn't installed in this server yet. Invite the Monarch bot, then reload.",
    );
  });

  it("maps a 401 with an empty body to a session-expired message", () => {
    const res = new Response("", { status: 401 });
    expect(apiErrorMessage(null, res, "fallback")).toContain("session expired");
  });

  it("maps a 5xx with an empty body to a generic retry message", () => {
    const res = new Response("", { status: 500 });
    expect(apiErrorMessage(null, res, "fallback")).toContain("unexpected error");
  });

  it("uses the fallback for other statuses with no usable body", () => {
    const res = new Response("", { status: 409 });
    expect(apiErrorMessage(null, res, "Couldn't load the saved design.")).toBe(
      "Couldn't load the saved design.",
    );
  });
});

describe("networkErrorMessage", () => {
  it("maps a failed fetch (TypeError) to a connection message", () => {
    expect(networkErrorMessage(new TypeError("Failed to fetch"))).toContain("check your connection");
  });

  it("keeps explicit error messages", () => {
    expect(networkErrorMessage(new Error("Monarch couldn't load this server."))).toBe(
      "Monarch couldn't load this server.",
    );
  });
});
