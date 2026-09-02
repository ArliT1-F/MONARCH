import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { listGuildSummaries } from "@/lib/discord";
import { isDemoMode } from "@/lib/env";
import { MonarchMark } from "@/components/ui/MonarchMark";
import { LogoutButton } from "@/components/ui/LogoutButton";

export default async function SelectServerPage() {
  const session = await getSession();
  if (!session) redirect("/");
  const guilds = await listGuildSummaries(session);
  const designable = guilds.filter((g) => g.userCanDesign);

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-12">
      <header className="mb-10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <MonarchMark className="h-8 w-8" />
          <div>
            <p className="text-sm font-semibold text-ink-100">Monarch</p>
            <p className="text-xs text-ink-400">Signed in as {session.username}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isDemoMode() && (
            <span className="rounded-full border border-gold-400/30 bg-gold-400/10 px-3 py-1 text-[11px] font-medium text-gold-400">
              Demo mode
            </span>
          )}
          <LogoutButton />
        </div>
      </header>

      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Select a server</h1>
      <p className="mb-8 text-sm text-ink-300">
        Servers where you can design. Monarch only ever changes the server you select.
      </p>

      {designable.length === 0 ? (
        <div className="rounded-2xl border border-ink-700 bg-ink-900 p-10 text-center">
          <p className="mb-2 text-sm font-medium text-ink-100">No designable servers</p>
          <p className="text-xs text-ink-400">
            You need Manage Server or Administrator in a server to design it with Monarch.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {designable.map((g) => (
            <div
              key={g.id}
              className="animate-fade-up group rounded-2xl border border-ink-700 bg-ink-900 p-5 transition hover:border-ink-600 hover:bg-ink-850"
            >
              <div className="mb-4 flex items-center gap-3">
                {g.iconUrl ? (
                  <Image
                    src={g.iconUrl}
                    alt=""
                    width={44}
                    height={44}
                    className="rounded-xl"
                  />
                ) : (
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-ink-700 text-sm font-semibold text-ink-200">
                    {initials(g.name)}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink-100">{g.name}</p>
                  <p className="text-xs text-ink-400">
                    {g.memberCount !== null ? `${g.memberCount.toLocaleString()} members` : "—"}
                  </p>
                </div>
              </div>

              {g.botInstalled ? (
                <Link
                  href={`/s/${g.id}`}
                  className="block rounded-lg bg-royal-500 py-2 text-center text-sm font-medium text-white transition group-hover:bg-royal-400"
                >
                  Design Server
                </Link>
              ) : (
                <div>
                  <div className="mb-2 rounded-lg border border-ink-700 bg-ink-850 py-2 text-center text-xs text-ink-400">
                    Monarch isn&apos;t installed here
                  </div>
                  <p className="text-center text-[11px] text-ink-400">
                    Invite the Monarch bot to design this server.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
