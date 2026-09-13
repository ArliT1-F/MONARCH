import { NextRequest, NextResponse } from "next/server";
import { CONFESSION_COOLDOWN_MS } from "@monarch/shared";
import { jsonError, jsonStorageError } from "@/lib/api";
import { assertInternalAuth } from "@/lib/internal-auth";
import { getStore } from "@/lib/store";

/**
 * Bot-facing **confession cooldown** — one window per Discord user, global
 * across every server (confessing in server A is what makes you wait in
 * server B). Auth: `Authorization: Bearer <INTERNAL_API_TOKEN>`; the bot has
 * already resolved the guild's confession channels before it gets here.
 *
 * GET    → `{ nextAllowedAt, ready, cooldownMs }` — when this person may
 *          confess again (`nextAllowedAt: null` = now). The Confess button
 *          reads this so it can answer with a countdown instead of opening a
 *          form whose submission would then be refused.
 * POST   → claim the window: `{ claimed, nextAllowedAt, retryAfterMs,
 *          cooldownMs }`. `claimed: false` means a window is already running —
 *          **200 either way**, because "not yet" is an answer to the question
 *          the bot asked, not a failed request. Claiming is a compare-and-set
 *          in the store, so two racing submissions produce exactly one
 *          confession.
 * DELETE → release a claimed window (`{ ok: true, userId }`). The bot calls
 *          this when posting the confession failed, so a deleted channel or a
 *          missing permission can't lock somebody out for six hours.
 *
 * The window length belongs to the server: `CONFESSION_COOLDOWN_MS` (6h) from
 * @monarch/shared, the same constant the bot words its reply from. The bot
 * never sends one, so the two sides cannot disagree about how long a
 * confession locks you out.
 */

const Snowflake = /^\d{15,25}$/;

function invalidUser() {
  return jsonError(400, {
    code: "confession.invalid-user",
    message: "That isn't a Discord user id.",
    fix: "Call this route with the confessor's snowflake user id.",
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { userId } = await params;
  if (!Snowflake.test(userId)) return invalidUser();

  try {
    const stored = await getStore().getConfessionCooldown(userId);
    return NextResponse.json({
      userId,
      nextAllowedAt: stored.nextAllowedAt,
      /** True when they may confess right now — the field the bot acts on. */
      ready: stored.nextAllowedAt === null,
      cooldownMs: CONFESSION_COOLDOWN_MS,
    });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't read the confession cooldown.");
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { userId } = await params;
  if (!Snowflake.test(userId)) return invalidUser();

  try {
    const claim = await getStore().claimConfessionCooldown(userId);
    const nextAllowedAt = Date.parse(claim.nextAllowedAt);
    return NextResponse.json({
      claimed: claim.claimed,
      userId,
      nextAllowedAt: claim.nextAllowedAt,
      cooldownMs: CONFESSION_COOLDOWN_MS,
      /** 0 once the window has expired — the bot words its reply with this. */
      retryAfterMs: Number.isFinite(nextAllowedAt) ? Math.max(0, nextAllowedAt - Date.now()) : 0,
    });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't reserve the confession cooldown.");
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { userId } = await params;
  if (!Snowflake.test(userId)) return invalidUser();

  try {
    await getStore().releaseConfessionCooldown(userId);
    return NextResponse.json({ ok: true, userId });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't release the confession cooldown.");
  }
}
