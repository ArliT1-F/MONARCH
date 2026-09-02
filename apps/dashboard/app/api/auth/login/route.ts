import { NextRequest, NextResponse } from "next/server";
import { isDemoMode, env } from "@/lib/env";
import { buildAuthorizeUrl, signState } from "@/lib/auth";
import { createSession } from "@/lib/session";
import { randomBytes } from "node:crypto";

export async function GET(req: NextRequest) {
  if (isDemoMode()) {
    // Demo mode: no Discord app configured — sign in as the demo designer.
    await createSession({
      userId: "demo-user",
      username: "Demo Designer",
      avatarUrl: null,
    });
    return NextResponse.redirect(new URL("/select", env.appUrl || req.url));
  }
  const state = signState(randomBytes(16).toString("base64url"));
  const res = NextResponse.redirect(buildAuthorizeUrl(state));
  res.cookies.set("monarch_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return res;
}
