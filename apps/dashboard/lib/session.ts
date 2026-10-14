import { cookies } from "next/headers";
import { SESSION_TTL_MS } from "./config";
import { env, requireSessionSecret } from "./env";
import { signValue, verifySigned } from "./keys";
import { getStore, newId, type SessionRecord } from "./store";

/**
 * Session handling.
 *
 * The cookie carries only an opaque session id plus an HMAC signature —
 * OAuth tokens live server-side in the store and never reach the browser.
 *
 * Security properties this file is responsible for:
 *
 *   - **Unpredictable ids.** `newId("sess")` uses `crypto.randomBytes`
 *     (`lib/store.ts`). It used to use `Math.random()`, which is not a CSPRNG:
 *     cookie signatures also protect the id, but unpredictability is required.
 *   - **Purpose-separated signing.** The HMAC key is derived from
 *     SESSION_SECRET with HKDF under `monarch:session-cookie:v1`, so a valid
 *     OAuth-state signature can never double as a session signature.
 *   - **Fail closed.** In production a missing or placeholder SESSION_SECRET
 *     throws `MonarchConfigError` instead of signing with a public default.
 *   - **Bounded lifetime.** `expiresAt` is stored on the record *and* checked
 *     here, so both storage backends honour the same policy (the JSON file
 *     store has no `expiresAt` column of its own).
 *   - **Real revocation.** `destroySession()` deletes the server-side row, so
 *     a logged-out cookie stops working even if it is replayed.
 *   - **Cookie flags.** httpOnly always; Secure whenever the app is served
 *     over https; SameSite=Lax (see `assertSameOrigin` in `lib/api.ts` for the
 *     rest of the CSRF story).
 */
export const SESSION_COOKIE_NAME = "monarch_session";
export const OAUTH_STATE_COOKIE_NAME = "monarch_oauth_state";

/** Cookie attributes shared by the session and OAuth-state cookies. */
export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    // Secure follows the configured public URL, never the request's Host
    // header — an attacker who can influence Host must not be able to
    // downgrade the flag.
    secure: env.appUrl.startsWith("https://"),
    path: "/",
  };
}

function sign(value: string): string {
  return signValue(value, "session-cookie", requireSessionSecret());
}

/** Verify with the current secret. */
function verify(signed: string): string | null {
  const result = verifySigned(signed, "session-cookie", requireSessionSecret());
  return result.ok ? result.value : null;
}

function isExpired(session: SessionRecord, now: number = Date.now()): boolean {
  const at = session.expiresAt
    ? Date.parse(session.expiresAt)
    : Date.parse(session.createdAt) + SESSION_TTL_MS;
  return !Number.isFinite(at) || at <= now;
}

export async function createSession(
  data: Omit<SessionRecord, "id" | "createdAt" | "expiresAt">,
  options: { now?: Date } = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const session: SessionRecord = {
    ...data,
    id: newId("sess"),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  };
  const signed = sign(session.id); // Validate the secret before persisting anything.
  await getStore().putSession(session);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, signed, {
    ...sessionCookieOptions(),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return session.id;
}

export async function getSession(): Promise<SessionRecord | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) return null;
  const id = verify(raw);
  if (!id) return null;
  const session = await getStore().getSession(id);
  if (!session) return null;
  if (isExpired(session)) {
    // Revoke rather than merely ignore: an expired row must not linger.
    await getStore()
      .deleteSession(id)
      .catch(() => undefined);
    return null;
  }
  return session;
}

/**
 * Revoke the session: server-side row first, then the cookie.
 *
 * The cookie is cleared even when the store call fails, so a logout always
 * logs the browser out (failing toward "logged out" is the safe direction).
 * The store failure is then rethrown: "logout said OK but the session row is
 * still alive" is a real security bug and must not be swallowed.
 */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  try {
    const id = raw ? verify(raw) : null;
    if (id) await getStore().deleteSession(id);
  } finally {
    cookieStore.delete(SESSION_COOKIE_NAME);
  }
}

// OAuth `state` issuance/verification lives in `lib/auth.ts` (pure, no
// `next/headers`) so it can be unit-tested directly. This module owns only the
// cookie names and flags both cookies share.
