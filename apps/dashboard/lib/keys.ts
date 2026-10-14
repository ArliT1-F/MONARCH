import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Purpose-separated signing keys.
 *
 * Monarch signs two different things with a key derived from SESSION_SECRET:
 *
 *   1. session cookies      (`monarch_session`)
 *   2. OAuth state values   (`monarch_oauth_state`)
 *
 * Both used to HMAC with the **raw** secret. That makes the two signature
 * spaces interchangeable: a string that verifies as a session id also
 * verifies as an OAuth state, and vice versa. Nothing exploitable followed
 * from it (the state cookie still has to match, and a state value is not
 * accepted as a session id), but it is exactly the mistake HKDF exists to
 * prevent — so each purpose now gets its own derived key.
 *
 * Scope of the change:
 *   - Signature format is unchanged (`<value>.<base64url HMAC-SHA256>`), so no
 *     client or storage change is needed.
 *   - OAuth token *encryption* (`lib/secure-token.ts`) is untouched: it
 *     already derives its own key with scrypt under the distinct context
 *     `monarch:oauth-token:v1`, so encrypted tokens keep decrypting.
 *   - Session cookies signed before this change stop verifying, which signs
 *     existing users out once. That is the intended, self-healing outcome —
 *     no designs, snapshots, templates or encrypted OAuth tokens are changed.
 */

export type KeyPurpose = "session-cookie" | "oauth-state";

/** Public, fixed salt — HKDF's job here is domain separation, not stretching. */
const HKDF_SALT = Buffer.from("monarch:v1", "utf8");
const HKDF_INFO = (purpose: KeyPurpose) => Buffer.from(`monarch:${purpose}:v1`, "utf8");
const KEY_LENGTH = 32;

const keyCache = new Map<string, Buffer>();

/** Derive (and memoise) the 32-byte signing key for one purpose. */
export function deriveSigningKey(purpose: KeyPurpose, secret: string): Buffer {
  const cacheKey = `${purpose}\u0000${secret}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const derived = Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), HKDF_SALT, HKDF_INFO(purpose), KEY_LENGTH),
  );
  keyCache.set(cacheKey, derived);
  // Never keep more than a handful of derived keys around (rotations, tests).
  if (keyCache.size > 32) keyCache.delete(keyCache.keys().next().value as string);
  return derived;
}

/** Constant-time comparison for equal-length signatures. */
export function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** `value.base64url(HMAC-SHA256(value))` */
export function signValue(value: string, purpose: KeyPurpose, secret: string): string {
  const signature = createHmac("sha256", deriveSigningKey(purpose, secret))
    .update(value, "utf8")
    .digest("base64url");
  return `${value}.${signature}`;
}

/** The signature part of a signed value, or null when the shape is wrong. */
export function splitSigned(signed: string): { value: string; signature: string } | null {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0 || dot === signed.length - 1) return null;
  return { value: signed.slice(0, dot), signature: signed.slice(dot + 1) };
}

/** Verify with a purpose-specific key; malformed signatures are rejected. */
export function verifySigned(
  signed: string,
  purpose: KeyPurpose,
  secret: string,
): { ok: true; value: string } | { ok: false; value: null } {
  const parts = splitSigned(signed);
  if (!parts || !secret) return { ok: false, value: null };
  const expected = signValue(parts.value, purpose, secret);
  return safeEqualStrings(signed, expected)
    ? { ok: true, value: parts.value }
    : { ok: false, value: null };
}
