import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin, jsonError, jsonStorageError, requireGuildAccess } from "@/lib/api";
import { stageRestore } from "@/lib/backups";

/**
 * POST /api/guilds/:guildId/snapshots/:snapshotId/restore
 *
 * Stages the snapshot as the caller's draft. Nothing touches Discord here:
 * the Server Designer shows the diff and the apply route enforces the usual
 * validation → destructive confirmation → pre/post snapshot pipeline.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string; snapshotId: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const { guildId, snapshotId } = await params;
  const access = await requireGuildAccess(guildId);
  if (!access.ok) return access.response;

  try {
    const outcome = await stageRestore({ guildId, userId: access.ctx.session.userId, snapshotId });
    if (!outcome.ok) {
      return jsonError(outcome.status, { code: outcome.code, message: outcome.message, fix: outcome.fix });
    }
    return NextResponse.json(outcome);
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't stage the restore.");
  }
}
