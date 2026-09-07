"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiErrorMessage, networkErrorMessage, readJsonSafe } from "@/lib/fetch-json";

type Mode = "add" | "replace";
type Notice = { tone: "ok" | "error"; text: string; designerUrl?: string } | null;

/**
 * Import / Export. Export downloads the live structure as a portable
 * `monarch-template` JSON (no snowflakes, no guild-specific settings).
 * Import parses such a file and stages it as a draft; the Server Designer
 * then shows the diff — nothing is applied from here.
 */
export function ImportExportPanel({
  guildId,
  guildName,
  canDesign,
}: {
  guildId: string;
  guildName: string;
  canDesign: boolean;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<Mode>("add");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const importTemplate = async () => {
    if (!file) return;
    setBusy(true);
    setNotice(null);
    try {
      let template: unknown;
      try {
        template = JSON.parse(await file.text());
      } catch {
        setNotice({ tone: "error", text: "That file isn't valid JSON." });
        return;
      }
      if (
        mode === "replace" &&
        !confirm(
          "Replace mode removes every category and channel that isn't in the template when you apply. You'll still review the full diff and confirm deletions in the Server Designer. Continue?",
        )
      ) {
        return;
      }
      const res = await fetch(`/api/guilds/${guildId}/template`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template, mode }),
      });
      const data = await readJsonSafe<{
        templateName?: string;
        categoryCount?: number;
        channelCount?: number;
        designerUrl?: string;
      }>(res);
      if (!res.ok || !data?.designerUrl) {
        setNotice({ tone: "error", text: apiErrorMessage(data, res, "Monarch couldn't import the template.") });
        return;
      }
      setNotice({
        tone: "ok",
        text: `"${data.templateName}" (${data.categoryCount} categories, ${data.channelCount} channels) is loaded in the Server Designer as a draft.`,
        designerUrl: data.designerUrl,
      });
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      router.push(data.designerUrl);
    } catch (e) {
      setNotice({ tone: "error", text: networkErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-ink-700 bg-ink-900 p-4 sm:p-5">
        <h2 className="mb-1 text-sm font-semibold text-ink-100">Export this server</h2>
        <p className="mb-4 text-xs leading-relaxed text-ink-300">
          Downloads <span className="text-ink-100">{guildName}</span>&apos;s categories and channels
          as a portable Monarch template. Discord ids and server-specific settings are stripped, so
          the file can be imported into any server.
        </p>
        <a
          href={`/api/guilds/${guildId}/template`}
          download
          className="inline-flex items-center gap-2 rounded-lg bg-royal-500 px-4 py-2 text-sm font-medium text-white shadow shadow-royal-500/25 transition hover:bg-royal-400"
        >
          <DownloadIcon />
          Download template (.json)
        </a>
        <p className="mt-3 text-[11px] text-ink-400">
          Or run <code className="rounded bg-ink-800 px-1 py-0.5 text-ink-200">/monarch export</code> in
          Discord to get the file right in the channel.
        </p>
      </section>

      <section className="rounded-2xl border border-ink-700 bg-ink-900 p-4 sm:p-5">
        <h2 className="mb-1 text-sm font-semibold text-ink-100">Import a template</h2>
        <p className="mb-4 text-xs leading-relaxed text-ink-300">
          Load a Monarch template into the Server Designer. You&apos;ll see every change as a diff
          and nothing is applied until you confirm it there.
        </p>

        {!canDesign ? (
          <p className="rounded-lg border border-warn-400/20 bg-warn-400/10 px-3 py-2 text-xs text-warn-400">
            Importing needs the Monarch bot installed in this server and Manage Server permission.
          </p>
        ) : (
          <div className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-medium tracking-wide text-ink-400 uppercase">
                Template file
              </span>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full cursor-pointer rounded-lg border border-dashed border-ink-600 bg-ink-950/40 px-3 py-3 text-xs text-ink-300 file:mr-3 file:rounded-md file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-ink-100 hover:border-ink-500"
              />
            </label>

            <fieldset>
              <legend className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-400 uppercase">
                How to import
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <ModeOption
                  checked={mode === "add"}
                  onChange={() => setMode("add")}
                  title="Add to this server"
                  description="Keeps everything you have and appends the template's categories and channels below."
                />
                <ModeOption
                  checked={mode === "replace"}
                  onChange={() => setMode("replace")}
                  title="Replace the structure"
                  description="The template becomes the whole layout; anything not in it is deleted on apply (after confirmation)."
                />
              </div>
            </fieldset>

            <button
              onClick={() => void importTemplate()}
              disabled={!file || busy}
              className="rounded-lg border border-royal-500/40 bg-royal-500/10 px-4 py-2 text-sm font-medium text-royal-400 transition hover:bg-royal-500/20 disabled:opacity-50"
            >
              {busy ? "Importing…" : "Load into Server Designer"}
            </button>
          </div>
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
            <Link href={notice.designerUrl} className="ml-2 font-medium underline underline-offset-2">
              Open Server Designer →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function ModeOption({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  description: string;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition ${
        checked ? "border-royal-500/60 bg-royal-500/10" : "border-ink-700 hover:border-ink-500"
      }`}
    >
      <input type="radio" name="import-mode" checked={checked} onChange={onChange} className="mt-0.5 accent-royal-500" />
      <span>
        <span className="block text-xs font-medium text-ink-100">{title}</span>
        <span className="block text-[11px] leading-relaxed text-ink-400">{description}</span>
      </span>
    </label>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M8 2v8m0 0 3-3M8 10 5 7M3 12.5h10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
