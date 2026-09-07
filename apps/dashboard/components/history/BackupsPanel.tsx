"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiErrorMessage, networkErrorMessage, readJsonSafe } from "@/lib/fetch-json";

export interface SnapshotMeta {
  id: string;
  name: string;
  kind: "manual" | "pre-apply" | "post-apply";
  createdAt: string;
  channelCount: number;
  categoryCount: number;
}

const KIND_LABEL: Record<SnapshotMeta["kind"], { label: string; cls: string }> = {
  manual: { label: "Backup", cls: "bg-royal-500/15 text-royal-400" },
  "pre-apply": { label: "Before apply", cls: "bg-ink-800 text-ink-300" },
  "post-apply": { label: "After apply", cls: "bg-ok-400/10 text-ok-400" },
};

type Notice = { tone: "ok" | "error"; text: string; designerUrl?: string } | null;

/**
 * Backups & version history. Creating a backup snapshots the live structure;
 * restoring stages the snapshot as the caller's draft and hands off to the
 * Server Designer, which shows the exact diff before anything is applied.
 */
export function BackupsPanel({
  guildId,
  initialSnapshots,
  canDesign,
}: {
  guildId: string;
  initialSnapshots: SnapshotMeta[];
  canDesign: boolean;
}) {
  const router = useRouter();
  const [snapshots, setSnapshots] = useState(initialSnapshots);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"backup" | string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const refresh = async () => {
    const res = await fetch(`/api/guilds/${guildId}/snapshots`);
    const data = await readJsonSafe<{ snapshots?: SnapshotMeta[] }>(res);
    if (res.ok && data?.snapshots) setSnapshots(data.snapshots);
  };

  const backupNow = async () => {
    setBusy("backup");
    setNotice(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || undefined }),
      });
      const data = await readJsonSafe<{ snapshot?: { name: string } }>(res);
      if (!res.ok) {
        setNotice({ tone: "error", text: apiErrorMessage(data, res, "Monarch couldn't save the backup.") });
      } else {
        setName("");
        setNotice({ tone: "ok", text: `Backup "${data?.snapshot?.name ?? "backup"}" saved.` });
        await refresh();
      }
    } catch (e) {
      setNotice({ tone: "error", text: networkErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const restore = async (s: SnapshotMeta) => {
    const ok = confirm(
      `Restore "${s.name}"?\n\nThis loads the snapshot into the Server Designer as a draft and replaces any draft you have there. Nothing changes on Discord until you review the diff and apply.`,
    );
    if (!ok) return;
    setBusy(s.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/snapshots/${s.id}/restore`, { method: "POST" });
      const data = await readJsonSafe<{ recreated?: number; designerUrl?: string }>(res);
      if (!res.ok || !data?.designerUrl) {
        setNotice({ tone: "error", text: apiErrorMessage(data, res, "Monarch couldn't stage the restore.") });
        return;
      }
      const extra = data.recreated ? ` ${data.recreated} deleted item(s) will be recreated.` : "";
      setNotice({
        tone: "ok",
        text: `"${s.name}" is loaded in the Server Designer.${extra} Review the diff there and apply when ready.`,
        designerUrl: data.designerUrl,
      });
      router.push(data.designerUrl);
    } catch (e) {
      setNotice({ tone: "error", text: networkErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      {canDesign && (
        <div className="rounded-2xl border border-royal-500/25 bg-royal-500/5 p-4 sm:p-5">
          <h2 className="mb-1 text-sm font-semibold text-ink-100">Back up now</h2>
          <p className="mb-3 text-xs leading-relaxed text-ink-300">
            Saves the current categories and channels exactly as Discord has them. Monarch also
            snapshots automatically before and after every apply.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder="Optional name, e.g. “Before the summer event”"
              className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 outline-none placeholder:text-ink-500 focus:border-royal-500"
            />
            <button
              onClick={() => void backupNow()}
              disabled={busy !== null}
              className="rounded-lg bg-royal-500 px-4 py-2 text-sm font-medium text-white shadow shadow-royal-500/25 transition hover:bg-royal-400 disabled:opacity-50"
            >
              {busy === "backup" ? "Saving…" : "Save backup"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-ink-400">
            Tip: <code className="rounded bg-ink-800 px-1 py-0.5 text-ink-200">/monarch backup</code> does the
            same from Discord.
          </p>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className={`rounded-xl border px-4 py-3 text-xs ${
            notice.tone === "ok"
              ? "border-ok-400/25 bg-ok-400/10 text-ok-400"
              : "border-danger-400/25 bg-danger-400/10 text-danger-400"
          }`}
        >
          {notice.text}
          {notice.designerUrl && (
            <Link href={notice.designerUrl} className="ml-2 font-medium underline underline-offset-2">
              Open Server Designer →
            </Link>
          )}
        </div>
      )}

      {snapshots.length === 0 ? (
        <div className="rounded-2xl border border-ink-700 bg-ink-900 p-8 text-center sm:p-10">
          <p className="mb-1 text-sm font-medium text-ink-100">No snapshots yet</p>
          <p className="text-xs text-ink-400">
            Save a backup above, or apply a design from the Server Designer and Monarch will
            record the before/after here.
          </p>
        </div>
      ) : (
        <ol className="space-y-2">
          {snapshots.map((s, i) => {
            const kind = KIND_LABEL[s.kind] ?? KIND_LABEL.manual;
            return (
              <li
                key={s.id}
                className="flex flex-col gap-3 rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="mt-0.5 w-9 shrink-0 text-xs font-semibold text-royal-400">
                    v{snapshots.length - i}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm text-ink-100">{s.name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${kind.cls}`}>
                        {kind.label}
                      </span>
                    </p>
                    <p className="text-[11px] text-ink-400">
                      {s.categoryCount} categories · {s.channelCount} channels ·{" "}
                      <time dateTime={s.createdAt}>{new Date(s.createdAt).toLocaleString()}</time>
                    </p>
                  </div>
                </div>
                {canDesign && (
                  <button
                    onClick={() => void restore(s)}
                    disabled={busy !== null}
                    className="self-start rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-ink-100 transition hover:border-royal-400 hover:text-royal-400 disabled:opacity-50 sm:self-auto"
                  >
                    {busy === s.id ? "Loading…" : "Restore"}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
