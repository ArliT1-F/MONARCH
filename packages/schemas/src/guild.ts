import { z } from "zod";

/**
 * Guild summary shown on the server-selection screen and kept in the
 * server context. Combines the user's OAuth guild data with Monarch's
 * own knowledge (is the bot installed, what can it do).
 */
export const GuildSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  iconUrl: z.string().nullable(),
  memberCount: z.number().int().nullable(),
  /** Is the Monarch bot present in this guild? */
  botInstalled: z.boolean(),
  /** Does the signed-in user have Manage Server / Administrator? */
  userCanDesign: z.boolean(),
  /** Bot permission bitfield (decimal string), null when not installed. */
  botPermissions: z.string().nullable(),
});
export type GuildSummary = z.infer<typeof GuildSummarySchema>;

export interface GuildChannelInfo {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
}

export interface GuildRoleInfo {
  id: string;
  name: string;
  color: string | null;
  position: number;
  managed: boolean;
}
