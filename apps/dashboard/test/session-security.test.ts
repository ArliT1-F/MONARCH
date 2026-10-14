import { randomBytes, createHmac, createCipheriv, scryptSync } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_TTL_MS } from "@/lib/config";
import { signValue, verifySigned } from "@/lib/keys";
import type { SessionRecord } from "@/lib/store";
const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  records: new Map<string, SessionRecord>(),
  set: vi.fn(),
  del: vi.fn(),
  put: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (mocks.jar.has(key) ? { value: mocks.jar.get(key) } : undefined),
    set: (key: string, value: string, opts: unknown) => {
      mocks.jar.set(key, value);
      mocks.set(key, value, opts);
    },
    delete: (key: string) => {
      mocks.jar.delete(key);
      mocks.del(key);
    },
  }),
}));
vi.mock("@/lib/store", async () => {
  const { randomBytes } = await import("node:crypto");
  return {
    newId: (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`,
    getStore: () => ({
      getSession: async (id: string) => mocks.records.get(id) ?? null,
      putSession: async (s: SessionRecord) => {
        mocks.put(s);
        mocks.records.set(s.id, s);
      },
      deleteSession: async (id: string) => {
        mocks.revoke(id);
        mocks.records.delete(id);
      },
    }),
  };
});
import { createSession, getSession, destroySession, SESSION_COOKIE_NAME } from "@/lib/session";
import { createOAuthState, verifyOAuthState } from "@/lib/auth";
import { decryptSecret } from "@/lib/secure-token";
const user = { userId: "123", username: "Designer", avatarUrl: null };
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("hex"));
  vi.stubEnv("APP_URL", "https://monarch.example.com");
  mocks.jar.clear();
  mocks.records.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("sessions and signatures", () => {
  it("persists a bounded session and sets secure HTTP-only Lax cookies", async () => {
    const id = await createSession(user);
    expect(await getSession()).toMatchObject({ id, ...user });
    const row = mocks.records.get(id)!;
    expect(Date.parse(row.expiresAt!) - Date.parse(row.createdAt)).toBe(SESSION_TTL_MS);
    expect(mocks.set).toHaveBeenCalledWith(SESSION_COOKIE_NAME, expect.any(String), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
  });
  it("rejects signature tampering before looking up a session", async () => {
    await createSession(user);
    const raw = mocks.jar.get(SESSION_COOKIE_NAME)!;
    mocks.jar.set(SESSION_COOKIE_NAME, raw + "x");
    expect(await getSession()).toBeNull();
  });
  it("rejects expired and malformed expiry records, including legacy sessions", async () => {
    for (const expiry of [new Date(0).toISOString(), "invalid", undefined]) {
      const id = await createSession(user, { now: new Date(0) });
      mocks.records.get(id)!.expiresAt = expiry;
      expect(await getSession()).toBeNull();
    }
  });
  it("revokes the row on logout; replay of the old cookie fails", async () => {
    await createSession(user);
    const raw = mocks.jar.get(SESSION_COOKIE_NAME)!;
    await destroySession();
    mocks.jar.set(SESSION_COOKIE_NAME, raw);
    expect(await getSession()).toBeNull();
  });
  it("does not falsely report successful revocation when storage fails", async () => {
    await createSession(user);
    mocks.revoke.mockImplementationOnce(() => {
      throw new Error("storage failure");
    });
    await expect(destroySession()).rejects.toThrow("storage failure");
    expect(mocks.jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });
  it("refuses missing production secrets before storing a session", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    await expect(createSession(user)).rejects.toThrow("SESSION_SECRET");
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it("separates session and OAuth signing contexts and rejects old raw-HMAC cookies", () => {
    const secret = process.env.SESSION_SECRET!;
    const signed = signValue("sess_id", "session-cookie", secret);
    expect(verifySigned(signed, "oauth-state", secret).ok).toBe(false);
    const legacy = `sess_id.${createHmac("sha256", secret).update("sess_id").digest("base64url")}`;
    expect(verifySigned(legacy, "session-cookie", secret).ok).toBe(false);
  });
  it("keeps pre-existing v1 encrypted OAuth tokens readable", () => {
    const key = scryptSync(process.env.SESSION_SECRET!, "monarch:oauth-token:v1", 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update("test-access-token"), cipher.final()]);
    const stored = [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      data.toString("base64url"),
    ].join(".");
    expect(decryptSecret(stored)).toBe("test-access-token");
  });
});
describe("OAuth state", () => {
  it("issues unique state values, checks signatures and expires at ten minutes", () => {
    const now = new Date();
    const state = createOAuthState(now);
    expect(state).not.toBe(createOAuthState(now));
    expect(verifyOAuthState(state, now).ok).toBe(true);
    expect(verifyOAuthState(state + "x", now).ok).toBe(false);
    expect(verifyOAuthState(state, new Date(now.getTime() + 600_000)).ok).toBe(false);
  });
});
