import { z } from "zod";

/**
 * Monarch's internal server design model.
 *
 * This — not raw Discord JSON — is the application's primary representation.
 * Conversion to Discord API payloads happens exclusively in
 * @monarch/renderer, and conversion from live Discord state happens in
 * @monarch/discord. Everything in between (editor, drafts, validation,
 * diffing, templates, snapshots) speaks this schema.
 */

export const DESIGN_SCHEMA_VERSION = 1;

/** Channel kinds Monarch can design. Maps to Discord types in the renderer. */
export const ChannelKind = z.enum(["text", "voice", "announcement", "forum", "stage"]);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const CategoryDesignSchema = z.object({
  /** Discord snowflake for existing categories, `new_*` local id otherwise. */
  id: z.string(),
  name: z.string(),
  position: z.number().int().min(0),
});
export type CategoryDesign = z.infer<typeof CategoryDesignSchema>;

export const ChannelDesignSchema = z.object({
  /** Discord snowflake for existing channels, `new_*` local id otherwise. */
  id: z.string(),
  name: z.string(),
  type: ChannelKind,
  topic: z.string().optional(),
  /** Position among siblings within the same parent (or at root). */
  position: z.number().int().min(0),
  /** Category id (snowflake or local id). Undefined = top level. */
  parentId: z.string().optional(),
  nsfw: z.boolean().optional(),
  /** Slowmode in seconds. */
  slowmode: z.number().int().min(0).max(21600).optional(),
});
export type ChannelDesign = z.infer<typeof ChannelDesignSchema>;

export const RoleDesignSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  position: z.number().int().min(0),
  /** Discord permission bitfield as a decimal string. */
  permissions: z.string().optional(),
  managed: z.boolean().optional(),
});
export type RoleDesign = z.infer<typeof RoleDesignSchema>;

export const BrandingSchema = z.object({
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  accentColor: z.string().optional(),
  rolePalette: z.array(z.string()).optional(),
});
export type Branding = z.infer<typeof BrandingSchema>;

/** Globally designated channels (Target Resolver defaults). */
export const DesignatedChannelsSchema = z.object({
  welcome: z.string().optional(),
  announcements: z.string().optional(),
  testing: z.string().optional(),
  templateTesting: z.string().optional(),
});
export type DesignatedChannels = z.infer<typeof DesignatedChannelsSchema>;

export const ServerDesignSchema = z.object({
  guildId: z.string(),
  name: z.string(),
  categories: z.array(CategoryDesignSchema),
  channels: z.array(ChannelDesignSchema),
  roles: z.array(RoleDesignSchema),
  branding: BrandingSchema.default({}),
  designatedChannels: DesignatedChannelsSchema.default({}),
  metadata: z
    .object({
      schemaVersion: z.number().int().default(DESIGN_SCHEMA_VERSION),
      updatedAt: z.string().optional(),
    })
    .default({ schemaVersion: DESIGN_SCHEMA_VERSION }),
});
export type ServerDesign = z.infer<typeof ServerDesignSchema>;

export function emptyServerDesign(guildId: string, name: string): ServerDesign {
  return ServerDesignSchema.parse({
    guildId,
    name,
    categories: [],
    channels: [],
    roles: [],
  });
}
