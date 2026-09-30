import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalAuth } from "@/lib/internal-auth";
import { jsonError, jsonStorageError } from "@/lib/api";
import { getStore } from "@/lib/store";

const Body = z.object({ catId: z.string().min(1).max(240) });

/** Atomically increment a cat's global pull count. */
export async function POST(req: NextRequest) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return jsonError(400, { message: "Invalid cat pull payload." });
  }

  try {
    const total = await getStore().incrementCatCardPull(body.data.catId);
    return NextResponse.json({ total });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't update this cat's global pull count.");
  }
}
