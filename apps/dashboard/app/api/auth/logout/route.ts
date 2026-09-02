import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/session";
import { assertSameOrigin } from "@/lib/api";

export async function POST(req: NextRequest) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  await destroySession();
  return NextResponse.json({ ok: true });
}
