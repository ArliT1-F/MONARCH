import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/session";
import { assertSameOrigin, jsonStorageError } from "@/lib/api";

export async function POST(req: NextRequest) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  try {
    await destroySession();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonStorageError(
      error,
      "Browser signed out, but server session revocation could not be confirmed.",
    );
  }
}
