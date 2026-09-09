import type { ServerDesign, ChannelDesign, CategoryDesign, RoleDesign } from "@monarch/schemas";
import { isLocalId } from "@monarch/shared";

/**
 * Monarch diff engine.
 *
 * Compares the CURRENT state (as a ServerDesign captured from Discord) with
 * a DESIRED design and produces a ServerDiff. The same engine is used by the
 * Server Designer, restore, clone, import and templates — do not fork it
 * per-feature.
 *
 * Matching is id-based: entities carrying a Discord snowflake are matched to
 * current entities; entities with `new_*` local ids are creations; current
 * entities absent from the desired design are deletions.
 */

export type DiffResourceKind = "category" | "channel" | "role";

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface DiffCreate {
  op: "create";
  resource: DiffResourceKind;
  /** Local id in the desired design (used to resolve parents when applying). */
  localId: string;
  name: string;
  detail: ChannelDesign | CategoryDesign | RoleDesign;
}

export interface DiffModify {
  op: "modify";
  resource: DiffResourceKind;
  id: string;
  name: string;
  changes: FieldChange[];
}

export interface DiffRename {
  op: "rename";
  resource: DiffResourceKind;
  id: string;
  before: string;
  after: string;
  /** Additional non-name changes bundled with the rename. */
  changes: FieldChange[];
}

export interface DiffMove {
  op: "move";
  resource: DiffResourceKind;
  id: string;
  name: string;
  fromParent: string | null;
  toParent: string | null;
  fromPosition: number;
  toPosition: number;
}

export interface DiffDelete {
  op: "delete";
  resource: DiffResourceKind;
  id: string;
  name: string;
}

export interface DiffUnsupported {
  op: "unsupported";
  resource: DiffResourceKind;
  id?: string;
  name: string;
  reason: string;
}

export type DiffEntry =
  | DiffCreate
  | DiffModify
  | DiffRename
  | DiffMove
  | DiffDelete
  | DiffUnsupported;

export interface ServerDiff {
  guildId: string;
  entries: DiffEntry[];
  creates: DiffCreate[];
  modifies: DiffModify[];
  renames: DiffRename[];
  moves: DiffMove[];
  deletes: DiffDelete[];
  unsupported: DiffUnsupported[];
  unchangedCount: number;
  isEmpty: boolean;
}

const CHANNEL_FIELDS = ["topic", "nsfw", "slowmode"] as const;

export function diffServerDesign(current: ServerDesign, desired: ServerDesign): ServerDiff {
  const entries: DiffEntry[] = [];
  let unchanged = 0;

  // ── Categories ──────────────────────────────────────────────
  const currentCats = new Map(current.categories.map((c) => [c.id, c]));
  const desiredCatIds = new Set<string>();

  for (const cat of desired.categories) {
    if (isLocalId(cat.id)) {
      entries.push({ op: "create", resource: "category", localId: cat.id, name: cat.name, detail: cat });
      continue;
    }
    desiredCatIds.add(cat.id);
    const cur = currentCats.get(cat.id);
    if (!cur) {
      entries.push({
        op: "unsupported",
        resource: "category",
        id: cat.id,
        name: cat.name,
        reason: "This category no longer exists on Discord. It will be skipped.",
      });
      continue;
    }
    const renamed = cur.name !== cat.name;
    const moved = cur.position !== cat.position;
    if (renamed) {
      entries.push({ op: "rename", resource: "category", id: cat.id, before: cur.name, after: cat.name, changes: [] });
    }
    if (moved) {
      entries.push({
        op: "move", resource: "category", id: cat.id, name: cat.name,
        fromParent: null, toParent: null, fromPosition: cur.position, toPosition: cat.position,
      });
    }
    if (!renamed && !moved) unchanged++;
  }
  for (const cur of current.categories) {
    if (!desiredCatIds.has(cur.id) && !desired.categories.some((c) => c.id === cur.id)) {
      entries.push({ op: "delete", resource: "category", id: cur.id, name: cur.name });
    }
  }

  // ── Channels ────────────────────────────────────────────────
  const currentChannels = new Map(current.channels.map((c) => [c.id, c]));
  const desiredChannelIds = new Set<string>();

  for (const ch of desired.channels) {
    if (isLocalId(ch.id)) {
      entries.push({ op: "create", resource: "channel", localId: ch.id, name: ch.name, detail: ch });
      continue;
    }
    desiredChannelIds.add(ch.id);
    const cur = currentChannels.get(ch.id);
    if (!cur) {
      entries.push({
        op: "unsupported",
        resource: "channel",
        id: ch.id,
        name: ch.name,
        reason: "This channel no longer exists on Discord. It will be skipped.",
      });
      continue;
    }
    if (cur.type !== ch.type) {
      entries.push({
        op: "unsupported",
        resource: "channel",
        id: ch.id,
        name: ch.name,
        reason: `Discord does not support converting a ${cur.type} channel into a ${ch.type} channel. Create a new channel instead.`,
      });
      continue;
    }

    const changes: FieldChange[] = [];
    for (const field of CHANNEL_FIELDS) {
      const before = normalizeField(cur[field]);
      const after = normalizeField(ch[field]);
      if (before !== after) changes.push({ field, before: cur[field], after: ch[field] });
    }
    const renamed = cur.name !== ch.name;
    const moved = (cur.parentId ?? null) !== (ch.parentId ?? null) || cur.position !== ch.position;

    if (renamed) {
      entries.push({ op: "rename", resource: "channel", id: ch.id, before: cur.name, after: ch.name, changes });
    } else if (changes.length > 0) {
      entries.push({ op: "modify", resource: "channel", id: ch.id, name: ch.name, changes });
    }
    if (moved) {
      entries.push({
        op: "move", resource: "channel", id: ch.id, name: ch.name,
        fromParent: cur.parentId ?? null, toParent: ch.parentId ?? null,
        fromPosition: cur.position, toPosition: ch.position,
      });
    }
    if (!renamed && !moved && changes.length === 0) unchanged++;
  }
  for (const cur of current.channels) {
    if (!desiredChannelIds.has(cur.id)) {
      entries.push({ op: "delete", resource: "channel", id: cur.id, name: cur.name });
    }
  }

  // ── Roles ──────────────────────────────────────────────────
  // Roles go after channels: position sync happens at the end, and a
  // role diff is small enough that reordering is cheap.
  const roleDiff = diffRoles(current, desired);
  entries.push(...roleDiff.entries);
  unchanged += roleDiff.unchangedCount;

  const creates = entries.filter((e): e is DiffCreate => e.op === "create");
  const modifies = entries.filter((e): e is DiffModify => e.op === "modify");
  const renames = entries.filter((e): e is DiffRename => e.op === "rename");
  const moves = entries.filter((e): e is DiffMove => e.op === "move");
  const deletes = entries.filter((e): e is DiffDelete => e.op === "delete");
  const unsupported = entries.filter((e): e is DiffUnsupported => e.op === "unsupported");

  return {
    guildId: desired.guildId,
    entries,
    creates,
    modifies,
    renames,
    moves,
    deletes,
    unsupported,
    unchangedCount: unchanged,
    isEmpty: creates.length + modifies.length + renames.length + moves.length + deletes.length === 0,
  };
}

