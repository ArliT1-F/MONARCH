import type { ServerDesign } from "@monarch/schemas";
import { createLocalId } from "@monarch/shared";

/**
 * Detach a design from live Discord ids so it becomes portable
 * (templates, cloning between servers, export). All snowflakes are replaced
 * with fresh local ids while preserving parent relationships.
 */
export function detachDesign(design: ServerDesign): ServerDesign {
  const idMap = new Map<string, string>();
  const remap = (id: string) => {
    let mapped = idMap.get(id);
    if (!mapped) {
      mapped = createLocalId();
      idMap.set(id, mapped);
    }
    return mapped;
  };

  return {
    ...design,
    guildId: "",
    categories: design.categories.map((c) => ({ ...c, id: remap(c.id) })),
    channels: design.channels.map((c) => ({
      ...c,
      id: remap(c.id),
      parentId: c.parentId ? remap(c.parentId) : undefined,
    })),
    roles: design.roles.map((r) => ({ ...r, id: remap(r.id) })),
    designatedChannels: {}, // designated channels are guild-specific
  };
}
