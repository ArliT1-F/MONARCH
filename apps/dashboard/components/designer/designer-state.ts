import type { CategoryDesign, ChannelDesign, ChannelKind, ServerDesign } from "@monarch/schemas";
import { createLocalId } from "@monarch/shared";

/**
 * Server Designer state: a pure reducer with immutable history.
 *
 * - `base`    : the live Discord structure the draft diffs against
 * - `design`  : the draft being edited
 * - history   : past/future stacks of `design` (undo = Ctrl+Z, redo = Ctrl+Shift+Z)
 * - drag ops are transient: DRAG_BEGIN snapshots once, moves during the drag
 *   don't spam history, DRAG_COMMIT finalizes (or DRAG_CANCEL restores).
 */

export type Selection =
  | { kind: "channel"; id: string }
  | { kind: "category"; id: string }
  | null;

export interface DesignerState {
  status: "loading" | "ready" | "error";
  errorMessage?: string;
  base: ServerDesign | null;
  design: ServerDesign | null;
  past: ServerDesign[];
  future: ServerDesign[];
  dragSnapshot: ServerDesign | null;
  selection: Selection;
  /** Bumped on every design change; used for autosave debouncing. */
  revision: number;
}

export const initialDesignerState: DesignerState = {
  status: "loading",
  base: null,
  design: null,
  past: [],
  future: [],
  dragSnapshot: null,
  selection: null,
  revision: 0,
};

export type DesignerAction =
  | { type: "LOAD_SUCCESS"; base: ServerDesign; design: ServerDesign }
  | { type: "LOAD_ERROR"; message: string }
  | { type: "SELECT"; selection: Selection }
  | { type: "RENAME_CATEGORY"; id: string; name: string }
  | { type: "UPDATE_CHANNEL"; id: string; patch: Partial<Pick<ChannelDesign, "name" | "topic" | "nsfw" | "slowmode">> }
  | { type: "ADD_CATEGORY" }
  | { type: "ADD_CHANNEL"; kind: ChannelKind; parentId?: string }
  | { type: "DELETE_CHANNEL"; id: string }
  | { type: "DELETE_CATEGORY"; id: string }
  | { type: "DUPLICATE_CHANNEL"; id: string }
  | { type: "DUPLICATE_CATEGORY"; id: string }
  | { type: "MOVE_CHANNEL"; id: string; parentId: string | undefined; index: number; transient?: boolean }
  | { type: "MOVE_CATEGORY"; id: string; index: number; transient?: boolean }
  | { type: "DRAG_BEGIN" }
  | { type: "DRAG_COMMIT" }
  | { type: "DRAG_CANCEL" }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "RESET_TO_BASE" }
  | { type: "REBASE"; base: ServerDesign };

const HISTORY_LIMIT = 100;

export function designerReducer(state: DesignerState, action: DesignerAction): DesignerState {
  switch (action.type) {
    case "LOAD_SUCCESS":
      return {
        ...initialDesignerState,
        status: "ready",
        base: action.base,
        design: action.design,
      };
    case "LOAD_ERROR":
      return { ...state, status: "error", errorMessage: action.message };
    case "SELECT":
      return { ...state, selection: action.selection };
    case "UNDO": {
      if (state.past.length === 0 || !state.design) return state;
      const previous = state.past[state.past.length - 1]!;
      return {
        ...state,
        design: previous,
        past: state.past.slice(0, -1),
        future: [state.design, ...state.future].slice(0, HISTORY_LIMIT),
        revision: state.revision + 1,
      };
    }
    case "REDO": {
      if (state.future.length === 0 || !state.design) return state;
      const next = state.future[0]!;
      return {
        ...state,
        design: next,
        past: [...state.past, state.design].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        revision: state.revision + 1,
      };
    }
    case "DRAG_BEGIN":
      return { ...state, dragSnapshot: state.design };
    case "DRAG_COMMIT": {
      if (!state.dragSnapshot || !state.design) return { ...state, dragSnapshot: null };
      if (state.dragSnapshot === state.design) return { ...state, dragSnapshot: null };
      return {
        ...state,
        past: [...state.past, state.dragSnapshot].slice(-HISTORY_LIMIT),
        future: [],
        dragSnapshot: null,
        revision: state.revision + 1,
      };
    }
    case "DRAG_CANCEL":
      return {
        ...state,
        design: state.dragSnapshot ?? state.design,
        dragSnapshot: null,
      };
    case "RESET_TO_BASE": {
      if (!state.base || !state.design) return state;
      return mutate(state, () => structuredClone(state.base!), { selection: null });
    }
    case "REBASE":
      return {
        ...initialDesignerState,
        status: "ready",
        base: action.base,
        design: structuredClone(action.base),
      };
    default:
      return applyEdit(state, action);
  }
}

