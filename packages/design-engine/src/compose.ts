import type { CategoryDesign, ChannelDesign, ServerDesign } from "@monarch/schemas";
import { createLocalId, isLocalId } from "@monarch/shared";

/**
 * Design composition helpers shared by restore, import and templates.
 *
 * The diff engine (`diffServerDesign`) matches by id: a snowflake that no
 * longer exists on Discord is reported as `unsupported` and skipped. That
 * is the safe default for a hand-edited draft, but it is the wrong outcome
 * for a *restore* — if someone deleted #rules, restoring last week's backup
 * must bring #rules back.
 *
 * `rebaseDesign` makes a desired design applicable on top of the live one:
 *   1. ids that still exist on Discord are kept (plain modify/rename/move);
 *   2. anything else is matched to a live entity of the same kind and name
 *      when possible ("adopted") — deleting and recreating a channel would
 *      wipe its message history, so a same-named live channel is reused;
 *   3. what is left becomes a fresh local id, i.e. a creation, with parent
 *      links rewritten so channels inside a recreated category follow it.
 */
export interface RebaseResult {
  design: ServerDesign;
  /** Entities that no longer exist on Discord and will be recreated on apply. */
  recreated: number;
  /** Entities matched to a live same-named entity instead of being recreated. */
  adopted: number;
}

export function rebaseDesign(current: ServerDesign, desired: ServerDesign): RebaseResult {
  const liveCategories = new Map(current.categories.map((c) => [c.id, c]));
  const liveChannels = new Map(current.channels.map((c) => [c.id, c]));
  const idMap = new Map<string, string>();
  let recreated = 0;
  let adopted = 0;

  // ── categories ───────────────────────────────────────────────
  const claimedCategories = new Set(desired.categories.map((c) => c.id).filter((id) => liveCategories.has(id)));
  for (const cat of desired.categories) {
    if (liveCategories.has(cat.id)) continue;
    const match = current.categories.find(
      (live) => !claimedCategories.has(live.id) && sameName(live.name, cat.name),
    );
    if (match) {
      idMap.set(cat.id, match.id);
      claimedCategories.add(match.id);
      adopted++;
    } else {
      idMap.set(cat.id, createLocalId());
      if (!isLocalId(cat.id)) recreated++;
    }
  }
  const categoryId = (id: string) => idMap.get(id) ?? id;

  // ── channels ─────────────────────────────────────────────────
  const claimedChannels = new Set(desired.channels.map((c) => c.id).filter((id) => liveChannels.has(id)));
  const candidates = (ch: ChannelDesign, parentId: string | undefined) =>
    current.channels.filter(
      (live) =>
        !claimedChannels.has(live.id) && live.type === ch.type && sameChannelName(live.name, ch.name, ch) &&
        (parentId === undefined ? true : (live.parentId ?? null) === parentId),
    );
  for (const ch of desired.channels) {
    if (liveChannels.has(ch.id)) continue;
    const wantedParent = ch.parentId ? categoryId(ch.parentId) : null;
    // Prefer a match in the same category, then anywhere in the server.
    const match = candidates(ch, wantedParent ?? undefined)[0] ?? candidates(ch, undefined)[0];
    if (match) {
      idMap.set(ch.id, match.id);
      claimedChannels.add(match.id);
      adopted++;
    } else {
      idMap.set(ch.id, createLocalId());
      if (!isLocalId(ch.id)) recreated++;
    }
  }
  const channelId = (id: string) => idMap.get(id) ?? id;

  return {
    design: {
      ...desired,
      guildId: current.guildId,
      name: current.name,
      categories: desired.categories.map((c) => ({ ...c, id: categoryId(c.id) })),
      channels: desired.channels.map((ch) => ({
        ...ch,
        id: channelId(ch.id),
        parentId: ch.parentId ? categoryId(ch.parentId) : undefined,
      })),
      // Roles are not diffed/applied yet and designated channels are guild
      // settings, not structure — always carry the live values.
      roles: current.roles,
      designatedChannels: current.designatedChannels,
    },
    recreated,
    adopted,
  };
}

/**
 * Append an incoming (detached) design underneath the current structure
 * instead of replacing it: existing categories/channels are kept untouched,
 * incoming ones are added after them. Used by template import in "add" mode.
 */
export function mergeDesigns(current: ServerDesign, incoming: ServerDesign): ServerDesign {
  const categoryOffset = current.categories.length;
  const rootOffset = current.channels.filter((c) => !c.parentId).length;
  const incomingCategoryIds = new Set(incoming.categories.map((c) => c.id));

  return {
    ...current,
    categories: [
      ...current.categories,
      ...incoming.categories.map((c) => ({ ...c, id: localised(c.id), position: c.position + categoryOffset })),
    ],
    channels: [
      ...current.channels,
      ...incoming.channels.map((ch) => {
        const parentId = ch.parentId && incomingCategoryIds.has(ch.parentId) ? localised(ch.parentId) : undefined;
        return {
          ...ch,
          id: localised(ch.id),
          parentId,
          position: parentId ? ch.position : ch.position + rootOffset,
        };
      }),
    ],
  };
}

/**
 * Templates are supposed to be detached, but a hand-edited file could still
 * carry snowflakes from the server it came from. Anything that is not a
 * local id becomes one so imports can never "modify" an unrelated live
 * channel that happens to share an id.
 */
export function localiseIds(design: ServerDesign): ServerDesign {
  return {
    ...design,
    categories: design.categories.map((c: CategoryDesign) => ({ ...c, id: localised(c.id) })),
    channels: design.channels.map((ch) => ({
      ...ch,
      id: localised(ch.id),
      parentId: ch.parentId ? localised(ch.parentId) : undefined,
    })),
  };
}

function localised(id: string): string {
  return isLocalId(id) ? id : `new_import_${id}`;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Discord lowercases/dashes text-like channel names; compare the way it stores them. */
function sameChannelName(a: string, b: string, ch: ChannelDesign): boolean {
  const textLike = ch.type === "text" || ch.type === "announcement" || ch.type === "forum";
  const norm = (s: string) => (textLike ? s.trim().toLowerCase().replace(/\s+/g, "-") : s.trim().toLowerCase());
  return norm(a) === norm(b);
}
