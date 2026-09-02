import { ChannelType } from "discord-api-types/v10";
import type { ChannelDesign, ChannelKind, CategoryDesign } from "@monarch/schemas";

/**
 * Discord renderer: the ONLY place where Monarch's internal design model is
 * converted into Discord API v10 payloads (and back for channel kinds).
 * Nothing outside @monarch/renderer and @monarch/discord may build raw
 * Discord payloads.
 */

const KIND_TO_TYPE: Record<ChannelKind, ChannelType> = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
};

const TYPE_TO_KIND = new Map<ChannelType, ChannelKind>(
  (Object.entries(KIND_TO_TYPE) as [ChannelKind, ChannelType][]).map(([k, t]) => [t, k]),
);

export function channelKindToDiscordType(kind: ChannelKind): ChannelType {
  return KIND_TO_TYPE[kind];
}

/** Returns undefined for channel types Monarch doesn't design (threads, DMs…). */
export function discordTypeToChannelKind(type: ChannelType): ChannelKind | undefined {
  return TYPE_TO_KIND.get(type);
}

export interface CreateChannelPayload {
  name: string;
  type: ChannelType;
  topic?: string;
  parent_id?: string;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  position?: number;
}

export function renderCreateChannel(
  design: ChannelDesign,
  resolvedParentId?: string,
): CreateChannelPayload {
  const payload: CreateChannelPayload = {
    name: design.name,
    type: KIND_TO_TYPE[design.type],
    position: design.position,
  };
  if (resolvedParentId) payload.parent_id = resolvedParentId;
  if (design.topic && supportsTopic(design.type)) payload.topic = design.topic;
  if (design.nsfw !== undefined) payload.nsfw = design.nsfw;
  if (design.slowmode !== undefined && design.slowmode > 0) {
    payload.rate_limit_per_user = design.slowmode;
  }
  return payload;
}

export function renderCreateCategory(design: CategoryDesign): CreateChannelPayload {
  return { name: design.name, type: ChannelType.GuildCategory, position: design.position };
}

export interface ModifyChannelPayload {
  name?: string;
  topic?: string | null;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  parent_id?: string | null;
  position?: number;
}

export function renderModifyChannel(
  changes: { field: string; after: unknown }[],
  rename?: { after: string },
): ModifyChannelPayload {
  const payload: ModifyChannelPayload = {};
  if (rename) payload.name = rename.after;
  for (const c of changes) {
    switch (c.field) {
      case "topic":
        payload.topic = (c.after as string | undefined) ?? null;
        break;
      case "nsfw":
        payload.nsfw = Boolean(c.after);
        break;
      case "slowmode":
        payload.rate_limit_per_user = (c.after as number | undefined) ?? 0;
        break;
    }
  }
  return payload;
}

export function supportsTopic(kind: ChannelKind): boolean {
  return kind === "text" || kind === "announcement" || kind === "forum";
}
