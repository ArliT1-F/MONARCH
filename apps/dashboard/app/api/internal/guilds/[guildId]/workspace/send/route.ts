import { NextRequest } from "next/server";
import { z } from "zod";
import { TargetConfigSchema } from "@monarch/schemas";
import { jsonError } from "@/lib/api";
import { assertInternalAuth } from "@/lib/internal-auth";
import { sendOutcomeResponse, sendWorkspaceDesign } from "@/lib/workspace";

const Body = z.object({
  kind: z.enum(["embed", "message"]),
  mode: z.enum(["test", "publish"]).default("test"),
  target: TargetConfigSchema.optional(),
});

/**
 * POST /api/internal/guilds/:guildId/workspace/send
 * Bot-facing test/publish of the saved design (used by /monarch test).
 * Auth: `Authorization: Bearer <INTERNAL_API_TOKEN>`.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;

  const { guildId } = await params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return jsonError(400, { code: "workspace.invalid", message: "Invalid send payload." });
  }

  const outcome = await sendWorkspaceDesign({
    guildId,
    userId: "bot",
    username: "Monarch Bot",
    kind: body.data.kind,
    mode: body.data.mode,
    target: body.data.target,
  });
  return sendOutcomeResponse(outcome);
}
