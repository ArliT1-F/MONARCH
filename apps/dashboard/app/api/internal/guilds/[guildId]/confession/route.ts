import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, jsonStorageError } from "@/lib/api";
import { assertInternalAuth } from "@/lib/internal-auth";
import { getStore } from "@/lib/store";

/**
 * Bot-facing confession channels (used by `/monarch confession setup` /
 * `disable`). Auth: `Authorization: Bearer <INTERNAL_API_TOKEN>` — the bot
 * has already verified the invoking member holds Manage Server /
 * Administrator before it gets here.
 *
 * GET → `{ channelId, logChannelId }` — `channelId` null = confessions off.
 * PUT → `{ channelId, logChannelId }` — full configuration; both null = off.
 *
 * The bot keeps no database credentials of its own, so this route is the only
 * way the configuration survives a restart. Channel ids are snowflake-checked
 * here and in the bot (same rule on both sides) so a malformed value can't
 * be stored by either.
 */
const Snowflake = z.string().regex(/^\d{15,25}$/, "not a Discord snowflake");

const Body = z.object({
  channelId: z.union([Snowflake, z.null()]),
  logChannelId: z.union([Snowflake, z.null()]),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;
  try {
    const stored = await getStore().getConfessionChannels(guildId);
    return NextResponse.json({
      channelId: stored.channelId,
      logChannelId: stored.logChannelId,
    });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't read the confession channels.");
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ guildId: string }> },
) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return jsonError(400, {
      code: "confession.invalid",
      message: "Invalid confession payload.",
      fix: 'Send { "channelId": "<snowflake>" | null, "logChannelId": "<snowflake>" | null }.',
    });
  }

  // The log channel names names — pointing it at the public confession
  // channel would leak every confessor to everyone, so the route refuses it.
  const { channelId, logChannelId } = body.data;
  if (channelId !== null && logChannelId !== null && channelId === logChannelId) {
    return jsonError(400, {
      code: "confession.same-channel",
      message: "The log channel must be different from the confession channel.",
      fix: "Pick a staff-only channel that regular members cannot see for the logs.",
    });
  }

  try {
    await getStore().putConfessionChannels(guildId, { guildId, channelId, logChannelId });
    return NextResponse.json({ ok: true, channelId, logChannelId });
  } catch (error) {
    return jsonStorageError(error, "Monarch couldn't save the confession channels.");
  }
}
