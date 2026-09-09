import type { RoleDesign, ServerDesign } from "@monarch/schemas";
import { createLocalId } from "@monarch/shared";

/**
 * Role Designer state: a smaller, simpler version of the channel
 * designer state.
 *
 * - `base`    : the live roles on Discord, captured by fetchServerDesign
 * - `design`  : the draft being edited (just the roles array; channels
 *               and categories are read-only here — those live in the
 *               Server Designer)
 * - history   : past/future stacks of `design.roles` (undo/redo)
 *
 * Roles in Discord are flat (no parent), so there is no drag-reorder
 * step in this iteration — position is a number you edit. Hoist and
 * mentionable are checkboxes. Color is `#rrggbb`. The full permissions
 * editor is a Phase 6+ item; for now we expose the raw bitfield as a
 * decimal string plus a curated toggle grid (View Channel, Send
 * Messages, Read Message History, Manage Messages, Manage Channels,
 * Manage Roles, Manage Guild, Administrator) so a typical role
 * configuration is achievable without leaving Monarch.
 */
export interface RoleDesignerState {
  status: "loading" | "ready" | "error";
  errorMessage?: string;
  base: ServerDesign | null;
  design: ServerDesign | null;
  past: RoleDesign[][];
  future: RoleDesign[][];
  selection: { id: string } | null;
  /** Bumped on every design change; used for autosave debouncing. */
  revision: number;
}

export const initialRoleDesignerState: RoleDesignerState = {
  status: "loading",
  base: null,
  design: null,
  past: [],
  future: [],
  selection: null,
  revision: 0,
};

export type RoleDesignerAction =
  | { type: "LOAD_SUCCESS"; base: ServerDesign; design: ServerDesign }
  | { type: "LOAD_ERROR"; message: string }
  | { type: "SELECT"; id: string | null }
  | { type: "ADD_ROLE" }
  | { type: "DELETE_ROLE"; id: string }
  | { type: "DUPLICATE_ROLE"; id: string }
  | { type: "UPDATE_ROLE"; id: string; patch: Partial<RoleDesign> }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "RESET_TO_BASE" }
  | { type: "REBASE"; base: ServerDesign };

const HISTORY_LIMIT = 100;

export function roleDesignerReducer(
  state: RoleDesignerState,
  action: RoleDesignerAction,
): RoleDesignerState {
  switch (action.type) {
    case "LOAD_SUCCESS":
      return {
        ...initialRoleDesignerState,
        status: "ready",
        base: action.base,
        design: action.design,
      };
    case "LOAD_ERROR":
      return { ...state, status: "error", errorMessage: action.message };
    case "SELECT":
      return { ...state, selection: action.id ? { id: action.id } : null };
    case "UNDO": {
      if (state.past.length === 0 || !state.design) return state;
      const previous = state.past[state.past.length - 1]!;
      return {
        ...state,
        design: { ...state.design, roles: previous },
        past: state.past.slice(0, -1),
        future: [state.design.roles, ...state.future].slice(0, HISTORY_LIMIT),
        revision: state.revision + 1,
      };
    }
    case "REDO": {
      if (state.future.length === 0 || !state.design) return state;
      const next = state.future[0]!;
      return {
        ...state,
        design: { ...state.design, roles: next },
        past: [...state.past, state.design.roles].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        revision: state.revision + 1,
      };
    }
    case "RESET_TO_BASE": {
      if (!state.base || !state.design) return state;
      return mutate(state, () => state.base!.roles, { selection: null });
    }
    case "REBASE":
      return {
        ...initialRoleDesignerState,
        status: "ready",
        base: action.base,
        design: { ...action.base },
      };
    default:
      return applyEdit(state, action);
  }
}

function applyEdit(
  state: RoleDesignerState,
  action: RoleDesignerAction,
): RoleDesignerState {
  if (!state.design) return state;
  const d = state.design;

  switch (action.type) {
    case "ADD_ROLE": {
      const role: RoleDesign = {
        id: createLocalId(),
        name: "new role",
        color: undefined,
        hoist: false,
        mentionable: false,
        position: d.roles.length,
        permissions: "0",
        managed: false,
      };
      return mutate(
        state,
        () => [...d.roles, role],
        { selection: { id: role.id } },
      );
    }
    case "DELETE_ROLE": {
      const next = d.roles.filter((r) => r.id !== action.id);
      return mutate(state, () => next, {
        selection: state.selection?.id === action.id ? null : state.selection,
      });
    }
    case "DUPLICATE_ROLE": {
      const src = d.roles.find((r) => r.id === action.id);
      if (!src) return state;
      const copy: RoleDesign = { ...src, id: createLocalId(), name: dupName(src.name) };
      return mutate(state, () => [...d.roles, copy], { selection: { id: copy.id } });
    }
    case "UPDATE_ROLE":
      return mutate(state, () =>
        d.roles.map((r) => (r.id === action.id ? { ...r, ...action.patch } : r)),
      );
    default:
      return state;
  }
}

function mutate(
  state: RoleDesignerState,
  fn: () => RoleDesign[],
  extra?: Partial<Pick<RoleDesignerState, "selection">>,
): RoleDesignerState {
  if (!state.design) return state;
  return {
    ...state,
    design: { ...state.design, roles: fn() },
    past: [...state.past, state.design.roles].slice(-HISTORY_LIMIT),
    future: [],
    revision: state.revision + 1,
    ...(extra ?? {}),
  };
}

export function orderedRoles(design: ServerDesign): RoleDesign[] {
  return [...design.roles].sort((a, b) => b.position - a.position);
}

function dupName(name: string) {
  return name.length >= 95 ? name : `${name}-copy`;
}
