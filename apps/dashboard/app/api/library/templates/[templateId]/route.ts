import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonStorageError, requireSession } from "@/lib/api";
import { deleteTemplate, duplicateTemplate, renameTemplate, templateEnvelope, templateMeta } from "@/lib/library";
import { getStore } from "@/lib/store";

type Params = { params: Promise<{ templateId: string }> };

/**
 * GET /api/library/templates/:id — the full `monarch-template` envelope.
 * `?download=1` sets an attachment Content-Disposition. Owner-scoped by
 * the session: a template id from another user is a plain 404.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  const { templateId } = await params;

  try {
    const record = await getStore().getTemplate(auth.session.userId, templateId);
    if (!record) {
      return jsonError(404, { code: "template.not-found", message: "That template doesn't exist in your library." });
    }
    const envelope = templateEnvelope(record);
    if (!envelope.ok) {
      return jsonError(envelope.status, { code: envelope.code, message: envelope.message });
    }
    const download = req.nextUrl.searchParams.get("download") === "1";
    return new NextResponse(JSON.stringify(envelope.template, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(download
          ? { "Content-Disposition": `attachment; filename="${envelope.fileName}"` }
          : {}),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't read that template.");
  }
}

const PatchBody = z.object({
  action: z.enum(["rename", "duplicate"]),
  name: z.string().max(100).optional(),
});

/** PATCH /api/library/templates/:id — rename or duplicate an owned template. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  const { templateId } = await params;

  const body = PatchBody.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return jsonError(400, { code: "request.invalid", message: "Invalid template update." });
  }

  try {
    const outcome =
      body.data.action === "rename"
        ? await renameTemplate({ ownerId: auth.session.userId, templateId, name: body.data.name ?? "" })
        : await duplicateTemplate({ ownerId: auth.session.userId, templateId });
    if (!outcome.ok) return jsonError(outcome.status, { code: outcome.code, message: outcome.message });
    return NextResponse.json({ template: templateMeta(outcome.template) });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't update that template.");
  }
}

/** DELETE /api/library/templates/:id — remove an owned template. */
export async function DELETE(req: NextRequest, { params }: Params) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  const { templateId } = await params;

  try {
    const outcome = await deleteTemplate({ ownerId: auth.session.userId, templateId });
    if (!outcome.ok) return jsonError(outcome.status, { code: outcome.code, message: outcome.message });
    return NextResponse.json({ ok: true, id: outcome.id });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't delete that template.");
  }
}
