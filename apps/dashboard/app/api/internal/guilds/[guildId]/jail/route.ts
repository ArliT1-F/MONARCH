import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalAuth } from "@/lib/internal-auth";
import { jsonError, jsonStorageError } from "@/lib/api";
import { getStore } from "@/lib/store";

const Snowflake = z.string().regex(/^\d{15,25}$/);
const Body = z.object({
  channelId: Snowflake.nullable(),
  roleId: Snowflake.nullable(),
  staffRoleIds: z.array(Snowflake).max(100),
}).refine((value) => Boolean(value.channelId) === Boolean(value.roleId));
type Context = { params: Promise<{ guildId: string }> };

export async function GET(req: NextRequest, { params }: Context) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;
  try {
    const { channelId, roleId, staffRoleIds } = await getStore().getJailConfig(guildId);
    return NextResponse.json({ channelId, roleId, staffRoleIds });
  } catch (error) {
    return jsonStorageError(error, "Couldn't load jail setup.");
  }
}

export async function PUT(req: NextRequest, { params }: Context) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return jsonError(400, {
      message: "Provide a channel and role together (or both null) and staff role IDs.",
    });
  }
  try {
    await getStore().putJailConfig(guildId, {
      guildId,
      ...body.data,
      staffRoleIds: [...new Set(body.data.staffRoleIds)],
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonStorageError(error, "Couldn't save jail setup.");
  }
}
