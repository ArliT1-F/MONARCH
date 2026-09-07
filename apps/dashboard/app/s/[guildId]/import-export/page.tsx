import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getGuildSummary } from "@/lib/discord";
import { ImportExportPanel } from "@/components/templates/ImportExportPanel";

export default async function ImportExportPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");
  const { guildId } = await params;
  const guild = await getGuildSummary(session, guildId);
  if (!guild) redirect("/select");

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
      <p className="mb-1 text-xs font-semibold tracking-[0.2em] text-ink-400 uppercase">Library</p>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Templates · Import / Export</h1>
      <p className="mb-6 text-sm leading-relaxed text-ink-300 sm:mb-8">
        A template is a portable copy of a server layout. Export one to share your structure or
        keep it outside Monarch; import one to set up a server in seconds — always with a full
        diff preview before anything changes.
      </p>
      <ImportExportPanel
        guildId={guildId}
        guildName={guild.name}
        canDesign={guild.userCanDesign && guild.botInstalled}
      />
    </main>
  );
}
