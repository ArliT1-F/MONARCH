import { NextRequest } from "next/server";
import { z } from "zod";
import { TargetConfigSchema } from "@monarch/schemas";
import { assertSameOrigin, jsonError, requireGuildAccess } from "@/lib/api";
import { sendOutcomeResponse, sendWorkspaceDesign } from "@/lib/workspace";

const Body = z.object({
  kind: z.enum(["embed", "message"]),
  mode: z.enum(["test", "publish"]).default("test"),
  design: z.unknown().optional(),
  target: TargetConfigSchema.optional(),
});

/**
 * POST /api/guilds/:guildId/workspace/send
 * Test-send / publish the saved (or in-memory) embed/message design through
 * the Target Resolver — never a guessed channel.
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

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return jsonError(400, { code: "workspace.invalid", message: "Invalid send payload." });
  }

  const outcome = await sendWorkspaceDesign({
    guildId,
    userId: access.ctx.session.userId,
    username: access.ctx.session.username,
    guildName: access.ctx.guild.name,
    memberCount: access.ctx.guild.memberCount ?? undefined,
    kind: body.data.kind,
    mode: body.data.mode,
    design: body.data.design,
    target: body.data.target,
  });
  return sendOutcomeResponse(outcome);
}
