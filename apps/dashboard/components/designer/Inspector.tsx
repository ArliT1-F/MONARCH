"use client";

import type { ValidationReport } from "@monarch/validation";
import { supportsTopic } from "@monarch/renderer";
import { DiscordLimits } from "@monarch/validation";
import type { DesignerAction, DesignerState } from "./designer-state";
import { channelsIn } from "./designer-state";

/**
 * Inspector (right panel): properties of the selected channel/category,
 * with live character counts and inline validation.
 */
export function Inspector({
  state,
  dispatch,
  validation,
}: {
  state: DesignerState;
  dispatch: React.Dispatch<DesignerAction>;
  validation: ValidationReport | null;
}) {
  const design = state.design!;
  const sel = state.selection;

  if (!sel) {
    return (
      <div className="flex h-full flex-col">
        <PanelTitle>Inspector</PanelTitle>
        <div className="mt-10 text-center">
          <p className="mb-1 text-xs font-medium text-ink-300">Nothing selected</p>
          <p className="text-[11px] leading-relaxed text-ink-400">
            Select a channel or category on the canvas to edit its properties. Drag rows to
            reorder or move between categories.
          </p>
        </div>
        <IssueList validation={validation} />
      </div>
    );
  }

  if (sel.kind === "category") {
    const cat = design.categories.find((c) => c.id === sel.id);
    if (!cat) return null;
    const childCount = channelsIn(design, cat.id).length;
    return (
      <div>
        <PanelTitle>Category</PanelTitle>
        <Field label="Name" count={`${cat.name.length}/${DiscordLimits.channel.nameMax}`}>
          <input
            value={cat.name}
            onChange={(e) => dispatch({ type: "RENAME_CATEGORY", id: cat.id, name: e.target.value })}
            className={inputCls}
          />
        </Field>
        <p className="mb-4 text-[11px] text-ink-400">
          {childCount} channel{childCount === 1 ? "" : "s"} inside
        </p>
        <div className="flex gap-2">
          <ActionButton onClick={() => dispatch({ type: "DUPLICATE_CATEGORY", id: cat.id })}>
            Duplicate
          </ActionButton>
          <ActionButton
            danger
            onClick={() => {
              if (
                childCount === 0 ||
                confirm(`Delete category "${cat.name}"? Its ${childCount} channel(s) move to the top level.`)
              ) {
                dispatch({ type: "DELETE_CATEGORY", id: cat.id });
              }
            }}
          >
            Delete
          </ActionButton>
        </div>
        <IssueList validation={validation} entityId={cat.id} />
      </div>
    );
  }

  const ch = design.channels.find((c) => c.id === sel.id);
  if (!ch) return null;
  const topicMax =
    ch.type === "forum" ? DiscordLimits.channel.forumTopicMax : DiscordLimits.channel.topicMax;

  return (
    <div>
      <PanelTitle>
        {ch.type.charAt(0).toUpperCase() + ch.type.slice(1)} channel
      </PanelTitle>

      <Field label="Name" count={`${ch.name.length}/${DiscordLimits.channel.nameMax}`}>
        <input
          value={ch.name}
          onChange={(e) => dispatch({ type: "UPDATE_CHANNEL", id: ch.id, patch: { name: e.target.value } })}
          className={inputCls}
        />
      </Field>

      {supportsTopic(ch.type) && (
        <Field label="Topic" count={`${ch.topic?.length ?? 0}/${topicMax}`}>
          <textarea
            value={ch.topic ?? ""}
            rows={3}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_CHANNEL",
                id: ch.id,
                patch: { topic: e.target.value || undefined },
              })
            }
            className={`${inputCls} resize-none`}
            placeholder="What is this channel about?"
          />
        </Field>
      )}

      {(ch.type === "text" || ch.type === "forum") && (
        <>
          <Field label="Slowmode (seconds)">
            <input
              type="number"
              min={0}
              max={DiscordLimits.channel.slowmodeMax}
              value={ch.slowmode ?? 0}
              onChange={(e) =>
                dispatch({
                  type: "UPDATE_CHANNEL",
                  id: ch.id,
                  patch: { slowmode: Math.max(0, Number(e.target.value) || 0) || undefined },
                })
              }
              className={inputCls}
            />
          </Field>
          <label className="mb-4 flex items-center gap-2 text-xs text-ink-200">
            <input
              type="checkbox"
              checked={ch.nsfw ?? false}
              onChange={(e) =>
                dispatch({
                  type: "UPDATE_CHANNEL",
                  id: ch.id,
                  patch: { nsfw: e.target.checked || undefined },
                })
              }
              className="h-3.5 w-3.5 accent-royal-500"
            />
            Age-restricted (NSFW)
          </label>
        </>
      )}

      <div className="flex gap-2">
        <ActionButton onClick={() => dispatch({ type: "DUPLICATE_CHANNEL", id: ch.id })}>
          Duplicate
        </ActionButton>
        <ActionButton
          danger
          onClick={() => {
            if (confirm(`Remove "#${ch.name}" from this design? It will be deleted on Discord when you apply.`)) {
              dispatch({ type: "DELETE_CHANNEL", id: ch.id });
            }
          }}
        >
          Delete
        </ActionButton>
      </div>

      <IssueList validation={validation} entityId={ch.id} />
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-xs text-ink-100 outline-none transition focus:border-royal-500";

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-4 text-[10px] font-semibold tracking-[0.18em] text-ink-400 uppercase">
      {children}
    </p>
  );
}

function Field({
  label,
  count,
  children,
}: {
  label: string;
  count?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline justify-between">
        <label className="text-[11px] font-medium text-ink-300">{label}</label>
        {count && <span className="text-[10px] text-ink-500">{count}</span>}
      </div>
      {children}
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-lg border px-3 py-1.5 text-xs transition ${
        danger
          ? "border-ink-700 text-ink-300 hover:border-danger-400/50 hover:text-danger-400"
          : "border-ink-700 text-ink-200 hover:border-ink-500"
      }`}
    >
      {children}
    </button>
  );
}

function IssueList({
  validation,
  entityId,
}: {
  validation: ValidationReport | null;
  entityId?: string;
}) {
  if (!validation) return null;
  const issues = entityId
    ? validation.issues.filter((i) => i.target?.id === entityId)
    : validation.issues;
  if (issues.length === 0) return null;
  return (
    <div className="mt-6 space-y-2">
      <p className="text-[10px] font-semibold tracking-[0.18em] text-ink-400 uppercase">
        {entityId ? "Issues here" : "Design issues"}
      </p>
      {issues.slice(0, 6).map((issue, i) => (
        <div
          key={i}
          className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
            issue.severity === "error"
              ? "border-danger-400/25 bg-danger-400/5 text-danger-400"
              : "border-warn-400/25 bg-warn-400/5 text-warn-400"
          }`}
        >
          {issue.message}
          {issue.fix && <span className="block text-ink-400">{issue.fix}</span>}
        </div>
      ))}
    </div>
  );
}
