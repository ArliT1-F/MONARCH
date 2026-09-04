import { NextRequest, NextResponse } from "next/server";
import { env, isDemoMode } from "@/lib/env";
import { buildBotInviteUrl, isValidGuildId } from "@/lib/invite";
import { installBotInDemoGuild } from "@/lib/discord";
import { getSession } from "@/lib/session";
import { createLogger } from "@monarch/shared";

const log = createLogger("api.invite");

/**
 * GET /api/invite[?guild_id=…]
 *
 * Sends the user to Discord's "Add to Server" dialog for the Monarch bot,
 * pre-selecting a server when `guild_id` is supplied. Kept as a redirect
 * (rather than a client-side link) so the client ID and the exact permission
 * set stay server-owned — the browser only ever sees /api/invite.
 *
 * In demo mode there is no Discord application, so the invite is simulated
 * against the mock gateway and the user lands on the now-designable server.
 */
export async function GET(req: NextRequest) {
  const requested = new URL(req.url).searchParams.get("guild_id");
  const guildId = isValidGuildId(requested) ? requested : null;
  const base = env.appUrl || req.url;

  if (isDemoMode()) {
    const session = await getSession();
    if (!session) return NextResponse.redirect(new URL("/", base));
    if (guildId && (await installBotInDemoGuild(guildId))) {
      return NextResponse.redirect(new URL(`/s/${guildId}?invited=1`, base));
    }
    return NextResponse.redirect(new URL("/select?invited=demo", base));
  }

  const inviteUrl = buildBotInviteUrl({ guildId });
  if (!inviteUrl) {
    log.warn("invite requested without DISCORD_CLIENT_ID");
    return NextResponse.redirect(
      new URL(
        `/?error=${encodeURIComponent("Monarch has no Discord application configured yet.")}`,
        base,
      ),
    );
  }

  log.info("redirecting to bot invite", { guildId: guildId ?? "any" });
  return NextResponse.redirect(inviteUrl);
}
