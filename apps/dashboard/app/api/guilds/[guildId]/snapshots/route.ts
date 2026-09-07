import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonStorageError, requireGuildAccess } from "@/lib/api";
import { createBackup } from "@/lib/backups";
import { getStore } from "@/lib/store";

/** GET /api/guilds/:guildId/snapshots — version history (newest first). */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const { guildId } = await params;
  const access = await requireGuildAccess(guildId);
  if (!access.ok) return access.response;
  const snapshots = await getStore().listSnapshots(guildId);
  return NextResponse.json({
    snapshots: snapshots.map(({ design, ...meta }) => ({
      ...meta,
      channelCount: design.channels.length,
      categoryCount: design.categories.length,
    })),
  });
}

const PostBody = z.object({ name: z.string().trim().max(100).optional() });

/** POST /api/guilds/:guildId/snapshots — take a manual backup of the live structure. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const { guildId } = await params;
  const access = await requireGuildAccess(guildId);
  if (!access.ok) return access.response;

  const body = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return jsonError(400, { code: "snapshot.invalid", message: "Backup names can be at most 100 characters." });
  }
  try {
    const outcome = await createBackup({ guildId, userId: access.ctx.session.userId, name: body.data.name });
    if (!outcome.ok) return jsonError(outcome.status, { code: outcome.code, message: outcome.message });
    return NextResponse.json(outcome);
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't save the backup.");
  }
}
