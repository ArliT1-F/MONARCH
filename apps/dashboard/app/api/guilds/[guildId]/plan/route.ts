import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ServerDesignSchema } from "@monarch/schemas";
import { validateServerDesign } from "@monarch/validation";
import { diffServerDesign, planApply } from "@monarch/design-engine";
import { assertSameOrigin, jsonError, requireGuildAccess } from "@/lib/api";
import { fetchCurrentDesign } from "@/lib/discord";

const Body = z.object({ design: ServerDesignSchema });

/**
 * POST /api/guilds/:guildId/plan
 * Validate a desired design and diff it against LIVE Discord state.
 * Read-only: never mutates anything.
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
    return jsonError(400, { code: "plan.invalid", message: "The design payload is invalid." });
  }
  if (body.data.design.guildId !== guildId) {
    return jsonError(400, { code: "plan.wrong-guild", message: "This design belongs to a different server." });
  }

  const current = await fetchCurrentDesign(guildId);
  if (!current) {
    return jsonError(502, { code: "guild.state", message: "Monarch couldn't read this server's structure." });
  }

  const validation = validateServerDesign(body.data.design);
  const diff = diffServerDesign(current, body.data.design);
  const plan = planApply(diff);

  return NextResponse.json({
    validation,
    diff,
    destructive: plan.destructive,
    stepCount: plan.steps.length,
  });
}
