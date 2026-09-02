import { z } from "zod";

/**
 * Target Resolver types.
 *
 * Every feature that publishes content resolves WHERE through a target:
 * either a globally designated channel role (welcome/announcements/testing)
 * or an explicit per-feature override. Resolution + permission checks live
 * in @monarch/discord (resolveTarget).
 */

export const DesignatedChannelKey = z.enum([
  "welcome",
  "announcements",
  "testing",
  "templateTesting",
]);
export type DesignatedChannelKey = z.infer<typeof DesignatedChannelKey>;

export const TargetConfigSchema = z.discriminatedUnion("kind", [
  /** Use one of the guild's globally designated channels. */
  z.object({ kind: z.literal("designated"), key: DesignatedChannelKey }),
  /** Explicit channel (and optionally thread) override. */
  z.object({
    kind: z.literal("explicit"),
    guildId: z.string(),
    channelId: z.string(),
    threadId: z.string().optional(),
  }),
]);
export type TargetConfig = z.infer<typeof TargetConfigSchema>;

export interface ResolvedTarget {
  guildId: string;
  channelId: string;
  threadId?: string;
  channelName: string;
}
