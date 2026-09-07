import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { fetchCurrentDesign, getGuildSummary } from "@/lib/discord";
import { getStore } from "@/lib/store";

const AUDIT_LABEL: Record<string, string> = {
  "design.apply": "Applied",
  "backup.create": "Backup",
  "backup.restore-staged": "Restore",
  "template.import-staged": "Import",
  "content.test": "Test sent",
  "content.publish": "Published",
};

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
    getStore().listAudit(guildId, 6),
  ]);
  if (!guild) redirect("/select");

  const lastBackup = snapshots[0];
  const stats = [
    { label: "Categories", value: design?.categories.length ?? "—" },
    { label: "Channels", value: design?.channels.length ?? "—" },
    { label: "Roles", value: design?.roles.length ?? "—" },
    { label: "Snapshots", value: snapshots.length },
  ];

  const base = `/s/${guildId}`;
  const actions = [
    {
      href: `${base}/designer`,
      title: "Server Designer",
      body: "Rearrange categories and channels visually. Changes stay in a draft until you review the diff and apply.",
      cta: "Open designer",
      accent: true,
    },
    {
      href: `${base}/history`,
      title: "Backups & history",
      body: lastBackup
        ? `Last snapshot ${relativeTime(lastBackup.createdAt)} · ${snapshots.length} total. Restore any of them with a full diff preview.`
        : "No snapshots yet. Save one now so you can always roll back.",
      cta: lastBackup ? "Manage backups" : "Save a backup",
    },
    {
      href: `${base}/import-export`,
      title: "Templates",
      body: "Export this layout as a portable template, or import one to set up a server in seconds.",
      cta: "Import / export",
    },
    {
      href: `${base}/embeds`,
      title: "Embed Builder",
      body: "Design rich embeds and messages with a live Discord preview, then test or publish them.",
      cta: "Build an embed",
    },
  ];

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 sm:px-8 sm:py-10">
      <p className="mb-1 text-xs font-semibold tracking-[0.2em] text-ink-400 uppercase">Overview</p>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3 sm:mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">{guild.name}</h1>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
            guild.botInstalled ? "bg-ok-400/10 text-ok-400" : "bg-warn-400/10 text-warn-400"
          }`}
        >
          {guild.botInstalled ? "Monarch connected" : "Bot not installed"}
        </span>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:mb-8 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-2xl border border-ink-700 bg-ink-900 p-4">
            <p className="text-2xl font-semibold text-ink-100">{s.value}</p>
            <p className="text-xs text-ink-400">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="mb-8 grid gap-3 sm:grid-cols-2">
        {actions.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className={`group flex flex-col rounded-2xl border p-5 transition ${
              a.accent
                ? "border-royal-500/30 bg-royal-500/5 hover:border-royal-500/60 hover:bg-royal-500/10"
                : "border-ink-700 bg-ink-900 hover:border-ink-500"
            }`}
          >
            <h2 className="mb-1 text-sm font-semibold text-ink-100">{a.title}</h2>
            <p className="mb-4 flex-1 text-xs leading-relaxed text-ink-300">{a.body}</p>
            <span
              className={`text-xs font-medium ${
                a.accent ? "text-royal-400" : "text-ink-200 group-hover:text-royal-400"
              }`}
            >
              {a.cta} →
            </span>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink-100">Recent activity</h2>
          {audit.length === 0 ? (
            <p className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-6 text-center text-xs text-ink-400">
              No activity yet. Applied designs, backups and imports will appear here.
            </p>
          ) : (
            <ul className="space-y-2">
              {audit.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-col gap-1 rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="flex min-w-0 items-start gap-2 text-xs text-ink-200">
                    <span className="mt-px shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-ink-300 uppercase">
                      {AUDIT_LABEL[a.action] ?? a.action.split(".")[0]}
                    </span>
                    <span className="min-w-0 break-words">{a.summary}</span>
                  </span>
                  <time dateTime={a.createdAt} className="shrink-0 text-[11px] text-ink-400">
                    {new Date(a.createdAt).toLocaleString()}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside>
          <h2 className="mb-3 text-sm font-semibold text-ink-100">From Discord</h2>
          <div className="rounded-2xl border border-ink-700 bg-ink-900 p-4">
            <p className="mb-3 text-[11px] leading-relaxed text-ink-400">
              Everything here has a slash command too. Type <Code>/monarch help</Code> in your
              server for the full list.
            </p>
            <ul className="space-y-2 text-xs text-ink-200">
              <li>
                <Code>/monarch backup</Code>
                <span className="block text-[11px] text-ink-400">Snapshot the structure</span>
              </li>
              <li>
                <Code>/monarch export</Code>
                <span className="block text-[11px] text-ink-400">Get the layout as a template</span>
              </li>
              <li>
                <Code>/monarch jail @user 10m</Code>
                <span className="block text-[11px] text-ink-400">
                  Re-post their messages in Galactic
                </span>
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-ink-100">{children}</code>;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
