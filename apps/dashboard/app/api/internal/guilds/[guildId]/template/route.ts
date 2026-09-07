import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/api";
import { exportTemplate } from "@/lib/backups";
import { assertInternalAuth } from "@/lib/internal-auth";

/**
 * GET /api/internal/guilds/:guildId/template
 * Bot-facing export (used by `/monarch export`): the live structure as a
 * portable Monarch template. Auth: `Authorization: Bearer <INTERNAL_API_TOKEN>`.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;
  const outcome = await exportTemplate(guildId);
  if (!outcome.ok) return jsonError(outcome.status, { code: outcome.code, message: outcome.message });
  return NextResponse.json({ ok: true, fileName: outcome.fileName, template: outcome.template });
}
