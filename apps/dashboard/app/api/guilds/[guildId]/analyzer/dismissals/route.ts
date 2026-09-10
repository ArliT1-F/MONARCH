import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { CHECKS } from "@monarch/analyzer";
import { assertSameOrigin, jsonError, jsonStorageError, requireGuildAccess } from "@/lib/api";
import { getStore } from "@/lib/store";

type Params = { params: Promise<{ guildId: string }> };

/**
 * GET /api/guilds/:guildId/analyzer/dismissals — the "marked as
 * intentional" check ids for this guild. Read-only; any member with
 * design access may read them (the analyzer itself is read-only).
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { guildId } = await params;
  const access = await requireGuildAccess(guildId, { needBot: false });
  if (!access.ok) return access.response;

  try {
    const dismissed = await getStore().getAnalyzerDismissals(guildId);
    return NextResponse.json({ dismissed });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't read the analyzer settings.");
  }
}

const PutBody = z.object({
  checkId: z.string().min(1).refine((id) => CHECKS.some((c) => c.id === id), {
    message: "Unknown analyzer check id.",
  }),
  dismissed: z.boolean(),
});

/**
 * PUT /api/guilds/:guildId/analyzer/dismissals — mark a check as
 * intentional (or un-mark it). Only touches Monarch settings, never
 * Discord. checkId is validated against the analyzer's registered
 * checks so the stored list can't fill up with junk.
 */
export async function PUT(req: NextRequest, { params }: Params) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const { guildId } = await params;
  const access = await requireGuildAccess(guildId, { needBot: false });
  if (!access.ok) return access.response;

  const body = PutBody.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return jsonError(400, { code: "analyzer.check", message: "Unknown analyzer check." });
  }

  try {
    const store = getStore();
    const current = await store.getAnalyzerDismissals(guildId);
    const set = new Set(current);
    if (body.data.dismissed) set.add(body.data.checkId);
    else set.delete(body.data.checkId);
    await store.putAnalyzerDismissals(guildId, [...set]);
    return NextResponse.json({ dismissed: [...set] });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't save the analyzer settings.");
  }
}
