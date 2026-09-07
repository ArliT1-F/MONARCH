import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { jsonError } from "./api";

/**
 * Server-to-server auth for the /api/internal/* routes used by the Discord
 * bot (/monarch embed, /monarch test). The bot authenticates with
 * `Authorization: Bearer <INTERNAL_API_TOKEN>`; the token must be set in
 * both the dashboard and the bot (see .env.example). Comparison is
 * constant-time over SHA-256 digests so token length is not leaked.
 */

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function isInternalTokenConfigured(): boolean {
  return Boolean(process.env.INTERNAL_API_TOKEN);
}

/** Returns a response to return immediately, or null when authorized. */
export function assertInternalAuth(req: NextRequest): import("next/server").NextResponse | null {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    return jsonError(503, {
      code: "internal.disabled",
      message: "Monarch's internal API is disabled.",
      fix: "Set INTERNAL_API_TOKEN in the dashboard and bot environments to enable bot commands.",
    });
  }
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token || !safeEqual(token, expected)) {
    return jsonError(401, { code: "internal.unauthorized", message: "Invalid internal token." });
  }
  return null;
}
