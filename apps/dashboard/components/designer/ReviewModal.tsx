"use client";

import { useEffect, useState } from "react";
import type { ServerDesign } from "@monarch/schemas";
import type { ServerDiff } from "@monarch/design-engine";
import type { ValidationReport } from "@monarch/validation";
import type { MonarchError } from "@monarch/shared";

/**
 * Review & apply modal:
 *   server-side plan (validation + diff against LIVE state)
 *   → explicit destructive confirmation
 *   → apply → per-step results.
 */
interface PlanResponse {
  validation: ValidationReport;
  diff: ServerDiff;
  destructive: boolean;
  stepCount: number;
}

interface ApplyStepResult {
  describe: string;
  status: "done" | "failed" | "skipped";
  error?: MonarchError;
}

export function ReviewModal({
  guildId,
  design,
  onClose,
  onApplied,
}: {
  guildId: string;
  design: ServerDesign;
  onClose: () => void;
  onApplied: (freshCurrent: ServerDesign) => void;
}) {
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [confirmDestructive, setConfirmDestructive] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{
    ok: boolean;
    steps: ApplyStepResult[];
    current?: ServerDesign;
  } | null>(null);
  const [applyError, setApplyError] = useState<MonarchError | null>(null);

  useEffect(() => {
    fetch(`/api/guilds/${guildId}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ design }),
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error?.message ?? "Couldn't compute the change preview.");
        setPlan(data);
      })
      .catch((e) => setPlanError(String(e.message ?? e)));
  }, [guildId, design]);

  async function apply() {
    if (!plan) return;
    setApplying(true);
    setApplyError(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design, confirmDestructive }),
      });
      const data = await res.json();
      if (!res.ok) {
        setApplyError(data?.error ?? { code: "apply", message: "Apply failed." });
      } else {
        setApplyResult({ ok: data.ok, steps: data.steps ?? [], current: data.current });
      }
    } catch {
      setApplyError({ code: "network", message: "Network error while applying." });
    } finally {
      setApplying(false);
    }
  }

  const blocked = !!plan && !plan.validation.valid;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div className="animate-fade-up flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl">
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-ink-100">Monarch change preview</h2>
            <p className="text-[11px] text-ink-400">
              Computed against the live server — nothing has been changed yet.
            </p>
          </div>
          <button onClick={onClose} className="text-ink-400 transition hover:text-ink-100">
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* result view */}
          {applyResult ? (
            <div>
              <p
                className={`mb-3 text-sm font-medium ${applyResult.ok ? "text-ok-400" : "text-warn-400"}`}
              >
                {applyResult.ok
                  ? "✓ All changes applied to Discord."
                  : "Some changes couldn't be applied. Completed steps are kept; re-open the review to retry the rest."}
              </p>
              <ul className="space-y-1">
                {applyResult.steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    <span
                      className={
                        s.status === "done"
                          ? "text-ok-400"
                          : s.status === "failed"
                            ? "text-danger-400"
                            : "text-ink-500"
                      }
                    >
                      {s.status === "done" ? "✓" : s.status === "failed" ? "✕" : "–"}
                    </span>
                    <span className="text-ink-200">
                      {s.describe}
                      {s.error && (
                        <span className="block text-[11px] text-danger-400">
                          {s.error.message} {s.error.fix && <em className="text-ink-400">{s.error.fix}</em>}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : planError ? (
            <ErrorBox message={planError} />
          ) : !plan ? (
            <div className="flex items-center justify-center py-10">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-600 border-t-royal-500" />
              <span className="ml-3 text-xs text-ink-400">Computing diff…</span>
            </div>
          ) : (
            <>
              {/* validation */}
              {plan.validation.issues.length > 0 && (
                <div className="mb-4 space-y-1.5">
                  {plan.validation.errors.map((e, i) => (
                    <p key={`e${i}`} className="rounded-lg border border-danger-400/25 bg-danger-400/5 px-3 py-2 text-[11px] text-danger-400">
                      ❌ {e.message} {e.fix && <span className="text-ink-400">{e.fix}</span>}
                    </p>
                  ))}
                  {plan.validation.warnings.map((w, i) => (
                    <p key={`w${i}`} className="rounded-lg border border-warn-400/25 bg-warn-400/5 px-3 py-2 text-[11px] text-warn-400">
                      ⚠ {w.message} {w.fix && <span className="text-ink-400">{w.fix}</span>}
                    </p>
                  ))}
                </div>
              )}

              {/* summary */}
              <div className="mb-4 flex gap-2 text-[11px]">
                <SummaryPill color="text-ok-400" label={`+ ${plan.diff.creates.length} created`} />
                <SummaryPill
                  color="text-warn-400"
                  label={`~ ${plan.diff.renames.length + plan.diff.modifies.length + plan.diff.moves.length} changed`}
                />
                <SummaryPill color="text-danger-400" label={`- ${plan.diff.deletes.length} deleted`} />
                <SummaryPill color="text-ink-400" label={`${plan.diff.unchangedCount} unchanged`} />
              </div>

              {plan.diff.isEmpty ? (
                <p className="py-6 text-center text-xs text-ink-400">
                  This design matches the live server — nothing to apply.
                </p>
              ) : (
                <ul className="space-y-1 font-mono text-[12px]">
                  {plan.diff.creates.map((e, i) => (
                    <DiffLine key={`c${i}`} sign="+" tone="text-ok-400">
                      {e.resource === "category" ? "category " : ""}
                      {e.resource === "channel" ? "#" : ""}
                      {e.name}
                    </DiffLine>
                  ))}
                  {plan.diff.renames.map((e, i) => (
                    <DiffLine key={`r${i}`} sign="~" tone="text-warn-400">
                      {e.before} → {e.after}
                    </DiffLine>
                  ))}
                  {plan.diff.modifies.map((e, i) => (
                    <DiffLine key={`m${i}`} sign="~" tone="text-warn-400">
                      {e.name} · {e.changes.map((c) => c.field).join(", ")}
                    </DiffLine>
                  ))}
                  {plan.diff.moves.map((e, i) => (
                    <DiffLine key={`v${i}`} sign="~" tone="text-warn-400">
                      {e.name} moved
                    </DiffLine>
                  ))}
                  {plan.diff.deletes.map((e, i) => (
                    <DiffLine key={`d${i}`} sign="-" tone="text-danger-400">
                      {e.resource === "category" ? "category " : "#"}
                      {e.name}
                    </DiffLine>
                  ))}
                  {plan.diff.unsupported.map((e, i) => (
                    <DiffLine key={`u${i}`} sign="!" tone="text-ink-400">
                      {e.name} — {e.reason}
                    </DiffLine>
                  ))}
                </ul>
              )}

              {plan.destructive && (
                <label className="mt-4 flex items-start gap-2 rounded-lg border border-danger-400/25 bg-danger-400/5 px-3 py-2.5 text-[11px] text-ink-200">
                  <input
                    type="checkbox"
                    checked={confirmDestructive}
                    onChange={(e) => setConfirmDestructive(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 accent-danger-400"
                  />
                  <span>
                    I understand {plan.diff.deletes.length} item(s) will be{" "}
                    <strong className="text-danger-400">permanently deleted</strong> on Discord.
                    Monarch snapshots the structure first, but deleted message history cannot be
                    restored.
                  </span>
                </label>
              )}

              {applyError && (
                <div className="mt-4">
                  <ErrorBox
                    message={applyError.message}
                    reason={applyError.reason}
                    fix={applyError.fix}
                  />
                </div>
              )}
            </>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-ink-800 px-5 py-3.5">
          {applyResult ? (
            <button
              onClick={() => (applyResult.current ? onApplied(applyResult.current) : onClose())}
              className="rounded-lg bg-royal-500 px-4 py-2 text-xs font-medium text-white transition hover:bg-royal-400"
            >
              Done
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="rounded-lg border border-ink-700 px-4 py-2 text-xs text-ink-300 transition hover:border-ink-500"
              >
                Cancel
              </button>
              <button
                onClick={apply}
                disabled={
                  !plan ||
                  plan.diff.isEmpty ||
                  blocked ||
                  applying ||
                  (plan.destructive && !confirmDestructive)
                }
                className="rounded-lg bg-royal-500 px-4 py-2 text-xs font-medium text-white transition hover:bg-royal-400 disabled:opacity-40"
                title={blocked ? "Fix validation errors first" : undefined}
              >
                {applying ? "Applying…" : "Apply to Discord"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function SummaryPill({ color, label }: { color: string; label: string }) {
  return (
    <span className={`rounded-full border border-ink-700 bg-ink-850 px-2.5 py-1 font-medium ${color}`}>
      {label}
    </span>
  );
}

function DiffLine({
  sign,
  tone,
  children,
}: {
  sign: string;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-2 rounded px-2 py-0.5 hover:bg-ink-850">
      <span className={`${tone} w-3 shrink-0 text-center font-bold`}>{sign}</span>
      <span className="min-w-0 flex-1 truncate text-ink-200">{children}</span>
    </li>
  );
}

function ErrorBox({ message, reason, fix }: { message: string; reason?: string; fix?: string }) {
  return (
    <div className="rounded-lg border border-danger-400/25 bg-danger-400/5 px-4 py-3 text-xs">
      <p className="font-medium text-danger-400">{message}</p>
      {reason && <p className="mt-1 text-ink-300">{reason}</p>}
      {fix && <p className="mt-1 text-ink-400">{fix}</p>}
    </div>
  );
}
