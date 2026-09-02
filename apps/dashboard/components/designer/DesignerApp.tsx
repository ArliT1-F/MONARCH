"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { GuildSummary, ServerDesign } from "@monarch/schemas";
import { diffServerDesign } from "@monarch/design-engine";
import { validateServerDesign } from "@monarch/validation";
import {
  designerReducer,
  initialDesignerState,
} from "./designer-state";
import { StructureTree } from "./StructureTree";
import { Inspector } from "./Inspector";
import { ReviewModal } from "./ReviewModal";

/**
 * Server Designer shell: loads live state + draft, wires undo/redo keyboard
 * shortcuts, autosaves the draft, and hosts the canvas / inspector panels.
 * Nothing here talks to Discord — applying happens through the Review modal
 * which calls the server-side plan/apply routes.
 */
export function DesignerApp({ guildId }: { guildId: string }) {
  const [state, dispatch] = useReducer(designerReducer, initialDesignerState);
  const [guild, setGuild] = useState<GuildSummary | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [reviewOpen, setReviewOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/guilds/${guildId}/state`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        dispatch({
          type: "LOAD_ERROR",
          message: data?.error?.message ?? "Monarch couldn't load this server.",
        });
        return;
      }
      const data = await res.json();
      setGuild(data.guild);
      const base: ServerDesign = data.current;
      const design: ServerDesign = data.draft?.design ?? structuredClone(base);
      design.guildId = base.guildId;
      dispatch({ type: "LOAD_SUCCESS", base, design });
    } catch {
      dispatch({ type: "LOAD_ERROR", message: "Network error while loading the server." });
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── keyboard shortcuts ────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const target = e.target as HTMLElement;
      const inField = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
      if (e.key.toLowerCase() === "z" && !inField) {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "REDO" : "UNDO" });
      } else if (e.key.toLowerCase() === "y" && !inField) {
        e.preventDefault();
        dispatch({ type: "REDO" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── derived: diff + validation (client-side preview; server re-checks) ──
  const diff = useMemo(
    () => (state.base && state.design ? diffServerDesign(state.base, state.design) : null),
    [state.base, state.design],
  );
  const validation = useMemo(
    () => (state.design ? validateServerDesign(state.design) : null),
    [state.design],
  );
  const dirty = !!diff && !diff.isEmpty;

  // ── autosave draft ────────────────────────────────────────────────
  useEffect(() => {
    if (state.status !== "ready" || !state.design || !state.base) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveState("saving");
      try {
        const res = await fetch(`/api/guilds/${guildId}/draft`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ design: state.design, baseDesign: state.base }),
        });
        setSaveState(res.ok ? "saved" : "error");
      } catch {
        setSaveState("error");
      }
    }, 1200);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.revision, guildId, state.status]);

  const discardDraft = async () => {
    if (!confirm("Discard this draft and return to the live server structure?")) return;
    await fetch(`/api/guilds/${guildId}/draft`, { method: "DELETE" });
    dispatch({ type: "RESET_TO_BASE" });
  };

  if (state.status === "loading") {
    return (
      <div className="flex h-[70vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-ink-600 border-t-royal-500" />
          <p className="text-xs text-ink-400">Reading server structure…</p>
        </div>
      </div>
    );
  }

  if (state.status === "error" || !state.design || !state.base) {
    return (
      <div className="flex h-[70vh] items-center justify-center px-8">
        <div className="max-w-sm rounded-2xl border border-danger-400/30 bg-danger-400/5 p-6 text-center">
          <p className="mb-2 text-sm font-medium text-danger-400">Couldn&apos;t load the designer</p>
          <p className="mb-4 text-xs text-ink-300">{state.errorMessage}</p>
          <button
            onClick={() => void load()}
            className="rounded-lg border border-ink-600 px-4 py-2 text-xs text-ink-200 hover:border-ink-400"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const changeCount = diff
    ? diff.creates.length + diff.modifies.length + diff.renames.length + diff.moves.length + diff.deletes.length
    : 0;

  return (
    <div className="flex h-screen flex-col">
      {/* ── toolbar ── */}
      <header className="flex items-center gap-3 border-b border-ink-800 bg-ink-900/60 px-5 py-2.5 backdrop-blur">
        <div>
          <h1 className="text-sm font-semibold text-ink-100">Server Designer</h1>
          <p className="text-[11px] text-ink-400">
            Draft → Preview → Diff → Apply. Discord is untouched while you edit.
          </p>
        </div>

        <div className="mx-4 h-6 w-px bg-ink-700" />

        <button
          onClick={() => dispatch({ type: "UNDO" })}
          disabled={state.past.length === 0}
          title="Undo (Ctrl+Z)"
          className="rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs text-ink-200 transition hover:border-ink-500 disabled:opacity-35"
        >
          ↩ Undo
        </button>
        <button
          onClick={() => dispatch({ type: "REDO" })}
          disabled={state.future.length === 0}
          title="Redo (Ctrl+Shift+Z)"
          className="rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs text-ink-200 transition hover:border-ink-500 disabled:opacity-35"
        >
          ↪ Redo
        </button>

        <div className="ml-auto flex items-center gap-3">
          <span className="text-[11px] text-ink-400">
            {dirty ? (
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-gold-400" />
                Unsaved changes
                {saveState === "saving" && " · saving draft…"}
                {saveState === "saved" && " · draft saved"}
                {saveState === "error" && (
                  <span className="text-danger-400"> · draft save failed</span>
                )}
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-ok-400" />
                In sync with Discord
              </span>
            )}
          </span>

          {dirty && (
            <button
              onClick={discardDraft}
              className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 transition hover:border-danger-400/50 hover:text-danger-400"
            >
              Discard
            </button>
          )}
          <button
            onClick={() => setReviewOpen(true)}
            disabled={!dirty}
            className="rounded-lg bg-royal-500 px-4 py-1.5 text-xs font-medium text-white shadow shadow-royal-500/25 transition hover:bg-royal-400 disabled:opacity-40"
          >
            Review changes{changeCount > 0 ? ` (${changeCount})` : ""}
          </button>
        </div>
      </header>

      {/* ── validation strip ── */}
      {validation && validation.issues.length > 0 && (
        <div
          className={`border-b px-5 py-1.5 text-[11px] ${
            validation.errors.length > 0
              ? "border-danger-400/20 bg-danger-400/10 text-danger-400"
              : "border-warn-400/20 bg-warn-400/10 text-warn-400"
          }`}
        >
          {validation.errors.length > 0
            ? `${validation.errors.length} validation error(s) must be fixed before applying`
            : `${validation.warnings.length} warning(s)`}
          {" — "}
          {(validation.errors[0] ?? validation.warnings[0])?.message}
        </div>
      )}

      {/* ── canvas + inspector ── */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <StructureTree state={state} dispatch={dispatch} />
        </div>
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-ink-800 bg-ink-900/40 p-4">
          <Inspector state={state} dispatch={dispatch} validation={validation} />
        </aside>
      </div>

      {reviewOpen && guild && (
        <ReviewModal
          guildId={guildId}
          design={state.design}
          onClose={() => setReviewOpen(false)}
          onApplied={(fresh) => {
            setReviewOpen(false);
            dispatch({ type: "REBASE", base: fresh });
          }}
        />
      )}
    </div>
  );
}
