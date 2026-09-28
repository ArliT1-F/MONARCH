import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalAuth } from "@/lib/internal-auth";
import { jsonError, jsonStorageError } from "@/lib/api";
import { getStore } from "@/lib/store";

const Snowflake = z.string().regex(/^\d{15,25}$/);
const Body = z.object({
  userId: Snowflake,
  jailedBy: Snowflake,
  until: z.string().datetime().nullable(),
  style: z.enum(["random", "soft", "cat", "chaotic", "pirate", "shakespeare", "robot"]),
  reason: z.string().max(200).nullable(),
});
type Context = { params: Promise<{ guildId: string }> };

export async function GET(req: NextRequest, { params }: Context) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;
  try {
    return NextResponse.json({ entries: await getStore().listJailEntries(guildId) });
  } catch (error) {
    return jsonStorageError(error, "Couldn't load jailed members.");
  }
}
export async function PUT(req: NextRequest, { params }: Context) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return jsonError(400, { message: "Invalid jail entry." });
  try {
    await getStore().putJailEntry({ guildId, ...body.data });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonStorageError(error, "Couldn't save jailed member.");
  }
}
export async function DELETE(req: NextRequest, { params }: Context) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId || !Snowflake.safeParse(userId).success) return jsonError(400, { message: "Invalid userId." });
  try {
    await getStore().removeJailEntry(guildId, userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonStorageError(error, "Couldn't remove jailed member.");
  }
}
