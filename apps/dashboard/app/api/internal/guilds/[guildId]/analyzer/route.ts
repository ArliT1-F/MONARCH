import { NextRequest, NextResponse } from "next/server";
import { analyzeServerDesign } from "@monarch/analyzer";
import { assertInternalAuth } from "@/lib/internal-auth";
import { jsonError, jsonStorageError } from "@/lib/api";
import { fetchCurrentDesign } from "@/lib/discord";
import { getStore } from "@/lib/store";
import { reportToMarkdown } from "@/lib/analyzer-report";

export async function GET(req: NextRequest, { params }: { params: Promise<{ guildId: string }> }) {
  const unauthorized = assertInternalAuth(req);
  if (unauthorized) return unauthorized;
  const { guildId } = await params;
  try {
    const current = await fetchCurrentDesign(guildId);
    if (!current) return jsonError(404, { message: "Couldn't read this server's live design." });
    const dismissed = await getStore().getAnalyzerDismissals(guildId);
    const report = analyzeServerDesign(current, { dismissed });
    return NextResponse.json({
      ok: true,
      score: report.overall,
      fileName: `monarch-${guildId}-design-report.md`,
      markdown: reportToMarkdown(current.name, report),
    });
  } catch (error) {
    return jsonStorageError(error, "Couldn't compute the design report.");
  }
}
