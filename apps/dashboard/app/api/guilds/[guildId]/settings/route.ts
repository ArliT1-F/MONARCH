import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { DesignatedChannelsSchema } from "@monarch/schemas";
import { assertSameOrigin, jsonError, requireGuildAccess } from "@/lib/api";
import { getStore } from "@/lib/store";

/** GET/PUT designated channels (Target Resolver defaults) for a guild. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const { guildId } = await params;
  const access = await requireGuildAccess(guildId);
  if (!access.ok) return access.response;
  const settings = await getStore().getGuildSettings(guildId);
  return NextResponse.json({ settings });
}

const PutBody = z.object({ designatedChannels: DesignatedChannelsSchema });

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
    return jsonError(400, { code: "settings.invalid", message: "Invalid settings payload." });
  }
  await getStore().putGuildSettings({ guildId, designatedChannels: body.data.designatedChannels });
  return NextResponse.json({ ok: true });
}
