import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { requireSessionSecret } from "./env";

/**
 * Encryption-at-rest for Discord OAuth tokens (Session.accessTokenEnc).
 *
 * AES-256-GCM with a key derived from SESSION_SECRET via scrypt. Authenticated
 * encryption: tampered ciphertext fails the tag check and yields undefined
 * rather than garbage. Format: `v1.<iv>.<tag>.<ciphertext>` (base64url).
 *
 * Key derivation is deterministic per secret, so existing sessions keep
 * decrypting across restarts and deploys.
 */

const FORMAT_VERSION = "v1";
const KEY_CONTEXT = "monarch:oauth-token:v1";

/**
 * The key depends only on SESSION_SECRET and the fixed context above, so it is
 * identical across restarts and deploys — which is what keeps tokens written
 * yesterday decryptable today.
 *
 * It deliberately does **not** move to the HKDF-based `deriveSigningKey`
 * helper in lib/keys.ts: that would change the key and silently turn every
 * stored OAuth token into garbage. scrypt under its own context is already
 * purpose-separated from the signing keys.
 *
 * `requireSessionSecret()` throws in production when the secret is missing or
 * a published placeholder, so tokens are never encrypted with a known key.
 */
function deriveKey(): Buffer {
  return scryptSync(requireSessionSecret(), KEY_CONTEXT, 32);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(stored: string | null | undefined): string | undefined {
  if (!stored) return undefined;
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) return undefined;
  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key (rotated SESSION_SECRET) or tampered ciphertext — treat as absent.
    return undefined;
  }
}
