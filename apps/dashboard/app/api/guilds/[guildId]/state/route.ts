import { NextRequest, NextResponse } from "next/server";
import { requireGuildAccess } from "@/lib/api";
import { fetchCurrentDesign } from "@/lib/discord";
import { getStore } from "@/lib/store";

/**
 * GET /api/guilds/:guildId/state
 * Current server structure (as Discord sees it) + the caller's draft.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const { guildId } = await params;
  const access = await requireGuildAccess(guildId);
  if (!access.ok) return access.response;

  const current = await fetchCurrentDesign(guildId);
  if (!current) {
    return NextResponse.json(
      { error: { code: "guild.state", message: "Monarch couldn't read this server's structure." } },
      { status: 502 },
    );
  }
  const draft = await getStore().getDraft(guildId, access.ctx.session.userId);
  return NextResponse.json({ current, draft, guild: access.ctx.guild });
}
