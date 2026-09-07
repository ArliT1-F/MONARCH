import {
  ButtonStyle,
  type APIButtonComponent,
  type APIEmbed,
  type APIActionRowComponent,
  type APIMessageActionRowComponent,
} from "discord-api-types/v10";
import type { EmbedDesign, MessageButton, MessageDesign } from "@monarch/schemas";
import { renderVariables, type VariableContext } from "@monarch/shared";

/**
 * Content renderer: the ONLY place Monarch's embed/message designs become
 * Discord API v10 payloads, and where design-time {variables} are resolved
 * against the real send context.
 */

// ── variable resolution ───────────────────────────────────────────────

function resolveText(text: string, ctx: VariableContext): string {
  return renderVariables(text, ctx);
}

export function applyVariablesToEmbed(embed: EmbedDesign, ctx: VariableContext): EmbedDesign {
  return {
    ...embed,
    title: embed.title ? resolveText(embed.title, ctx) : undefined,
    description: embed.description ? resolveText(embed.description, ctx) : undefined,
    author: embed.author
      ? { ...embed.author, name: resolveText(embed.author.name, ctx) }
      : undefined,
    footer: embed.footer
      ? { ...embed.footer, text: resolveText(embed.footer.text, ctx) }
      : undefined,
    fields: embed.fields.map((f) => ({
      ...f,
      name: resolveText(f.name, ctx),
      value: resolveText(f.value, ctx),
    })),
  };
}

export function applyVariablesToMessage(message: MessageDesign, ctx: VariableContext): MessageDesign {
  return {
    ...message,
    content: resolveText(message.content, ctx),
    embeds: message.embeds.map((e) => applyVariablesToEmbed(e, ctx)),
    buttons: message.buttons.map((b) => ({ ...b, label: resolveText(b.label, ctx) })),
  };
}

// ── payload rendering ─────────────────────────────────────────────────

export function renderEmbedPayload(embed: EmbedDesign): APIEmbed {
  const payload: APIEmbed = {};
  if (embed.title) payload.title = embed.title;
  if (embed.description) payload.description = embed.description;
  if (embed.url) payload.url = embed.url;
  if (embed.color) payload.color = parseInt(embed.color.slice(1), 16);
  if (embed.author) {
    payload.author = {
      name: embed.author.name,
      ...(embed.author.url ? { url: embed.author.url } : {}),
      ...(embed.author.iconUrl ? { icon_url: embed.author.iconUrl } : {}),
    };
  }
  if (embed.footer) {
    payload.footer = {
      text: embed.footer.text,
      ...(embed.footer.iconUrl ? { icon_url: embed.footer.iconUrl } : {}),
    };
  }
  if (embed.imageUrl) payload.image = { url: embed.imageUrl };
  if (embed.thumbnailUrl) payload.thumbnail = { url: embed.thumbnailUrl };
  if (embed.timestamp === "now") payload.timestamp = new Date().toISOString();
  else if (embed.timestamp) payload.timestamp = embed.timestamp;
  if (embed.fields.length > 0) {
    payload.fields = embed.fields.map((f) => ({
      name: f.name,
      value: f.value,
      ...(f.inline ? { inline: true } : {}),
    }));
  }
  return payload;
}

const BUTTON_STYLE_TO_DISCORD: Record<MessageButton["style"], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
  link: ButtonStyle.Link,
};

export function renderButtonPayload(button: MessageButton): APIButtonComponent {
  const base = {
    type: 2 as const,
    style: BUTTON_STYLE_TO_DISCORD[button.style],
    label: button.label,
    ...(button.disabled ? { disabled: true } : {}),
  };
  if (button.style === "link" && button.url) {
    return { ...base, url: button.url } as APIButtonComponent;
  }
  // Non-link buttons need a custom_id. Monarch's interaction handling arrives
  // in a later feature, so these are rejected by validation before sending.
  return { ...base, custom_id: `monarch:${button.id}` } as APIButtonComponent;
}

/** Chunk flat button lists into Discord action rows of ≤5. */
function toActionRows(buttons: MessageButton[]): APIActionRowComponent<APIMessageActionRowComponent>[] {
  const rows: APIActionRowComponent<APIMessageActionRowComponent>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({
      type: 1,
      components: buttons.slice(i, i + 5).map(renderButtonPayload),
    });
  }
  return rows;
}

export interface RenderedMessagePayload {
  content?: string;
  embeds?: APIEmbed[];
  components?: APIActionRowComponent<APIMessageActionRowComponent>[];
}

export function renderMessagePayload(message: MessageDesign): RenderedMessagePayload {
  const payload: RenderedMessagePayload = {};
  if (message.content.trim().length > 0) payload.content = message.content;
  if (message.embeds.length > 0) payload.embeds = message.embeds.map(renderEmbedPayload);
  if (message.buttons.length > 0) payload.components = toActionRows(message.buttons);
  return payload;
}
