import { NextRequest, NextResponse } from "next/server";
import { ServerDesignSchema } from "@monarch/schemas";
import { assertSameOrigin, jsonError, requireGuildAccess } from "@/lib/api";
import { getStore } from "@/lib/store";
import { z } from "zod";

const PutBody = z.object({
  design: ServerDesignSchema,
  baseDesign: ServerDesignSchema,
});

/** PUT: autosave the caller's draft. DELETE: discard it. */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const { guildId } = await params;
  const access = await requireGuildAccess(guildId);
  if (!access.ok) return access.response;

  const body = PutBody.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return jsonError(400, { code: "draft.invalid", message: "The draft payload is invalid." });
  }
  if (body.data.design.guildId !== guildId) {
    return jsonError(400, {
      code: "draft.wrong-guild",
      message: "This draft belongs to a different server.",
    });
  }
  await getStore().putDraft(access.ctx.session.userId, {
    guildId,
    design: body.data.design,
    baseDesign: body.data.baseDesign,
    updatedAt: new Date().toISOString(),
  });
  return NextResponse.json({ ok: true, savedAt: new Date().toISOString() });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const { guildId } = await params;
  const access = await requireGuildAccess(guildId);
  if (!access.ok) return access.response;
  await getStore().deleteDraft(guildId, access.ctx.session.userId);
  return NextResponse.json({ ok: true });
}
