import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_COMMAND_PREFIX, MAX_COMMAND_PREFIX_LENGTH, parseCommandPrefix } from "@monarch/shared";
import { jsonError, jsonStorageError } from "@/lib/api";
import { assertInternalAuth } from "@/lib/internal-auth";
import { getStore } from "@/lib/store";

/**
 * Bot-facing command prefix (used by `!prefix` / `/monarch prefix`).
 * Auth: `Authorization: Bearer <INTERNAL_API_TOKEN>` — the bot has already
 * verified the invoking member holds Manage Server / Administrator before it
 * gets here.
 *
 * GET → the guild's prefix, or `null` when it uses the default.
 * PUT → `{ prefix: "?" }` to change it, `{ prefix: null }` to reset.
 *
 * The bot keeps no database credentials of its own, so this route is the only
 * way a prefix survives a restart. Prefixes are validated here *and* in the
 * bot (same shared rule) so a malformed value can't be stored by either side.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;
  try {
    const stored = await getStore().getCommandPrefix(guildId);
    return NextResponse.json({
      prefix: stored ?? DEFAULT_COMMAND_PREFIX,
      /** True when the guild never set one — the bot words its reply with this. */
      customized: stored !== null,
      default: DEFAULT_COMMAND_PREFIX,
      maxLength: MAX_COMMAND_PREFIX_LENGTH,
    });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't read the command prefix.");
  }
}

const Body = z.object({ prefix: z.union([z.string(), z.null()]) });

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return jsonError(400, {
      code: "prefix.invalid",
      message: "Invalid prefix payload.",
      fix: `Send { "prefix": "?" } or { "prefix": null } to reset.`,
    });
  }

  // `null` resets to the default; anything else has to be a legal prefix.
  const requested = body.data.prefix;
  const parsed = requested === null ? null : parseCommandPrefix(requested);
  if (parsed && !parsed.ok) {
    return jsonError(400, {
      code: "prefix.invalid",
      message: parsed.message,
      fix: `1-${MAX_COMMAND_PREFIX_LENGTH} characters from the allowed set, e.g. "?" or "m!".`,
    });
  }
  const prefix = parsed?.ok ? parsed.prefix : DEFAULT_COMMAND_PREFIX;

  try {
    await getStore().putCommandPrefix(guildId, parsed?.ok ? parsed.prefix : null);
    return NextResponse.json({ ok: true, prefix, customized: parsed !== null && parsed.ok });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't save the command prefix.");
  }
}
