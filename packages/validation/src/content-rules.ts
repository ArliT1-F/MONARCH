import type { EmbedDesign, MessageDesign, MessageButton } from "@monarch/schemas";
import { DiscordLimits } from "./limits.js";
import { runRules, type Rule, type ValidationIssue, type ValidationReport } from "./engine.js";

/**
 * Content validation rules for the Embed Builder and Message Designer.
 *
 * Same philosophy as server rules: human-readable messages, actionable
 * fixes, and Discord limits from DiscordLimits — never inline. Errors block
 * test-send and publish; warnings are surfaced only.
 */

function totalEmbedLength(embed: EmbedDesign): number {
  let total = 0;
  total += embed.title?.length ?? 0;
  total += embed.description?.length ?? 0;
  total += embed.author?.name.length ?? 0;
  total += embed.footer?.text.length ?? 0;
  for (const f of embed.fields) total += f.name.length + f.value.length;
  return total;
}

/** An embed must populate at least one content-bearing field. */
const embedHasContent: Rule<EmbedDesign> = (embed) => {
  const hasSomething =
    !!embed.title?.trim() ||
    !!embed.description?.trim() ||
    !!embed.author?.name.trim() ||
    !!embed.footer?.text.trim() ||
    embed.fields.length > 0 ||
    !!embed.imageUrl ||
    !!embed.thumbnailUrl;
  if (hasSomething) return [];
  return [
    {
      severity: "error",
      code: "embed.empty",
      message: "This embed is empty.",
      fix: "Add a title, description, footer, field or image — Discord requires at least one.",
      target: { kind: "embed" },
    },
  ];
};

const embedTotalLength: Rule<EmbedDesign> = (embed) => {
  const total = totalEmbedLength(embed);
  if (total <= DiscordLimits.embed.totalMax) return [];
  return [
    {
      severity: "error",
      code: "embed.total-length",
      message: `This embed totals ${total} characters; Discord allows at most ${DiscordLimits.embed.totalMax}.`,
      fix: "Trim the description or shorten field values.",
      target: { kind: "embed" },
    },
  ];
};

const embedFieldCount: Rule<EmbedDesign> = (embed) => {
  if (embed.fields.length <= DiscordLimits.embed.fieldsMax) return [];
  return [
    {
      severity: "error",
      code: "embed.fields-count",
      message: `This embed has ${embed.fields.length} fields; Discord allows at most ${DiscordLimits.embed.fieldsMax}.`,
      fix: "Remove the extra fields or split them across another embed.",
      target: { kind: "embed" },
    },
  ];
};

const messageEmbedCount: Rule<MessageDesign> = (message) => {
  if (message.embeds.length <= DiscordLimits.embed.perMessageMax) return [];
  return [
    {
      severity: "error",
      code: "message.embeds-count",
      message: `This message has ${message.embeds.length} embeds; Discord allows at most ${DiscordLimits.embed.perMessageMax}.`,
      fix: "Split the embeds across multiple messages.",
      target: { kind: "message" },
    },
  ];
};

const messageContentLength: Rule<MessageDesign> = (message) => {
  const len = message.content.length;
  if (len <= DiscordLimits.message.contentMax) return [];
  return [
    {
      severity: "error",
      code: "message.content-length",
      message: `The message content is ${len} characters; Discord allows at most ${DiscordLimits.message.contentMax}.`,
      fix: "Shorten the content or move text into an embed (embeds have their own limits).",
      target: { kind: "message" },
    },
  ];
};

const messageMustHaveAnything: Rule<MessageDesign> = (message) => {
  const hasSomething =
    !!message.content.trim() || message.embeds.length > 0 || message.buttons.length > 0;
  if (hasSomething) return [];
  return [
    {
      severity: "error",
      code: "message.empty",
      message: "This message is empty.",
      fix: "Add content, an embed or a button.",
      target: { kind: "message" },
    },
  ];
};

function buttonIssues(button: MessageButton): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (button.style === "link" && !button.url) {
    issues.push({
      severity: "error",
      code: "button.link-missing-url",
      message: `The "${button.label}" link button has no URL.`,
      fix: "Add a URL — link buttons open it when clicked.",
      target: { kind: "button", name: button.label },
    });
  }
  if (button.style !== "link" && button.url) {
    issues.push({
      severity: "warning",
      code: "button.url-on-interaction",
      message: `The "${button.label}" button has a URL but isn't a link button — Discord ignores it.`,
      fix: "Switch the style to Link, or remove the URL.",
      target: { kind: "button", name: button.label },
    });
  }
  return issues;
}

const messageButtons: Rule<MessageDesign> = (message) => {
  const issues: ValidationIssue[] = [];
  const maxButtons = DiscordLimits.message.actionRowsMax * DiscordLimits.message.buttonsPerRowMax;
  if (message.buttons.length > maxButtons) {
    issues.push({
      severity: "error",
      code: "message.buttons-count",
      message: `This message has ${message.buttons.length} buttons; Discord allows at most ${maxButtons} (5 rows × 5).`,
      fix: "Remove the extra buttons.",
      target: { kind: "message" },
    });
  }
  for (const b of message.buttons) issues.push(...buttonIssues(b));
  return issues;
};

export function validateEmbedDesign(embed: EmbedDesign): ValidationReport {
  return runRules(embed, [embedHasContent, embedTotalLength, embedFieldCount]);
}

export function validateMessageDesign(message: MessageDesign): ValidationReport {
  return runRules(message, [
    messageMustHaveAnything,
    messageContentLength,
    messageEmbedCount,
    messageButtons,
  ]);
}
