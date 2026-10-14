import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ session: vi.fn(), guild: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/discord", () => ({ getGuildSummary: mocks.guild }));
import { assertSameOrigin, requireGuildAccess } from "@/lib/api";
import { assertInternalAuth } from "@/lib/internal-auth";
const origin = "https://monarch.example.com";
function request(input: Record<string, string | undefined> = {}) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(input))
    if (value !== undefined) headers.set(key, value);
  return new NextRequest(`${origin}/api/guilds/123/settings`, { method: "PUT", headers });
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("MONARCH_DEMO", "1");
  vi.stubEnv("APP_URL", origin);
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "");
  mocks.session.mockResolvedValue({ userId: "123" });
  mocks.guild.mockResolvedValue({ userCanDesign: true, botInstalled: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("mutation origin guard", () => {
  it.each([
    {},
    { origin: "https://attacker.example" },
    { origin: "null" },
    { origin, "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "none" },
    { origin: "https://attacker.example", "sec-fetch-site": "same-origin" },
    {
      origin: "https://attacker.example",
      host: "attacker.example",
      "x-forwarded-host": "attacker.example",
    },
  ])("rejects unverified/cross-origin requests", (headers) => {
    expect(assertSameOrigin(request(headers))?.status).toBe(403);
  });
  it.each([
    { origin },
    { origin, "sec-fetch-site": "same-origin" },
    { "sec-fetch-site": "same-origin" },
  ])("allows positive same-origin evidence", (headers) => {
    expect(assertSameOrigin(request(headers))).toBeNull();
  });
});
describe("guild authorization", () => {
  it("rejects an invalid session before looking up the guild", async () => {
    mocks.session.mockResolvedValue(null);
    const result = await requireGuildAccess("123");
    expect(!result.ok && result.response.status).toBe(401);
    expect(mocks.guild).not.toHaveBeenCalled();
  });
  it("rejects inaccessible guilds and insufficient user permissions", async () => {
    mocks.guild.mockResolvedValueOnce(null);
    const missing = await requireGuildAccess("123");
    expect(!missing.ok && missing.response.status).toBe(404);
    mocks.guild.mockResolvedValueOnce({ userCanDesign: false });
    const denied = await requireGuildAccess("123");
    expect(!denied.ok && denied.response.status).toBe(403);
  });
  it("requires a bot for mutation routes", async () => {
    mocks.guild.mockResolvedValue({ userCanDesign: true, botInstalled: false });
    const result = await requireGuildAccess("123");
    expect(!result.ok && result.response.status).toBe(409);
    expect((await requireGuildAccess("123", { needBot: false })).ok).toBe(true);
  });
});
describe("internal bearer authentication", () => {
  it("disables missing and weak production tokens without returning their values", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const value of ["", "dev-only-secret-change-me", "a".repeat(64)]) {
      vi.stubEnv("INTERNAL_API_TOKEN", value);
      const res = assertInternalAuth(request({ authorization: `Bearer ${value}` }))!;
      expect(res.status).toBe(503);
      if (value) expect(await res.text()).not.toContain(value);
    }
  });
  it("requires the exact configured token", () => {
    const token = randomBytes(32).toString("hex");
    vi.stubEnv("INTERNAL_API_TOKEN", token);
    expect(assertInternalAuth(request({ authorization: `Bearer ${token}` }))).toBeNull();
    for (const header of ["", "Basic abc", `Bearer ${token}x`, "Bearer wrong"]) {
      expect(assertInternalAuth(request({ authorization: header }))?.status).toBe(401);
    }
  });
});