function applyEdit(state: DesignerState, action: DesignerAction): DesignerState {
  if (!state.design) return state;
  const d = state.design;

  switch (action.type) {
    case "RENAME_CATEGORY":
      return mutate(state, () => ({
        ...d,
        categories: d.categories.map((c) => (c.id === action.id ? { ...c, name: action.name } : c)),
      }));
    case "UPDATE_CHANNEL":
      return mutate(state, () => ({
        ...d,
        channels: d.channels.map((c) => (c.id === action.id ? { ...c, ...action.patch } : c)),
      }));
    case "ADD_CATEGORY": {
      const cat: CategoryDesign = {
        id: createLocalId(),
        name: "NEW CATEGORY",
        position: d.categories.length,
      };
      return mutate(state, () => reindex({ ...d, categories: [...d.categories, cat] }), {
        selection: { kind: "category", id: cat.id },
      });
    }
    case "ADD_CHANNEL": {
      const siblings = channelsIn(d, action.parentId);
      const ch: ChannelDesign = {
        id: createLocalId(),
        name: action.kind === "voice" || action.kind === "stage" ? "New Channel" : "new-channel",
        type: action.kind,
        position: siblings.length,
        parentId: action.parentId,
      };
      return mutate(state, () => reindex({ ...d, channels: [...d.channels, ch] }), {
        selection: { kind: "channel", id: ch.id },
      });
    }
    case "DELETE_CHANNEL":
      return mutate(state, () => reindex({ ...d, channels: d.channels.filter((c) => c.id !== action.id) }), {
        selection: state.selection?.id === action.id ? null : state.selection,
      });
    case "DELETE_CATEGORY": {
      // Channels inside a deleted category move to the top level (never silently deleted).
      return mutate(
        state,
        () =>
          reindex({
            ...d,
            categories: d.categories.filter((c) => c.id !== action.id),
            channels: d.channels.map((c) =>
              c.parentId === action.id ? { ...c, parentId: undefined } : c,
            ),
          }),
        { selection: state.selection?.id === action.id ? null : state.selection },
      );
    }
    case "DUPLICATE_CHANNEL": {
      const src = d.channels.find((c) => c.id === action.id);
      if (!src) return state;
      const copy: ChannelDesign = { ...src, id: createLocalId(), name: dupName(src.name) };
      const channels = [...d.channels];
      channels.splice(channels.indexOf(src) + 1, 0, copy);
      return mutate(state, () => reindex({ ...d, channels }), {
        selection: { kind: "channel", id: copy.id },
      });
    }
    case "DUPLICATE_CATEGORY": {
      const src = d.categories.find((c) => c.id === action.id);
      if (!src) return state;
      const copy: CategoryDesign = { ...src, id: createLocalId(), name: dupName(src.name) };
      const children = channelsIn(d, src.id).map((c) => ({
        ...c,
        id: createLocalId(),
        parentId: copy.id,
      }));
      return mutate(
        state,
        () =>
          reindex({
            ...d,
            categories: [...d.categories, copy],
            channels: [...d.channels, ...children],
          }),
        { selection: { kind: "category", id: copy.id } },
      );
    }
    case "MOVE_CHANNEL": {
      const next = moveChannel(d, action.id, action.parentId, action.index);
      if (!next) return state;
      return action.transient
        ? { ...state, design: next, revision: state.revision + 1 }
        : mutate(state, () => next);
    }
    case "MOVE_CATEGORY": {
      const ordered = [...d.categories].sort((a, b) => a.position - b.position);
      const from = ordered.findIndex((c) => c.id === action.id);
      if (from < 0) return state;
      const [cat] = ordered.splice(from, 1);
      ordered.splice(action.index, 0, cat!);
      const next = reindex({ ...d, categories: ordered });
      return action.transient
        ? { ...state, design: next, revision: state.revision + 1 }
        : mutate(state, () => next);
    }
    default:
      return state;
  }
}

function mutate(
  state: DesignerState,
  fn: () => ServerDesign,
  extra?: Partial<Pick<DesignerState, "selection">>,
): DesignerState {
  return {
    ...state,
    design: fn(),
    past: [...state.past, state.design!].slice(-HISTORY_LIMIT),
    future: [],
    revision: state.revision + 1,
    ...(extra ?? {}),
  };
}

// ── selectors & helpers ──────────────────────────────────────────────

export function channelsIn(design: ServerDesign, parentId: string | undefined): ChannelDesign[] {
  return design.channels
    .filter((c) => (c.parentId ?? undefined) === (parentId ?? undefined))
    .sort((a, b) => a.position - b.position);
}

export function orderedCategories(design: ServerDesign): CategoryDesign[] {
  return [...design.categories].sort((a, b) => a.position - b.position);
}

/** Recompute positions from array/group order so they're always dense. */
export function reindex(design: ServerDesign): ServerDesign {
  const categories = [...design.categories]
    .sort((a, b) => a.position - b.position)
    .map((c, i) => ({ ...c, position: i }));
  const groups = new Map<string, ChannelDesign[]>();
  for (const ch of [...design.channels].sort((a, b) => a.position - b.position)) {
    const key = ch.parentId ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ch);
  }
  const channels: ChannelDesign[] = [];
  for (const [, group] of groups) {
    group.forEach((ch, i) => channels.push({ ...ch, position: i }));
  }
  return { ...design, categories, channels };
}

function moveChannel(
  design: ServerDesign,
  channelId: string,
  parentId: string | undefined,
  index: number,
): ServerDesign | null {
  const ch = design.channels.find((c) => c.id === channelId);
  if (!ch) return null;
  const rest = design.channels.filter((c) => c.id !== channelId);
  const siblings = rest
    .filter((c) => (c.parentId ?? undefined) === (parentId ?? undefined))
    .sort((a, b) => a.position - b.position);
  const clamped = Math.max(0, Math.min(index, siblings.length));
  const moved: ChannelDesign = { ...ch, parentId, position: clamped - 0.5 };
  return reindex({ ...design, channels: [...rest, moved] });
}

function dupName(name: string) {
  return name.length >= 95 ? name : `${name}-copy`;
}
