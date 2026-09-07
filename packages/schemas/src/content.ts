import { z } from "zod";

/**
 * Monarch content models: embeds and full messages.
 *
 * These are the internal representations used by the Embed Builder and the
 * Message Designer. Like ServerDesign, they are NOT raw Discord JSON: the
 * conversion to Discord API payloads happens exclusively in
 * @monarch/renderer. Design-time values use Monarch's {variable} syntax
 * ({user}, {server}, {member_count}, …) and are resolved only at send time.
 */

export const CONTENT_SCHEMA_VERSION = 1;

/** Hex color Discord-compatible (#rrggbb). */
export const EmbedColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const EmbedAuthorSchema = z.object({
  name: z.string().min(1).max(256),
  url: z.string().url().optional(),
  iconUrl: z.string().url().optional(),
});
export type EmbedAuthor = z.infer<typeof EmbedAuthorSchema>;

export const EmbedFooterSchema = z.object({
  text: z.string().min(1).max(2048),
  iconUrl: z.string().url().optional(),
});
export type EmbedFooter = z.infer<typeof EmbedFooterSchema>;

export const EmbedFieldSchema = z.object({
  name: z.string().min(1).max(256),
  value: z.string().min(1).max(1024),
  inline: z.boolean().default(false),
});
export type EmbedField = z.infer<typeof EmbedFieldSchema>;

/**
 * An embed design. All rich fields are optional — Discord requires at least
 * one populated (validation enforces that with a human-readable rule).
 */
export const EmbedDesignSchema = z.object({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  url: z.string().url().optional(),
  color: EmbedColorSchema.optional(),
  author: EmbedAuthorSchema.optional(),
  footer: EmbedFooterSchema.optional(),
  /** Image shown below the embed body (large). */
  imageUrl: z.string().url().optional(),
  /** Small image in the top-right corner. */
  thumbnailUrl: z.string().url().optional(),
  /** "now" is stamped with the current time at send; otherwise a fixed ISO datetime. */
  timestamp: z.union([z.string().datetime(), z.literal("now")]).optional(),
  fields: z.array(EmbedFieldSchema).max(25).default([]),
});
export type EmbedDesign = z.infer<typeof EmbedDesignSchema>;

/**
 * Buttons Monarch can create today. Only link buttons carry a URL; other
 * styles require component interaction handlers, which arrive with a later
 * feature (validation rejects them so we never claim what we can't do).
 */
export const MessageButtonStyle = z.enum(["primary", "secondary", "success", "danger", "link"]);
export type MessageButtonStyle = z.infer<typeof MessageButtonStyle>;

export const MessageButtonSchema = z.object({
  /** Local design-time id (never sent to Discord). */
  id: z.string(),
  label: z.string().min(1).max(80),
  style: MessageButtonStyle,
  url: z.string().url().optional(),
  disabled: z.boolean().default(false),
});
export type MessageButton = z.infer<typeof MessageButtonSchema>;

/** A full message: plain content + up to 10 embeds + up to 25 buttons. */
export const MessageDesignSchema = z.object({
  content: z.string().max(2000).default(""),
  embeds: z.array(EmbedDesignSchema).max(10).default([]),
  buttons: z.array(MessageButtonSchema).max(25).default([]),
  metadata: z
    .object({
      schemaVersion: z.number().int().default(CONTENT_SCHEMA_VERSION),
      updatedAt: z.string().optional(),
    })
    .optional(),
});
export type MessageDesign = z.infer<typeof MessageDesignSchema>;

/** Per-guild workspace of saved content designs (autosaved by the editors). */
export const GuildWorkspaceSchema = z.object({
  guildId: z.string(),
  embed: EmbedDesignSchema.nullable().default(null),
  message: MessageDesignSchema.nullable().default(null),
});
export type GuildWorkspace = z.infer<typeof GuildWorkspaceSchema>;

export function emptyEmbedDesign(): EmbedDesign {
  return EmbedDesignSchema.parse({ fields: [] });
}

export function emptyMessageDesign(): MessageDesign {
  return MessageDesignSchema.parse({
    content: "",
    embeds: [],
    buttons: [],
    metadata: { schemaVersion: CONTENT_SCHEMA_VERSION },
  });
}
