import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalAuth } from "@/lib/internal-auth";
import { jsonError, jsonStorageError } from "@/lib/api";
import { getStore } from "@/lib/store";

const SNOWFLAKE = /^\d{15,25}$/;
const Body = z.object({
  guildId: z.string().regex(SNOWFLAKE),
  catId: z.string().min(1).max(240),
  userId: z.string().regex(SNOWFLAKE),
});

/** Claim one cat per server; concurrent button presses have one winner. */
export async function POST(req: NextRequest) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return jsonError(400, { message: "Invalid cat adoption payload." });
  }

  try {
    const adopted = await getStore().adoptCatCard(
      body.data.guildId,
      body.data.catId,
      body.data.userId,
    );
    return NextResponse.json({ adopted });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't save this cat adoption.");
  }
}
