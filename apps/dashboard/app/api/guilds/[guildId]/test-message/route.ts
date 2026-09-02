import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { TargetConfigSchema } from "@monarch/schemas";
import { resolveTarget } from "@monarch/discord";
import { renderVariables } from "@monarch/shared";
import { assertSameOrigin, jsonError, requireGuildAccess } from "@/lib/api";
import { getGateway } from "@/lib/discord";
import { getStore } from "@/lib/store";

const Body = z.object({
  target: TargetConfigSchema,
  content: z.string().min(1).max(2000),
});

/**
 * POST /api/guilds/:guildId/test-message
 * "Send Test" — resolves the target through the Target Resolver
 * (designated channel or explicit pick; never a guessed #general).
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
    return jsonError(400, { code: "test.invalid", message: "Invalid test message payload." });
  }

  const gateway = getGateway();
  const settings = await getStore().getGuildSettings(guildId);
  const target = await resolveTarget(gateway, guildId, body.data.target, {
    designatedChannels: settings.designatedChannels,
  });
  if (!target.ok) {
    return NextResponse.json({ error: target.error }, { status: 409 });
  }

  const content = renderVariables(body.data.content, {
    user: { id: access.ctx.session.userId, username: access.ctx.session.username },
    guild: {
      id: guildId,
      name: access.ctx.guild.name,
      memberCount: access.ctx.guild.memberCount ?? undefined,
    },
    channel: { id: target.value.channelId, name: target.value.channelName },
  });

  const sent = await gateway.sendMessage(target.value.channelId, content);
  if (!sent.ok) {
    return NextResponse.json({ error: sent.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true, channelName: target.value.channelName });
}
