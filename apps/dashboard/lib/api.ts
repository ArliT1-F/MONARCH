import { NextRequest, NextResponse } from "next/server";
import type { GuildSummary } from "@monarch/schemas";
import { createLogger, type MonarchError } from "@monarch/shared";
import { getSession } from "./session";
import { MonarchConfigError } from "./config";
import { env, assertConfigUsable } from "./env";
import { getGuildSummary } from "./discord";
import type { SessionRecord } from "./store";

const log = createLogger("dashboard.api");

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
  return NextResponse.json(
    { error: { code: error.code ?? "request.failed", ...error } },
    { status },
  );
}

export function assertSameOrigin(req: NextRequest): NextResponse | null {
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  const reject = () =>
    jsonError(403, { code: "csrf", message: "Request origin could not be verified." });
  if (site && site !== "same-origin" && site !== "none") return reject();
  // Compare against configured APP_URL, never req.url / forwarded Host.
  // Origin-less browsers must supply positive same-origin Fetch Metadata.
  // Non-browser clients should send Origin explicitly; internal APIs use bearer auth.
  if (origin !== null) {
    if (origin !== env.appUrl) return reject();
  } else if (site !== "same-origin") return reject();
  return null;
}

function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  // P2021: table does not exist · P2010: raw query failed · 42P01: pg undefined_table
  if (code === "P2021" || code === "P2010" || code === "42P01") return true;
  const message = String((error as Error | null)?.message ?? error ?? "");
  return /relation .* does not exist|table .* does not exist|no such table|P2021/i.test(message);
}

/**
 * Convert an unexpected storage/pipeline failure into a JSON 500.
 * Route handlers must never throw: an unhandled throw produces an
 * empty-body 500, and clients calling `res.json()` on it crash with a raw
 * `JSON.parse: unexpected end of data…` string. Neither the response nor
 * logs include raw driver exceptions (which can carry credentials).
 */
export function jsonStorageError(error: unknown, fallbackMessage: string): NextResponse {
  if (error instanceof MonarchConfigError) {
    return jsonError(503, {
      code: "config.invalid",
      message: "Monarch's server configuration is invalid. Contact the deployment administrator.",
    });
  }
  // Driver exceptions can contain DSNs or query parameters; never log raw errors.
  log.error("storage failure");
  if (isMissingTableError(error)) {
    return jsonError(500, {
      code: "db.migration-pending",
      message: fallbackMessage,
      fix: "The database schema looks outdated — run `npm run db:migrate` against this environment's database, then reload.",
    });
  }
  return jsonError(500, { code: "store.unavailable", message: fallbackMessage });
}

export async function requireSession(): Promise<
  { ok: true; session: SessionRecord } | { ok: false; response: NextResponse }
> {
  let session;
  try {
    assertConfigUsable();
    session = await getSession();
  } catch (error) {
    return { ok: false, response: jsonStorageError(error, "Session verification is unavailable.") };
  }
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
