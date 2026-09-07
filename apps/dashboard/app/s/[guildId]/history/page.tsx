import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getGuildSummary } from "@/lib/discord";
import { getStore } from "@/lib/store";
import { BackupsPanel, type SnapshotMeta } from "@/components/history/BackupsPanel";

export default async function HistoryPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");
  const { guildId } = await params;
  const [guild, snapshots] = await Promise.all([
    getGuildSummary(session, guildId),
    getStore().listSnapshots(guildId),
  ]);
  if (!guild) redirect("/select");

  const initial: SnapshotMeta[] = snapshots.map(({ design, ...meta }) => ({
    ...meta,
    channelCount: design.channels.length,
    categoryCount: design.categories.length,
  }));

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
      <p className="mb-1 text-xs font-semibold tracking-[0.2em] text-ink-400 uppercase">Manage</p>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Backups &amp; history</h1>
      <p className="mb-6 text-sm leading-relaxed text-ink-300 sm:mb-8">
        Every snapshot is a full copy of this server&apos;s categories and channels. Restoring
        one loads it into the Server Designer so you can see exactly what changes before it is
        applied — deleted channels come back, channels added since are removed, renames are
        reverted.
      </p>
      <BackupsPanel
        guildId={guildId}
        initialSnapshots={initial}
        canDesign={guild.userCanDesign && guild.botInstalled}
      />
    </main>
  );
}
