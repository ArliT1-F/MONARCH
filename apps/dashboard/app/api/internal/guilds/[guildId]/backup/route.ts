import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, jsonStorageError } from "@/lib/api";
import { createBackup } from "@/lib/backups";
import { assertInternalAuth } from "@/lib/internal-auth";
import { getStore } from "@/lib/store";

/**
 * Bot-facing backups (used by `/monarch backup`).
 * Auth: `Authorization: Bearer <INTERNAL_API_TOKEN>`. The bot has already
 * verified the invoking member holds Manage Server / Administrator.
 *
 * GET  → the guild's snapshot list (metadata only).
 * POST → take a manual backup now.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;
  try {
    const snapshots = await getStore().listSnapshots(guildId);
    return NextResponse.json({
      snapshots: snapshots.slice(0, 10).map(({ design, ...meta }) => ({
        ...meta,
        channelCount: design.channels.length,
        categoryCount: design.categories.length,
      })),
      total: snapshots.length,
    });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't list backups.");
  }
}

const Body = z.object({
  name: z.string().trim().max(100).optional(),
  /** Discord user id of the member who ran the command (audit trail). */
  userId: z.string().min(1).max(32).default("bot"),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return jsonError(400, { code: "snapshot.invalid", message: "Invalid backup payload." });
  }
  try {
    const outcome = await createBackup({ guildId, userId: body.data.userId, name: body.data.name });
    if (!outcome.ok) return jsonError(outcome.status, { code: outcome.code, message: outcome.message });
    return NextResponse.json(outcome);
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't save the backup.");
  }
}
