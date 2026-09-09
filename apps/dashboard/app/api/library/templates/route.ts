import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonStorageError, requireGuildAccess, requireSession } from "@/lib/api";
import { saveTemplateFromGuild, saveTemplateFromUpload, templateMeta } from "@/lib/library";
import { getStore } from "@/lib/store";

/** ~2 MB — same cap as guild template imports. */
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;

/**
 * GET /api/library/templates — the signed-in user's saved templates,
 * newest first. Always owner-scoped by the session, never by a body
 * parameter, so one user can never enumerate another user's library.
 */
export async function GET() {
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  try {
    const templates = await getStore().listTemplates(auth.session.userId);
    return NextResponse.json({ templates: templates.map(templateMeta) });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't read your template library.");
  }
}

const CreateBody = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("guild"),
    guildId: z.string().min(1),
    name: z.string().max(100).optional(),
  }),
  z.object({
    source: z.literal("upload"),
    template: z.unknown(),
    name: z.string().max(100).optional(),
  }),
]);

/**
 * POST /api/library/templates — save a template into the user's library.
 * `source: "guild"`  captures the live structure (needs guild access);
 * `source: "upload"` validates a `monarch-template` JSON payload.
 * Neither path touches Discord — the library is Monarch-owned storage.
 */
export async function POST(req: NextRequest) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const raw = await req.text();
  if (raw.length > MAX_TEMPLATE_BYTES) {
    return jsonError(413, { code: "template.too-large", message: "That template is too large (max 2 MB)." });
  }
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    return jsonError(400, { code: "request.invalid", message: "The request body isn't valid JSON." });
  }
  const body = CreateBody.safeParse(json);
  if (!body.success) {
    return jsonError(400, { code: "request.invalid", message: "Invalid library payload." });
  }

  try {
    if (body.data.source === "guild") {
      // Saving a copy of a server's structure requires the same access the
      // export flow needs: member + Manage Server + bot installed.
      const access = await requireGuildAccess(body.data.guildId);
      if (!access.ok) return access.response;
      const outcome = await saveTemplateFromGuild({
        guildId: body.data.guildId,
        userId: auth.session.userId,
        username: auth.session.username,
        name: body.data.name,
      });
      if (!outcome.ok) return jsonError(outcome.status, { code: outcome.code, message: outcome.message });
      return NextResponse.json({ template: templateMeta(outcome.template) });
    }

    const outcome = await saveTemplateFromUpload({
      userId: auth.session.userId,
      json: body.data.template,
      name: body.data.name,
    });
    if (!outcome.ok) {
      return jsonError(outcome.status, { code: outcome.code, message: outcome.message });
    }
    return NextResponse.json({ template: templateMeta(outcome.template) });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't save that template.");
  }
}
