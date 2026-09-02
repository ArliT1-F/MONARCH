import { NextRequest, NextResponse } from "next/server";
import type { GuildSummary } from "@monarch/schemas";
import type { MonarchError } from "@monarch/shared";
import { getSession } from "./session";
import { getGuildSummary } from "./discord";
import type { SessionRecord } from "./store";

/**
 * API route guards. Frontend checks are cosmetic; these are the real ones.
 * Every mutation must pass: session → guild membership → user can design
 * → bot installed. CSRF: mutating requests must be same-origin.
 */

export interface GuildContext {
  session: SessionRecord;
  guild: GuildSummary;
}

export function jsonError(status: number, error: Partial<MonarchError> & { message: string }) {
  return NextResponse.json({ error: { code: error.code ?? "request.failed", ...error } }, { status });
}

export function assertSameOrigin(req: NextRequest): NextResponse | null {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return jsonError(403, { code: "csrf", message: "Cross-origin request rejected." });
  }
  return null;
}

export async function requireSession(): Promise<
  { ok: true; session: SessionRecord } | { ok: false; response: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: jsonError(401, { code: "auth.required", message: "Sign in to continue." }),
    };
  }
  return { ok: true, session };
}

export async function requireGuildAccess(
  guildId: string,
  opts: { needBot?: boolean } = { needBot: true },
): Promise<{ ok: true; ctx: GuildContext } | { ok: false; response: NextResponse }> {
  const auth = await requireSession();
  if (!auth.ok) return auth;

  const guild = await getGuildSummary(auth.session, guildId);
  if (!guild) {
    return {
      ok: false,
      response: jsonError(404, {
        code: "guild.not-found",
        message: "You don't have access to this server.",
      }),
    };
  }
  if (!guild.userCanDesign) {
    return {
      ok: false,
      response: jsonError(403, {
        code: "guild.forbidden",
        message: "You need Manage Server or Administrator in this server to design it.",
      }),
    };
  }
  if (opts.needBot && !guild.botInstalled) {
    return {
      ok: false,
      response: jsonError(409, {
        code: "guild.bot-missing",
        message: "Monarch isn't installed in this server yet.",
        fix: "Invite the Monarch bot, then reload.",
      }),
    };
  }
  return { ok: true, ctx: { session: auth.session, guild } };
}
