import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { fetchCurrentDesign, getGuildSummary } from "@/lib/discord";
import { getStore } from "@/lib/store";

export default async function GuildOverviewPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");
  const { guildId } = await params;
  const [guild, design, snapshots, audit] = await Promise.all([
    getGuildSummary(session, guildId),
    fetchCurrentDesign(guildId),
    getStore().listSnapshots(guildId),
    getStore().listAudit(guildId, 5),
  ]);
  if (!guild) redirect("/select");

  const stats = [
    { label: "Categories", value: design?.categories.length ?? "—" },
    { label: "Channels", value: design?.channels.length ?? "—" },
    { label: "Roles", value: design?.roles.length ?? "—" },
    { label: "Snapshots", value: snapshots.length },
  ];

  return (
    <main className="mx-auto max-w-4xl px-8 py-10">
      <p className="mb-1 text-xs font-semibold tracking-[0.2em] text-ink-400 uppercase">Overview</p>
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">{guild.name}</h1>

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-2xl border border-ink-700 bg-ink-900 p-4">
            <p className="text-2xl font-semibold text-ink-100">{s.value}</p>
            <p className="text-xs text-ink-400">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="mb-8 rounded-2xl border border-royal-500/25 bg-royal-500/5 p-6">
        <h2 className="mb-1 text-sm font-semibold text-ink-100">Design this server</h2>
        <p className="mb-4 text-xs leading-relaxed text-ink-300">
          Open the Server Designer to rearrange categories and channels visually. Changes stay in a
          draft until you review the diff and apply.
        </p>
        <Link
          href={`/s/${guildId}/designer`}
          className="inline-block rounded-lg bg-royal-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-royal-400"
        >
          Open Server Designer →
        </Link>
      </div>

      <h2 className="mb-3 text-sm font-semibold text-ink-100">Recent activity</h2>
      {audit.length === 0 ? (
        <p className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-6 text-center text-xs text-ink-400">
          No activity yet. Applied designs and snapshots will appear here.
        </p>
      ) : (
        <ul className="space-y-2">
          {audit.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between rounded-xl border border-ink-700 bg-ink-900 px-4 py-3"
            >
              <span className="text-xs text-ink-200">{a.summary}</span>
              <span className="text-[11px] text-ink-400">
                {new Date(a.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
