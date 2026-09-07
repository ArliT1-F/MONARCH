import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getGuildSummary } from "@/lib/discord";
import { MonarchMark } from "@/components/ui/MonarchMark";
import { SidebarNav } from "@/components/nav/SidebarNav";
import { ServerSwitcher } from "@/components/nav/ServerSwitcher";
import { GuildShell } from "@/components/nav/GuildShell";
import { InviteBotButton } from "@/components/ui/InviteBotButton";
import { LogoutButton } from "@/components/ui/LogoutButton";
import { isDemoMode } from "@/lib/env";
import { isInviteAvailable } from "@/lib/invite";

export default async function GuildLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ guildId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");
  const { guildId } = await params;
  const guild = await getGuildSummary(session, guildId);
  if (!guild || !guild.userCanDesign) notFound();
  const demo = isDemoMode();

  const sidebar = (
    <>
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
        <Link href="/select" className="flex items-center gap-2.5">
          <MonarchMark className="h-7 w-7" />
          <span className="text-sm font-semibold tracking-wide text-ink-100">MONARCH</span>
        </Link>
        {demo && (
          <span className="mr-8 ml-auto rounded-full bg-gold-400/10 px-2 py-0.5 text-[10px] font-medium text-gold-400 md:mr-0">
            demo
          </span>
        )}
      </div>

      <div className="px-3 pb-3">
        <ServerSwitcher current={guild} />
      </div>

      <SidebarNav guildId={guild.id} />

      <div className="mt-auto flex items-center gap-3 border-t border-ink-800 px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-ink-200">{session.username}</p>
          <p className="truncate text-[11px] text-ink-400">Designing {guild.name}</p>
        </div>
        <LogoutButton className="shrink-0 rounded-lg border border-ink-700 px-2.5 py-1 text-[11px] text-ink-300 transition hover:border-ink-600 hover:text-ink-100" />
      </div>
    </>
  );

  return (
    <GuildShell sidebar={sidebar} guildName={guild.name} demo={demo}>
      {!guild.botInstalled && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-warn-400/20 bg-warn-400/10 px-4 py-2 text-xs text-warn-400 sm:px-6">
          <span>
            Monarch isn&apos;t installed in this server — designing is read-only until the bot is
            invited.
          </span>
          {isInviteAvailable() && (
            <InviteBotButton
              guildId={guild.id}
              demo={demo}
              label="Invite Monarch"
              variant="ghost"
              className="ml-auto text-warn-400 hover:text-warn-400"
            />
          )}
        </div>
      )}
      {children}
    </GuildShell>
  );
}
