"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AnalyzerReport } from "@monarch/analyzer";
import { apiErrorMessage, networkErrorMessage, readJsonSafe } from "@/lib/fetch-json";

/**
 * Design Analyzer (FEATURE 9). Read-only by spec: "Recommendations must
 * be suggestions. Do not automatically modify the server." The report is
 * computed server-side from the live design; the only thing this panel
 * writes is the per-guild "marked as intentional" list, which re-weights
 * the score on the next render (router.refresh()).
 */

const scoreTone = (score: number) =>
  score >= 80
    ? { text: "text-ok-400", bg: "bg-ok-400", chip: "bg-ok-400/10 text-ok-400 border-ok-400/25" }
    : score >= 60
      ? { text: "text-warn-400", bg: "bg-warn-400", chip: "bg-warn-400/10 text-warn-400 border-warn-400/25" }
      : { text: "text-danger-400", bg: "bg-danger-400", chip: "bg-danger-400/10 text-danger-400 border-danger-400/25" };

export function AnalyzerPanel({
  guildId,
  guildName,
  report,
  canDesign,
}: {
  guildId: string;
  guildName: string;
  report: AnalyzerReport;
  canDesign: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setDismissed = async (checkId: string, dismissed: boolean) => {
    setBusy(checkId);
    setError(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/analyzer/dismissals`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkId, dismissed }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        setError(apiErrorMessage(data, res, "Monarch couldn't save that."));
        return;
      }
      // The report is recomputed server-side from the stored dismissals.
      router.refresh();
    } catch (e) {
      setError(networkErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const exportMarkdown = () => {
    const md = reportToMarkdown(guildName, report);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(guildName)}-design-report.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const overall = scoreTone(report.overall);
  const failing = report.categories.flatMap((c) => c.checks).filter((c) => !c.pass && !c.dismissed);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-ink-700 bg-ink-900 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-5">
          <div className={`text-5xl font-semibold tracking-tight ${overall.text}`} aria-label={`Overall score ${report.overall} of 100`}>
            {report.overall}
            <span className="ml-1 text-base font-normal text-ink-400">/100</span>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink-100">Design score for {guildName}</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-300">
              {report.stats.categories} categories · {report.stats.channels} channels (
              {report.stats.topicsSet} with topics) · {report.stats.roles} roles (
              {report.stats.coloredRoles} colored)
            </p>
            <p className="mt-1 text-[11px] text-ink-400">
              Suggestions only — Monarch never changes your server from here.{" "}
              {report.dismissedCount > 0 &&
                `${report.dismissedCount} check${report.dismissedCount === 1 ? "" : "s"} marked intentional.`}
            </p>
          </div>
          <button
            onClick={exportMarkdown}
            className="rounded-lg border border-ink-600 px-3 py-2 text-xs font-medium text-ink-200 transition hover:border-ink-500 hover:text-ink-100"
          >
            Export report (.md)
          </button>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {report.categories.map((cat) => {
            const tone = scoreTone(cat.score);
            return (
              <div key={cat.id} className="rounded-xl border border-ink-700 bg-ink-950/40 p-3">
                <div className="flex items-baseline justify-between">
                  <p className="text-xs font-medium text-ink-200">{cat.label}</p>
                  <p className={`text-sm font-semibold ${tone.text}`}>{cat.score}%</p>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-800">
                  <div className={`h-full rounded-full ${tone.bg}`} style={{ width: `${cat.score}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {error && (
        <div role="status" className="rounded-xl border border-danger-400/25 bg-danger-400/10 px-4 py-3 text-xs text-danger-400">
          {error}
        </div>
      )}

      {failing.length === 0 ? (
        <section className="rounded-2xl border border-ok-400/25 bg-ok-400/5 p-4 text-xs text-ok-400 sm:p-5">
          Nothing to suggest right now — every check passes (or is marked intentional). Re-run the
          analyzer after reorganizing to keep an eye on consistency.
        </section>
      ) : (
        report.categories.map((cat) => {
          const flagged = cat.checks.filter((c) => (!c.pass || c.dismissed) && (c.suggestion || c.dismissed));
          if (flagged.length === 0) return null;
          return (
            <section key={cat.id} className="rounded-2xl border border-ink-700 bg-ink-900 p-4 sm:p-5">
              <h3 className="mb-3 text-sm font-semibold text-ink-100">
                {cat.label} <span className={`ml-1 text-xs font-semibold ${scoreTone(cat.score).text}`}>{cat.score}%</span>
              </h3>
              <ul className="space-y-3">
                {flagged.map((check) => (
                  <CheckRow
                    key={check.id}
                    check={check}
                    busy={busy === check.id}
                    canDesign={canDesign}
                    onDismiss={(dismissed) => void setDismissed(check.id, dismissed)}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}

      <section className="rounded-2xl border border-ink-700 bg-ink-900 p-4 text-[11px] leading-relaxed text-ink-400 sm:p-5">
        Passing checks are not listed. “Mark as intentional” removes a check from the score for
        this server — use it when an issue is a deliberate choice. The report reflects the live
        server as of {new Date(report.checkedAt).toLocaleString()}; re-open this page to re-analyze.
        For deeper structure work, open the{" "}
        <Link href={`/s/${guildId}/designer`} className="text-royal-400 underline underline-offset-2">
          Server Designer
        </Link>
        .
      </section>
    </div>
  );
}

function CheckRow({
  check,
  busy,
  canDesign,
  onDismiss,
}: {
  check: AnalyzerReport["categories"][number]["checks"][number];
  busy: boolean;
  canDesign: boolean;
  onDismiss: (dismissed: boolean) => void;
}) {
  const dismissed = !!check.dismissed;
  const tone = dismissed
    ? "border-ink-700 bg-ink-950/40 opacity-70"
    : check.pass
      ? "border-ok-400/20 bg-ok-400/5"
      : "border-warn-400/20 bg-warn-400/5";

  return (
    <li className={`rounded-xl border p-3 ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`text-xs font-medium ${dismissed ? "text-ink-400" : "text-ink-100"}`}>
          {!dismissed && !check.pass && <span className="mr-1.5 text-warn-400">⚠</span>}
          {dismissed && <span className="mr-1.5 text-ink-400">✓</span>}
          {check.label}
        </p>
        {dismissed ? (
          <span className="flex items-center gap-2">
            <span className="rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 text-[10px] font-medium text-ink-300">
              marked intentional
            </span>
            {canDesign && (
              <button
                onClick={() => onDismiss(false)}
                disabled={busy}
                className="text-[11px] text-royal-400 underline underline-offset-2 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Undo"}
              </button>
            )}
          </span>
        ) : check.pass ? (
          <span className="rounded border border-ok-400/25 bg-ok-400/10 px-1.5 py-0.5 text-[10px] font-medium text-ok-400">
            advisory
          </span>
        ) : (
          canDesign && (
            <button
              onClick={() => onDismiss(true)}
              disabled={busy}
              className="rounded-lg border border-ink-600 px-2 py-1 text-[11px] font-medium text-ink-300 transition hover:border-ink-500 hover:text-ink-100 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Mark as intentional"}
            </button>
          )
        )}
      </div>
      {check.suggestion && (
        <div className="mt-2 space-y-1 pl-4 text-[11px] leading-relaxed">
          <p className={dismissed ? "text-ink-400" : "text-ink-200"}>{check.suggestion.title}</p>
          {check.suggestion.detail && <p className="text-ink-400">{check.suggestion.detail}</p>}
          {check.suggestion.fix && (
            <p className="text-ink-300">
              <span className="font-medium text-ink-100">Suggestion: </span>
              {check.suggestion.fix}
            </p>
          )}
          {check.suggestion.affected && check.suggestion.affected.length > 0 && (
            <p className="text-ink-400">
              {check.suggestion.affected.map((name, i) => (
                <span key={i} className="mr-1.5 inline-block rounded bg-ink-800 px-1.5 py-0.5 text-ink-200">
                  {name}
                </span>
              ))}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function reportToMarkdown(guildName: string, report: AnalyzerReport): string {
  const lines: string[] = [
    `# Monarch design report — ${guildName}`,
    "",
    `Overall: **${report.overall}/100**`,
    "",
    `${report.stats.categories} categories · ${report.stats.channels} channels (${report.stats.topicsSet} with topics) · ${report.stats.roles} roles (${report.stats.coloredRoles} colored)`,
    "",
    "## Scores",
    "",
    ...report.categories.map((c) => `- ${c.label}: **${c.score}%**`),
    "",
    "## Suggestions",
    "",
  ];
  for (const cat of report.categories) {
    const flagged = cat.checks.filter((c) => !c.pass || c.suggestion);
    if (flagged.length === 0) continue;
    lines.push(`### ${cat.label} (${cat.score}%)`, "");
    for (const check of flagged) {
      lines.push(`- **${check.label}** — score ${Math.round(check.score * 100)}%${check.dismissed ? " (marked intentional)" : ""}`);
      if (check.suggestion) {
        lines.push(`  - ${check.suggestion.title}`);
        if (check.suggestion.detail) lines.push(`  - ${check.suggestion.detail}`);
        if (check.suggestion.fix) lines.push(`  - Suggestion: ${check.suggestion.fix}`);
        if (check.suggestion.affected?.length) lines.push(`  - Affected: ${check.suggestion.affected.join(", ")}`);
      }
    }
    lines.push("");
  }
  lines.push(`_Computed ${report.checkedAt} by Monarch. Suggestions only — nothing was changed._`);
  return lines.join("\n");
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "server"
  );
}
