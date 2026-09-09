"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { GuildSummary, ServerDesign } from "@monarch/schemas";
import { diffServerDesign } from "@monarch/design-engine";
import { validateServerDesign } from "@monarch/validation";
import { apiErrorMessage, networkErrorMessage, readJsonSafe } from "@/lib/fetch-json";
import {
  roleDesignerReducer,
  initialRoleDesignerState,
  orderedRoles,
} from "./role-designer-state";
import { RoleInspector } from "./RoleInspector";
import { ReviewModal } from "./ReviewModal";

/**
 * Role Designer shell. Same shape as DesignerApp but scoped to roles:
 *   - Loads live state + draft, wires undo/redo, autosaves the draft
 *     (the dashboard autosave endpoint already accepts a full ServerDesign,
 *     so we just save the design with all fields intact and the channel
 *     /category edits untouched).
 *   - The left panel is a flat list of roles (sorted by position desc,
 *     matching how Discord displays them).
 *   - The right panel is the role inspector.
 *   - The toolbar reuses the ReviewModal — the apply pipeline already
 *     handles role diffs.
 */
export function RoleDesigner({ guildId }: { guildId: string }) {
  const [state, dispatch] = useReducer(roleDesignerReducer, initialRoleDesignerState);
  const [guild, setGuild] = useState<GuildSummary | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"list" | "inspector">("list");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/guilds/${guildId}/state`);
      const data = await readJsonSafe<{
        guild: GuildSummary;
        current: ServerDesign;
        draft: { design: ServerDesign } | null;
        error?: { message?: string };
      }>(res);
      if (!res.ok || !data) {
        dispatch({
          type: "LOAD_ERROR",
          message: !res.ok
            ? apiErrorMessage(data, res, "Monarch couldn't load this server.")
            : "Monarch returned an empty response. Try again in a moment.",
        });
        return;
      }
      setGuild(data.guild);
      const base: ServerDesign = data.current;
      // Use the existing draft if it exists (it'll have role edits
      // already), otherwise clone the live state.
      const design: ServerDesign = data.draft?.design ?? structuredClone(base);
      design.guildId = base.guildId;
      dispatch({ type: "LOAD_SUCCESS", base, design });
    } catch (e) {
      dispatch({ type: "LOAD_ERROR", message: networkErrorMessage(e) });
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

  useEffect(() => {
    if (state.selection) setMobilePane("inspector");
  }, [state.selection]);

  // ── derived: diff + validation ────────────────────────────────────
  // Roles live inside ServerDesign, so the same diff/validation pipeline
  // covers them. The Review modal already shows the full diff.
  const diff = useMemo(
    () => (state.base && state.design ? diffServerDesign(state.base, state.design) : null),
    [state.base, state.design],
  );
  const validation = useMemo(
    () => (state.design ? validateServerDesign(state.design) : null),
    [state.design],
  );
  const roleDiffCount = useMemo(() => {
    if (!diff) return 0;
    return diff.entries.filter((e) => e.resource === "role" && e.op !== "unsupported").length;
  }, [diff]);
  const dirty = roleDiffCount > 0;

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
    if (!confirm("Discard this draft and return to the live server roles?")) return;
    await fetch(`/api/guilds/${guildId}/draft`, { method: "DELETE" });
    dispatch({ type: "RESET_TO_BASE" });
  };

  if (state.status === "loading") {
    return (
      <div className="flex h-[70vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-ink-600 border-t-royal-500" />
          <p className="text-xs text-ink-400">Reading server roles…</p>
        </div>
      </div>
    );
  }

  if (state.status === "error" || !state.design || !state.base) {
    return (
      <div className="flex h-[70vh] items-center justify-center px-8">
        <div className="max-w-sm rounded-2xl border border-danger-400/30 bg-danger-400/5 p-6 text-center">
          <p className="mb-2 text-sm font-medium text-danger-400">Couldn&apos;t load the role designer</p>
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

  return (
    <div className="flex h-[calc(100dvh-3.25rem)] flex-col md:h-screen">
      {/* ── toolbar ── */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-800 bg-ink-900/60 px-3 py-2 backdrop-blur sm:px-5 sm:py-2.5">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-ink-100">Role Designer</h1>
          <p className="hidden text-[11px] text-ink-400 sm:block">
            Names, colors, hoist, mentionable, and the curated permission grid.
            Draft → Preview → Diff → Apply.
          </p>
        </div>

        <div className="mx-1 hidden h-6 w-px bg-ink-700 sm:mx-4 sm:block" />

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => dispatch({ type: "UNDO" })}
            disabled={state.past.length === 0}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
            className="rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs text-ink-200 transition hover:border-ink-500 disabled:opacity-35"
          >
            ↩<span className="hidden sm:inline"> Undo</span>
          </button>
          <button
            onClick={() => dispatch({ type: "REDO" })}
            disabled={state.future.length === 0}
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
            className="rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs text-ink-200 transition hover:border-ink-500 disabled:opacity-35"
          >
            ↪<span className="hidden sm:inline"> Redo</span>
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <span className="text-[11px] text-ink-400" aria-live="polite">
            {dirty ? (
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-gold-400" />
                <span className="hidden sm:inline">Unsaved changes</span>
                <span className="sm:hidden">Unsaved</span>
                {saveState === "saving" && <span className="hidden sm:inline"> · saving draft…</span>}
                {saveState === "saved" && <span className="hidden sm:inline"> · draft saved</span>}
                {saveState === "error" && (
                  <span className="text-danger-400"> · draft save failed</span>
                )}
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-ok-400" />
                <span className="hidden sm:inline">In sync with Discord</span>
                <span className="sm:hidden">In sync</span>
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
            className="rounded-lg bg-royal-500 px-3 py-1.5 text-xs font-medium text-white shadow shadow-royal-500/25 transition hover:bg-royal-400 disabled:opacity-40 sm:px-4"
          >
            Review{roleDiffCount > 0 ? ` (${roleDiffCount})` : ""}
            <span className="hidden sm:inline"> changes</span>
          </button>
        </div>
      </header>

      {/* ── mobile pane switch ── */}
      <div className="flex border-b border-ink-800 bg-ink-900/40 md:hidden" role="tablist" aria-label="Role designer panes">
        {(["list", "inspector"] as const).map((pane) => (
          <button
            key={pane}
            role="tab"
            aria-selected={mobilePane === pane}
            onClick={() => setMobilePane(pane)}
            className={`flex-1 py-2 text-xs font-medium transition ${
              mobilePane === pane
                ? "border-b-2 border-royal-400 text-royal-400"
                : "text-ink-400 hover:text-ink-200"
            }`}
          >
            {pane === "list" ? "Roles" : "Inspector"}
          </button>
        ))}
      </div>

      {/* ── validation strip ── */}
      {validation && validation.errors.length > 0 && (
        <div className="border-b border-danger-400/20 bg-danger-400/10 px-3 py-1.5 text-[11px] text-danger-400 sm:px-5">
          {validation.errors.length} validation error(s) must be fixed before applying
          {" — "}
          {validation.errors[0]?.message}
        </div>
      )}

      {/* ── list + inspector ── */}
      <div className="flex min-h-0 flex-1">
        <div
          className={`min-w-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6 sm:py-5 ${
            mobilePane === "list" ? "block" : "hidden md:block"
          }`}
        >
          <RoleList state={state} dispatch={dispatch} />
        </div>
        <aside
          className={`w-full shrink-0 overflow-y-auto border-ink-800 bg-ink-900/40 p-4 md:w-80 md:border-l ${
            mobilePane === "inspector" ? "block" : "hidden md:block"
          }`}
        >
          <RoleInspector state={state} dispatch={dispatch} validation={validation} />
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

function RoleList({
  state,
  dispatch,
}: {
  state: ReturnType<typeof roleDesignerReducer>;
  dispatch: React.Dispatch<Parameters<typeof roleDesignerReducer>[1]>;
}) {
  const design = state.design!;
  const ordered = orderedRoles(design);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-semibold tracking-[0.18em] text-ink-400 uppercase">
            Roles · {ordered.length}
          </p>
          <p className="mt-1 text-[11px] text-ink-500">
            Highest position (e.g. 0) is the top of Discord&apos;s role list.
          </p>
        </div>
        <button
          onClick={() => dispatch({ type: "ADD_ROLE" })}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-200 transition hover:border-royal-500/50 hover:text-royal-400"
        >
          + New role
        </button>
      </div>

      <ul className="space-y-1.5">
        {ordered.map((role) => {
          const active = state.selection?.id === role.id;
          return (
            <li key={role.id}>
              <button
                onClick={() => dispatch({ type: "SELECT", id: role.id })}
                className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-xs transition ${
                  active
                    ? "border-royal-500/50 bg-royal-500/10 text-royal-400"
                    : "border-ink-800 bg-ink-900/30 text-ink-200 hover:border-ink-600 hover:bg-ink-900/60"
                }`}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full border border-ink-700"
                  style={{ background: role.color ?? "transparent" }}
                />
                <span className="flex-1 truncate font-medium">{role.name}</span>
                <span className="text-[10px] text-ink-500">
                  @{role.position}
                </span>
                {role.hoist && (
                  <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[9px] text-ink-400 uppercase">
                    hoist
                  </span>
                )}
                {role.managed && (
                  <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[9px] text-ink-400 uppercase">
                    managed
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {ordered.length === 0 && (
          <li className="rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-[11px] text-ink-400">
            No roles yet. Add the first one to get started.
          </li>
        )}
      </ul>
    </div>
  );
}
