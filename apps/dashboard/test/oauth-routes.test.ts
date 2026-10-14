import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/session", () => ({
  createSession: mocks.create,
  getSession: vi.fn(),
  sessionCookieOptions: () => ({ httpOnly: true, sameSite: "lax", secure: true, path: "/" }),
}));
vi.mock("@/lib/discord", () => ({ getGuildSummary: vi.fn() }));
import { GET as login } from "@/app/api/auth/login/route";
import { GET as callback } from "@/app/api/auth/callback/route";
import { createOAuthState } from "@/lib/auth";
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("APP_URL", "https://monarch.example.com");
  vi.stubEnv("MONARCH_DEMO", "");
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("DISCORD_CLIENT_ID", "123");
  vi.stubEnv("DISCORD_CLIENT_SECRET", "test-secret");
  vi.stubEnv("DISCORD_BOT_TOKEN", "test-token");
  vi.stubGlobal("fetch", vi.fn());
  mocks.create.mockResolvedValue("sess_test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function cb(state: string, cookie: string | null = state) {
  return new NextRequest(
    `https://monarch.example.com/api/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
    {
      headers: cookie ? { cookie: `monarch_oauth_state=${cookie}` } : {},
    },
  );
}
describe("OAuth routes", () => {
  it("sets HTTP-only Secure Lax state cookies with a ten-minute lifetime", async () => {
    const res = await login(new NextRequest("https://monarch.example.com/api/auth/login"));
    const cookie = res.cookies.get("monarch_oauth_state")!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", maxAge: 600 });
    expect(new URL(res.headers.get("location")!).searchParams.get("state")).toBe(cookie.value);
  });
  it("rejects absent, mismatched, tampered and expired state without calling Discord", async () => {
    const state = createOAuthState();
    for (const req of [
      cb(state, null),
      cb(state, "other"),
      cb(state + "x"),
      cb(createOAuthState(new Date(0))),
    ]) {
      const res = await callback(req);
      expect(res.headers.get("location")).toContain("error=");
      expect(res.cookies.get("monarch_oauth_state")?.value).toBe("");
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("clears state after success and rejects a repeat callback without the cookie", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(
        Response.json({ id: "123", username: "test", avatar: null, global_name: null }),
      );
    const state = createOAuthState();
    const res = await callback(cb(state));
    expect(res.headers.get("location")).toBe("https://monarch.example.com/select");
    expect(res.cookies.get("monarch_oauth_state")?.value).toBe("");
    await callback(cb(state, null));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("clears state and returns a safe error if the token endpoint throws", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("sensitive-network-detail"));
    const res = await callback(cb(createOAuthState()));
    expect(res.headers.get("location")).not.toContain("sensitive-network-detail");
    expect(res.cookies.get("monarch_oauth_state")?.value).toBe("");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("fails closed on production login with missing configuration, even with demo requested", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("MONARCH_DEMO", "1");
    expect(
      (await login(new NextRequest("https://monarch.example.com/api/auth/login"))).status,
    ).toBe(503);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
