import { NextRequest, NextResponse } from "next/server";
import { requireGuildAccess } from "@/lib/api";
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
