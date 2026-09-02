import { z } from "zod";
import { ServerDesignSchema } from "./server-design.js";

/**
 * Portable, versioned Monarch template format.
 *
 * Templates must NOT depend on raw Discord snowflakes: exported designs are
 * stripped of live ids (see @monarch/design-engine `detachDesign`) so they
 * can be applied to any server.
 */
export const TEMPLATE_FORMAT = "monarch-template";

export const TemplateEnvelopeSchema = z.object({
  format: z.literal(TEMPLATE_FORMAT),
  version: z.number().int().min(1),
  type: z.enum(["server"]),
  name: z.string().optional(),
  data: z.unknown(),
});
export type TemplateEnvelope = z.infer<typeof TemplateEnvelopeSchema>;

export const ServerTemplateSchema = TemplateEnvelopeSchema.extend({
  type: z.literal("server"),
  data: ServerDesignSchema.omit({ guildId: true }).extend({
    guildId: z.string().optional(),
  }),
});
export type ServerTemplate = z.infer<typeof ServerTemplateSchema>;

export function parseServerTemplate(json: unknown):
  | { ok: true; template: ServerTemplate }
  | { ok: false; error: string } {
  const envelope = TemplateEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    return { ok: false, error: "This file is not a Monarch template." };
  }
  if (envelope.data.version > 1) {
    return {
      ok: false,
      error: `Template version ${envelope.data.version} is newer than this Monarch supports.`,
    };
  }
  const parsed = ServerTemplateSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: "The template data is invalid or corrupted." };
  }
  return { ok: true, template: parsed.data };
}
