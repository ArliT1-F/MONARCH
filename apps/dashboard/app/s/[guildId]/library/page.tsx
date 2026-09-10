import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getGuildSummary } from "@/lib/discord";
import { templateMeta } from "@/lib/library";
import { getStore } from "@/lib/store";
import { TemplateLibrary, type LibraryTemplate } from "@/components/library/TemplateLibrary";

export const dynamic = "force-dynamic";

/**
 * Template Library (FEATURE 7). The library itself is per-user; this page
 * sits inside a guild context so "install" always has a concrete target —
 * installing stages a draft for THIS server via the existing import
 * pipeline, never a direct write to Discord.
 */
export default async function LibraryPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");
  const { guildId } = await params;
  const [guild, templates] = await Promise.all([
    getGuildSummary(session, guildId),
    getStore().listTemplates(session.userId).catch(() => []),
  ]);
  if (!guild) redirect("/select");

  const initial: LibraryTemplate[] = templates.map((t) => {
    const meta = templateMeta(t);
    return {
      id: meta.id,
      name: meta.name,
      type: meta.type,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      categories: meta.categories,
      channels: meta.channels,
      roles: meta.roles,
    };
  });

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
      <p className="mb-1 text-xs font-semibold tracking-[0.2em] text-ink-400 uppercase">Library</p>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Template library</h1>
      <p className="mb-6 text-sm leading-relaxed text-ink-300 sm:mb-8">
        Your saved layouts, independent of any server. Save the current structure as a template,
        upload one, and install any of them into <span className="text-ink-100">{guild.name}</span> —
        installs load into the Server Designer first, so you always see the diff before anything
        changes.
      </p>
      <TemplateLibrary
        guildId={guildId}
        initialTemplates={initial}
        canDesign={guild.userCanDesign && guild.botInstalled}
      />
    </main>
  );
}