/**
 * Role diff. Same op vocabulary as channels/categories, but:
 *   - "managed" roles (bots, integrations) are surfaced as `unsupported`
 *     and never edited; Discord does not allow it.
 *   - "create" uses the same `new_*` local-id pattern as categories.
 *   - "modify" tracks color, hoist, mentionable, and permissions.
 *   - "move" is just a position change (no parent — roles are flat).
 *   - position always goes 0 (top) → N (bottom); we don't drag-reorder
 *     roles in the UI in this iteration, so the only "move" is when
 *     the user changes a role's position by editing it.
 */
export function diffRoles(
  current: ServerDesign,
  desired: ServerDesign,
): { entries: DiffEntry[]; unchangedCount: number } {
  const entries: DiffEntry[] = [];
  let unchanged = 0;
  const currentById = new Map(current.roles.map((r) => [r.id, r]));
  const desiredIds = new Set<string>();

  for (const role of desired.roles) {
    if (isLocalId(role.id)) {
      entries.push({
        op: "create",
        resource: "role",
        localId: role.id,
        name: role.name,
        detail: role,
      });
      continue;
    }
    desiredIds.add(role.id);
    const cur = currentById.get(role.id);
    if (!cur) {
      entries.push({
        op: "unsupported",
        resource: "role",
        id: role.id,
        name: role.name,
        reason: "This role no longer exists on Discord. It will be skipped.",
      });
      continue;
    }
    if (cur.managed || role.managed) {
      // Managed roles (bot/integration) cannot be edited by Monarch.
      // If the user pasted a managed-role design in via template, we
      // surface it as unsupported rather than failing the apply.
      if (cur.name !== role.name) {
        entries.push({
          op: "unsupported",
          resource: "role",
          id: role.id,
          name: role.name,
          reason: "This role is managed by a bot or integration and cannot be renamed.",
        });
      } else {
        unchanged++;
      }
      continue;
    }
    const changes = roleFieldChanges(cur, role);
    const renamed = cur.name !== role.name;
    const moved = cur.position !== role.position;
    if (renamed) {
      entries.push({
        op: "rename",
        resource: "role",
        id: role.id,
        before: cur.name,
        after: role.name,
        changes,
      });
    } else if (changes.length > 0) {
      entries.push({
        op: "modify",
        resource: "role",
        id: role.id,
        name: role.name,
        changes,
      });
    }
    if (moved) {
      entries.push({
        op: "move",
        resource: "role",
        id: role.id,
        name: role.name,
        fromParent: null,
        toParent: null,
        fromPosition: cur.position,
        toPosition: role.position,
      });
    }
    if (!renamed && !moved && changes.length === 0) unchanged++;
  }
  for (const cur of current.roles) {
    if (!desiredIds.has(cur.id) && !desired.roles.some((r) => r.id === cur.id)) {
      if (cur.managed) {
        // managed roles are not editable and we don't propose deleting them
        continue;
      }
      entries.push({ op: "delete", resource: "role", id: cur.id, name: cur.name });
    }
  }
  return { entries, unchangedCount: unchanged };
}

const ROLE_FIELDS = ["color", "hoist", "mentionable", "permissions"] as const;

function roleFieldChanges(before: RoleDesign, after: RoleDesign): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of ROLE_FIELDS) {
    const a = (before as Record<string, unknown>)[field];
    const b = (after as Record<string, unknown>)[field];
    if (normalizeField(a) !== normalizeField(b)) {
      changes.push({ field, before: a, after: b });
    }
  }
  return changes;
}

function normalizeField(v: unknown): unknown {
  if (v === undefined || v === null || v === "") return null;
  return v;
}
