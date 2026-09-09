"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiErrorMessage, networkErrorMessage, readJsonSafe } from "@/lib/fetch-json";

export interface LibraryTemplate {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  categories: number;
  channels: number;
  roles: number;
}

type Notice = { tone: "ok" | "error"; text: string; designerUrl?: string } | null;

/**
 * Template library UI (FEATURE 7): save the live server as a template,
 * upload `monarch-template` files, then rename / duplicate / download /
 * install / delete them. Installing reuses the guild import endpoint, so
 * the handoff is always: stage draft → Server Designer shows the diff →
 * explicit apply.
 */
export function TemplateLibrary({
  guildId,
  initialTemplates,
  canDesign,
}: {
  guildId: string;
  initialTemplates: LibraryTemplate[];
  canDesign: boolean;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [templates, setTemplates] = useState(initialTemplates);
  const [saveName, setSaveName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const refresh = async () => {
    const res = await fetch("/api/library/templates");
    const data = await readJsonSafe<{ templates?: LibraryTemplate[] }>(res);
    if (res.ok && data?.templates) setTemplates(data.templates);
  };

  const saveFromGuild = async () => {
    setBusy("save");
    setNotice(null);
    try {
      const res = await fetch("/api/library/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "guild", guildId, name: saveName.trim() || undefined }),
      });
      const data = await readJsonSafe<{ template?: { name: string } }>(res);
      if (!res.ok || !data?.template) {
        setNotice({ tone: "error", text: apiErrorMessage(data, res, "Monarch couldn't save this server as a template.") });
        return;
      }
      setSaveName("");
      setNotice({ tone: "ok", text: `Template "${data.template.name}" saved to your library.` });
      await refresh();
    } catch (e) {
      setNotice({ tone: "error", text: networkErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const uploadFile = async () => {
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    setBusy("upload");
    setNotice(null);
    try {
      let template: unknown;
      try {
        template = JSON.parse(await file.text());
      } catch {
        setNotice({ tone: "error", text: "That file isn't valid JSON." });
        return;
      }
      const res = await fetch("/api/library/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "upload", template }),
      });
      const data = await readJsonSafe<{ template?: { name: string } }>(res);
      if (!res.ok || !data?.template) {
        setNotice({ tone: "error", text: apiErrorMessage(data, res, "Monarch couldn't add that template to your library.") });
        return;
      }
      if (fileInput.current) fileInput.current.value = "";
      setNotice({ tone: "ok", text: `Template "${data.template.name}" added to your library.` });
      await refresh();
    } catch (e) {
      setNotice({ tone: "error", text: networkErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const install = async (t: LibraryTemplate, mode: "add" | "replace") => {
    if (
      mode === "replace" &&
      !confirm(
        `Install "${t.name}" in replace mode?\n\nReplace mode removes every category and channel that isn't in the template when you apply. You'll still review the full diff and confirm deletions in the Server Designer.`,
      )
    ) {
      return;
    }
    setBusy(`install-${t.id}`);
    setNotice(null);
    try {
      const envelopeRes = await fetch(`/api/library/templates/${t.id}`);
      const envelope = await readJsonSafe<Record<string, unknown>>(envelopeRes);
      if (!envelopeRes.ok || !envelope) {
        setNotice({ tone: "error", text: apiErrorMessage(envelope, envelopeRes, "Monarch couldn't read that template.") });
        return;
      }
      const res = await fetch(`/api/guilds/${guildId}/template`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: envelope, mode }),
      });
      const data = await readJsonSafe<{ designerUrl?: string; categoryCount?: number; channelCount?: number }>(res);
      if (!res.ok || !data?.designerUrl) {
        setNotice({ tone: "error", text: apiErrorMessage(data, res, "Monarch couldn't stage the template for this server.") });
        return;
      }
      setNotice({
        tone: "ok",
        text: `"${t.name}" is loaded in the Server Designer. Review the diff there — nothing changes until you apply.`,
        designerUrl: data.designerUrl,
      });
      router.push(data.designerUrl);
    } catch (e) {
      setNotice({ tone: "error", text: networkErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const rename = async (t: LibraryTemplate) => {
    const name = prompt("Rename template", t.name)?.trim();
    if (!name || name === t.name) return;
    setBusy(`rename-${t.id}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/library/templates/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", name }),
      });
      const data = await readJsonSafe<{ template?: LibraryTemplate }>(res);
      if (!res.ok || !data?.template) {
        setNotice({ tone: "error", text: apiErrorMessage(data, res, "Monarch couldn't rename that template.") });
        return;
      }
      await refresh();
    } catch (e) {
      setNotice({ tone: "error", text: networkErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const duplicate = async (t: LibraryTemplate) => {
    setBusy(`duplicate-${t.id}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/library/templates/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "duplicate" }),
      });
      if (!res.ok) {
        const data = await readJsonSafe(res);
        setNotice({ tone: "error", text: apiErrorMessage(data, res, "Monarch couldn't duplicate that template.") });
        return;
      }
      await refresh();
    } catch (e) {
      setNotice({ tone: "error", text: networkErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (t: LibraryTemplate) => {
    if (!confirm(`Delete "${t.name}" from your library? This can't be undone.`)) return;
    setBusy(`delete-${t.id}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/library/templates/${t.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await readJsonSafe(res);
        setNotice({ tone: "error", text: apiErrorMessage(data, res, "Monarch couldn't delete that template.") });
        return;
      }
      setTemplates((all) => all.filter((x) => x.id !== t.id));
    } catch (e) {
      setNotice({ tone: "error", text: networkErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-royal-500/25 bg-royal-500/5 p-4 sm:p-5">
        <h2 className="mb-1 text-sm font-semibold text-ink-100">Save this server as a template</h2>
        <p className="mb-3 text-xs leading-relaxed text-ink-300">
          Captures {`the server's`} categories, channels and roles as a portable template. Discord
          ids are stripped, so it can be installed into any server later.
        </p>
        {!canDesign ? (
          <p className="rounded-lg border border-warn-400/20 bg-warn-400/10 px-3 py-2 text-xs text-warn-400">
            Saving this server needs the Monarch bot installed and Manage Server permission.
          </p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              maxLength={100}
              placeholder="Optional name, e.g. “Community starter”"
              className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 outline-none placeholder:text-ink-500 focus:border-royal-500"
            />
            <button
              onClick={() => void saveFromGuild()}
              disabled={busy !== null}
              className="rounded-lg bg-royal-500 px-4 py-2 text-sm font-medium text-white shadow shadow-royal-500/25 transition hover:bg-royal-400 disabled:opacity-50"
            >
              {busy === "save" ? "Saving…" : "Save template"}
            </button>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-ink-700 bg-ink-900 p-4 sm:p-5">
        <h2 className="mb-1 text-sm font-semibold text-ink-100">Upload a template file</h2>
        <p className="mb-3 text-xs leading-relaxed text-ink-300">
          Add a downloaded <code className="rounded bg-ink-800 px-1 py-0.5 text-ink-200">monarch-template</code>{" "}
          JSON file to your library.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="min-w-0 flex-1 cursor-pointer rounded-lg border border-dashed border-ink-600 bg-ink-950/40 px-3 py-2.5 text-xs text-ink-300 file:mr-3 file:rounded-md file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-ink-100 hover:border-ink-500"
          />
          <button
            onClick={() => void uploadFile()}
            disabled={busy !== null}
            className="rounded-lg border border-royal-500/40 bg-royal-500/10 px-4 py-2 text-sm font-medium text-royal-400 transition hover:bg-royal-500/20 disabled:opacity-50"
          >
            {busy === "upload" ? "Adding…" : "Add to library"}
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink-100">
          Your templates <span className="ml-1 text-xs font-normal text-ink-400">{templates.length}</span>
        </h2>
        {templates.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-ink-700 px-4 py-8 text-center text-xs text-ink-400">
            Nothing here yet. Save this server as a template, or upload a{" "}
            <code className="rounded bg-ink-800 px-1 py-0.5 text-ink-200">monarch-template</code> file.
          </p>
        ) : (
          <ul className="space-y-2">
            {templates.map((t) => (
              <li key={t.id} className="rounded-2xl border border-ink-700 bg-ink-900 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-100">{t.name}</p>
                    <p className="mt-0.5 text-[11px] text-ink-400">
                      <span className="mr-2 rounded bg-royal-500/15 px-1.5 py-0.5 font-medium text-royal-400">server</span>
                      {t.categories} categories · {t.channels} channels · {t.roles} roles · saved{" "}
                      {formatDate(t.createdAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {canDesign && (
                      <>
                        <button
                          onClick={() => void install(t, "add")}
                          disabled={busy !== null}
                          className="rounded-lg bg-royal-500 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-royal-400 disabled:opacity-50"
                        >
                          {busy === `install-${t.id}` ? "Installing…" : "Install (add)"}
                        </button>
                        <button
                          onClick={() => void install(t, "replace")}
                          disabled={busy !== null}
                          className="rounded-lg border border-danger-400/30 px-2.5 py-1.5 text-xs font-medium text-danger-400 transition hover:bg-danger-400/10 disabled:opacity-50"
                        >
                          Replace structure
                        </button>
                      </>
                    )}
                    <a
                      href={`/api/library/templates/${t.id}?download=1`}
                      download
                      className="rounded-lg border border-ink-600 px-2.5 py-1.5 text-xs font-medium text-ink-200 transition hover:border-ink-500 hover:text-ink-100"
                    >
                      Download
                    </a>
                    <button
                      onClick={() => void rename(t)}
                      disabled={busy !== null}
                      className="rounded-lg px-2 py-1.5 text-xs text-ink-300 transition hover:text-ink-100 disabled:opacity-50"
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => void duplicate(t)}
                      disabled={busy !== null}
                      className="rounded-lg px-2 py-1.5 text-xs text-ink-300 transition hover:text-ink-100 disabled:opacity-50"
                    >
                      Duplicate
                    </button>
                    <button
                      onClick={() => void remove(t)}
                      disabled={busy !== null}
                      className="rounded-lg px-2 py-1.5 text-xs text-ink-400 transition hover:text-danger-400 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

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
            <a href={notice.designerUrl} className="ml-2 font-medium underline underline-offset-2">
              Open Server Designer →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown date";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
