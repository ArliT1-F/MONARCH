import { NextRequest, NextResponse } from "next/server";
import { assertInternalAuth } from "@/lib/internal-auth";
import { loadWorkspace } from "@/lib/workspace";

/**
 * GET /api/internal/guilds/:guildId/workspace
 * Bot-facing read of the saved content workspace (used by /monarch embed).
 * Authenticated with `Authorization: Bearer <INTERNAL_API_TOKEN>`.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;
  const workspace = await loadWorkspace(guildId);
  return NextResponse.json({ workspace });
}
