import { randomBytes } from "node:crypto";
import { OAUTH_STATE_TTL_MS } from "./config";
import { env, requireSessionSecret } from "./env";
import { signValue, verifySigned } from "./keys";

/**
 * Discord OAuth2 helpers (authorization-code flow).
 * Demo mode bypasses this entirely (see /api/auth/login).
 *
 * `state` is Monarch's CSRF protection for the sign-in itself. It is:
 *   - 128 bits of `crypto.randomBytes` (unpredictable),
 *   - signed with a key derived for *this purpose only*
 *     (`monarch:oauth-state:v1`), so it can never be replayed as a session
 *     cookie signature,
 *   - self-expiring: the deadline travels inside the signed value, so a state
 *     lifted from a log or an old cookie is rejected on its own terms even if
 *     the browser still sends the cookie,
 *   - bound to this browser: `/api/auth/callback` deletes the state cookie on
 *     both success and failure, so a second callback with the same value fails
 *     the cookie-equality check before Discord is even called. This is not a
 *     server-side replay ledger: Discord also enforces single-use authorization codes.
 */

const OAUTH_SCOPES = ["identify", "guilds"];

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.discordClientId,
    redirect_uri: `${env.appUrl}/api/auth/callback`,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    state,
    prompt: "none",
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

/** Seconds the state cookie may live; mirrors the deadline inside the value. */
export const OAUTH_STATE_MAX_AGE_SECONDS = Math.floor(OAUTH_STATE_TTL_MS / 1000);

/** Issue a fresh signed state value. */
export function createOAuthState(now: Date = new Date()): string {
  const nonce = randomBytes(16).toString("base64url");
  const expiresAt = Math.floor((now.getTime() + OAUTH_STATE_TTL_MS) / 1000);
  return signValue(`${nonce}.${expiresAt}`, "oauth-state", requireSessionSecret());
}

export type OAuthStateFailure = "malformed" | "bad-signature" | "expired";

/** Verify a state value: signature first, then its embedded deadline. */
export function verifyOAuthState(
  signed: string,
  now: Date = new Date(),
): { ok: true; nonce: string } | { ok: false; reason: OAuthStateFailure } {
  if (!signed.includes(".")) return { ok: false, reason: "malformed" };
  const result = verifySigned(signed, "oauth-state", requireSessionSecret());
  if (!result.ok) return { ok: false, reason: "bad-signature" };
  const parts = result.value.split(".");
  const [nonce, expiry] = parts;
  if (
    parts.length !== 2 ||
    !nonce ||
    !/^[A-Za-z0-9_-]{22}$/.test(nonce) ||
    !expiry ||
    !/^\d+$/.test(expiry)
  )
    return { ok: false, reason: "malformed" };
  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, nonce };
}

/**
 * Sign an arbitrary value as an OAuth state.
 *
 * Kept for API compatibility. Prefer `createOAuthState()`, which also embeds
 * the deadline — a value signed here has none, so `verifyState` accepts it
 * only for as long as the cookie survives.
 */
export function signState(value: string): string {
  return signValue(value, "oauth-state", requireSessionSecret());
}

/** Constant-time signature check (was `===`, which short-circuits). */
export function verifyState(signed: string): boolean {
  return verifySigned(signed, "oauth-state", requireSessionSecret()).ok;
}

export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export async function exchangeCode(code: string): Promise<DiscordTokenResponse | null> {
  const res = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.discordClientId,
      client_secret: env.discordClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${env.appUrl}/api/auth/callback`,
    }),
  });
  if (!res.ok) return null;
  return (await res.json()) as DiscordTokenResponse;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser | null> {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as DiscordUser;
}

export function avatarUrl(user: DiscordUser): string | null {
  return user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : null;
}
