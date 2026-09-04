import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { avatarUrl, exchangeCode, fetchDiscordUser, verifyState } from "@/lib/auth";
import { createSession } from "@/lib/session";
import { createLogger } from "@monarch/shared";

const log = createLogger("auth.callback");

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = req.cookies.get("monarch_oauth_state")?.value;

  const redirectToError = (reason: string) => {
    const res = NextResponse.redirect(new URL(`/?error=${encodeURIComponent(reason)}`, env.appUrl));
    // Clear a stale/expired state cookie so the next sign-in starts fresh.
    res.cookies.delete("monarch_oauth_state");
    return res;
  };

  const fail = (reason: string) => {
    log.warn("oauth callback rejected", { reason });
    return redirectToError(reason);
  };

  if (!code || !state) return fail("Discord didn't complete the sign-in.");
  if (!cookieState || cookieState !== state || !verifyState(state)) {
    return fail("Sign-in session expired. Please try again.");
  }

  const token = await exchangeCode(code);
  if (!token) return fail("Couldn't exchange the Discord sign-in code.");

  const user = await fetchDiscordUser(token.access_token);
  if (!user) return fail("Couldn't load your Discord profile.");

  try {
    await createSession({
      userId: user.id,
      username: user.global_name ?? user.username,
      avatarUrl: avatarUrl(user),
      accessToken: token.access_token,
    });
  } catch (err) {
    log.error("oauth callback storage failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return redirectToError("Sign-in couldn't be completed. Please try again.");
  }

  const res = NextResponse.redirect(new URL("/select", env.appUrl));
  res.cookies.delete("monarch_oauth_state");
  return res;
}
