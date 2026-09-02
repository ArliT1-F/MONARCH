import { NextResponse } from "next/server";
import { requireSession } from "@/lib/api";
import { listGuildSummaries } from "@/lib/discord";

export async function GET() {
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  const guilds = await listGuildSummaries(auth.session);
  return NextResponse.json({ guilds });
}
