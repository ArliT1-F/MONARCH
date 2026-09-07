import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { EmbedDesignSchema, MessageDesignSchema } from "@monarch/schemas";
import { assertSameOrigin, jsonError, jsonStorageError, requireGuildAccess } from "@/lib/api";
import { loadWorkspace, saveWorkspace } from "@/lib/workspace";

const PutBody = z.object({
  embed: EmbedDesignSchema.nullable().optional(),
  message: MessageDesignSchema.nullable().optional(),
});

/**
 * GET/PUT /api/guilds/:guildId/workspace
 * Autosaved content designs for the Embed Builder and Message Designer.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const { guildId } = await params;
  try {
    const access = await requireGuildAccess(guildId);
    if (!access.ok) return access.response;
    const workspace = await loadWorkspace(guildId);
    return NextResponse.json({ workspace });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't load the saved design.");
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const { guildId } = await params;
  try {
    const access = await requireGuildAccess(guildId);
    if (!access.ok) return access.response;

    const body = PutBody.safeParse(await req.json().catch(() => null));
    if (!body.success) {
      return jsonError(400, { code: "workspace.invalid", message: "The workspace payload is invalid." });
    }
    const saved = await saveWorkspace(guildId, {
      embed: body.data.embed,
      message: body.data.message,
    });
    return NextResponse.json({ workspace: saved });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't save the design.");
  }
}
