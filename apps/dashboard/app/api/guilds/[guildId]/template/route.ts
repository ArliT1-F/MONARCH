import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonStorageError, requireGuildAccess } from "@/lib/api";
import { exportTemplate, stageImport } from "@/lib/backups";

/** ~2 MB — far above any real server structure, low enough to reject junk uploads. */
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;

/**
 * GET /api/guilds/:guildId/template — download the live structure as a
 * portable Monarch template (snowflakes detached, guild-specific bits removed).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const { guildId } = await params;
  const access = await requireGuildAccess(guildId);
  if (!access.ok) return access.response;

  const outcome = await exportTemplate(guildId);
  if (!outcome.ok) return jsonError(outcome.status, { code: outcome.code, message: outcome.message });
  return new NextResponse(JSON.stringify(outcome.template, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${outcome.fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}

const PostBody = z.object({
  template: z.unknown(),
  mode: z.enum(["replace", "add"]).default("add"),
});

/**
 * POST /api/guilds/:guildId/template — import a template as a draft.
 * The user then reviews the diff in the Server Designer before anything is
 * applied.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const { guildId } = await params;
  const access = await requireGuildAccess(guildId);
  if (!access.ok) return access.response;

  const raw = await req.text();
  if (raw.length > MAX_TEMPLATE_BYTES) {
    return jsonError(413, { code: "template.too-large", message: "That template file is too large (max 2 MB)." });
  }
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    return jsonError(400, { code: "template.invalid", message: "That file isn't valid JSON." });
  }
  const body = PostBody.safeParse(json);
  if (!body.success) {
    return jsonError(400, { code: "template.invalid", message: "Invalid import payload." });
  }

  try {
    const outcome = await stageImport({
      guildId,
      userId: access.ctx.session.userId,
      json: body.data.template,
      mode: body.data.mode,
    });
    if (!outcome.ok) {
      return jsonError(outcome.status, { code: outcome.code, message: outcome.message, detail: outcome.detail });
    }
    return NextResponse.json(outcome);
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't import the template.");
  }
}
