import { NextRequest, NextResponse } from "next/server";
import { isDemoMode, env, assertConfigUsable } from "@/lib/env";
import { buildAuthorizeUrl, createOAuthState, OAUTH_STATE_MAX_AGE_SECONDS } from "@/lib/auth";
import { createSession, sessionCookieOptions } from "@/lib/session";
import { jsonStorageError } from "@/lib/api";

export async function GET(req: NextRequest) {
  try {
    assertConfigUsable();
    if (isDemoMode()) {
      // Demo mode: no Discord app configured — sign in as the demo designer.
      await createSession({
        userId: "demo-user",
        username: "Demo Designer",
        avatarUrl: null,
      });
      return NextResponse.redirect(new URL("/select", env.appUrl || req.url));
    }
    const state = createOAuthState();
    const res = NextResponse.redirect(buildAuthorizeUrl(state));
    res.cookies.set("monarch_oauth_state", state, {
      ...sessionCookieOptions(),
      maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    });
    return res;
  } catch (error) {
    return jsonStorageError(error, "Sign-in is unavailable. Check the server configuration.");
  }
}
