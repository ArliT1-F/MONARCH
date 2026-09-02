import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getStore } from "@/lib/store";

export default async function HistoryPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");
  const { guildId } = await params;
  const snapshots = await getStore().listSnapshots(guildId);

  return (
    <main className="mx-auto max-w-3xl px-8 py-10">
      <p className="mb-1 text-xs font-semibold tracking-[0.2em] text-ink-400 uppercase">Manage</p>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Version history</h1>
      <p className="mb-8 text-sm text-ink-300">
        Monarch snapshots the structure it manages before and after every apply. Restore and
        compare arrive with the Backups feature (Phase 6); snapshots are already being captured.
      </p>

      {snapshots.length === 0 ? (
        <div className="rounded-2xl border border-ink-700 bg-ink-900 p-10 text-center">
          <p className="mb-1 text-sm font-medium text-ink-100">No snapshots yet</p>
          <p className="text-xs text-ink-400">
            Apply a design from the Server Designer and Monarch will record the before/after here.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {snapshots.map((s, i) => (
            <li
              key={s.id}
              className="flex items-center gap-4 rounded-xl border border-ink-700 bg-ink-900 px-4 py-3"
            >
              <span className="w-10 shrink-0 text-xs font-semibold text-royal-400">
                v{snapshots.length - i}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink-100">{s.name}</p>
                <p className="text-[11px] text-ink-400">
                  {s.kind} · {s.design.categories.length} categories · {s.design.channels.length}{" "}
                  channels
                </p>
              </div>
              <span className="text-[11px] text-ink-400">
                {new Date(s.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
