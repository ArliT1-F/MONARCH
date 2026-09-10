import { redirect } from "next/navigation";
import { analyzeServerDesign } from "@monarch/analyzer";
import { getSession } from "@/lib/session";
import { isDemoMode } from "@/lib/env";
import { fetchCurrentDesign, getGuildSummary } from "@/lib/discord";
import { getStore } from "@/lib/store";
import { AnalyzerPanel } from "@/components/analyzer/AnalyzerPanel";
import { InviteBotButton } from "@/components/ui/InviteBotButton";

export const dynamic = "force-dynamic";

/**
 * Design Analyzer (FEATURE 9). Read-only: the report is computed from the
 * live design (what Discord has right now), not from drafts, and the page
 * never writes to Discord. Any member may view it; changing the "marked
 * as intentional" list needs design access (enforced by the API).
 */
export default async function AnalyzerPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");
  const { guildId } = await params;
  const guild = await getGuildSummary(session, guildId);
  if (!guild) redirect("/select");

  const current = await fetchCurrentDesign(guildId);
  if (!current) {
    // Without the bot we can't read the live structure at all.
    return (
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
        <p className="mb-1 text-xs font-semibold tracking-[0.2em] text-ink-400 uppercase">Manage</p>
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">Design Analyzer</h1>
        <div className="rounded-2xl border border-warn-400/20 bg-warn-400/5 p-4 text-sm text-warn-400 sm:p-5">
          Monarch can&apos;t read {guild.name}&apos;s structure yet
          {guild.botInstalled ? " (Discord didn't respond — try again shortly)." : " — the Monarch bot isn't installed in this server."}
        </div>
        {!guild.botInstalled && (
          <div className="mt-4">
            <InviteBotButton guildId={guildId} demo={isDemoMode()} />
          </div>
        )}
      </main>
    );
  }

  const dismissed = await getStore()
    .getAnalyzerDismissals(guildId)
    .catch(() => [] as string[]);
  const report = analyzeServerDesign(current, { dismissed });

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
      <p className="mb-1 text-xs font-semibold tracking-[0.2em] text-ink-400 uppercase">Manage</p>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Design Analyzer</h1>
      <p className="mb-6 text-sm leading-relaxed text-ink-300 sm:mb-8">
        Scores {guild.name}&apos;s organization, naming, role consistency and branding — with
        concrete suggestions. Nothing here changes your server; apply structure changes through
        the Server Designer.
      </p>
      <AnalyzerPanel guildId={guildId} guildName={guild.name} report={report} canDesign={guild.userCanDesign} />
    </main>
  );
}
