import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "./env";
import { getStore, newId, type SessionRecord } from "./store";

/**
 * Session handling.
 *
 * The cookie carries only an opaque session id plus an HMAC signature —
 * OAuth tokens live server-side in the store and never reach the browser.
 */
const COOKIE_NAME = "monarch_session";

function sign(value: string): string {
  return createHmac("sha256", env.sessionSecret).update(value).digest("base64url");
}

function verify(value: string, signature: string): boolean {
  const expected = sign(value);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createSession(
  data: Omit<SessionRecord, "id" | "createdAt">,
): Promise<string> {
  const session: SessionRecord = {
    ...data,
    id: newId("sess"),
    createdAt: new Date().toISOString(),
  };
  await getStore().putSession(session);
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, `${session.id}.${sign(session.id)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.appUrl.startsWith("https"),
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
  });
  return session.id;
}

export async function getSession(): Promise<SessionRecord | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!verify(id, sig)) return null;
  return getStore().getSession(id);
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  if (raw) {
    const id = raw.slice(0, raw.lastIndexOf("."));
    await getStore().deleteSession(id);
  }
  cookieStore.delete(COOKIE_NAME);
}
