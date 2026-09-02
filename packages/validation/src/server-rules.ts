import type { ServerDesign, ChannelDesign } from "@monarch/schemas";
import { DiscordLimits } from "./limits.js";
import { runRules, type Rule, type ValidationIssue, type ValidationReport } from "./engine.js";

/**
 * Server-structure validation rules used by the Server Designer before any
 * diff is applied. Also referenced by templates/import to sanity-check
 * incoming designs.
 */

/** Discord normalizes text-like channel names: lowercase, dashes, no spaces. */
export function normalizeTextChannelName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/[^a-z0-9_\-\p{L}\p{N}]/gu, "");
}

const isTextLike = (c: ChannelDesign) =>
  c.type === "text" || c.type === "announcement" || c.type === "forum";

const channelNames: Rule<ServerDesign> = (design) => {
  const issues: ValidationIssue[] = [];
  for (const ch of design.channels) {
    const name = ch.name.trim();
    if (name.length < DiscordLimits.channel.nameMin || name.length > DiscordLimits.channel.nameMax) {
      issues.push({
        severity: "error",
        code: "channel.name.length",
        message: `Channel name "${truncate(ch.name)}" must be between ${DiscordLimits.channel.nameMin} and ${DiscordLimits.channel.nameMax} characters.`,
        fix: "Shorten or fill in the channel name.",
        target: { kind: "channel", id: ch.id, name: ch.name },
      });
      continue;
    }
    if (isTextLike(ch)) {
      const normalized = normalizeTextChannelName(name);
      if (normalized.length === 0) {
        issues.push({
          severity: "error",
          code: "channel.name.invalid",
          message: `Channel name "${truncate(ch.name)}" contains no valid characters for a ${ch.type} channel.`,
          fix: "Use letters, numbers and dashes.",
          target: { kind: "channel", id: ch.id, name: ch.name },
        });
      } else if (normalized !== name) {
        issues.push({
          severity: "warning",
          code: "channel.name.normalized",
          message: `Discord will store "${truncate(ch.name)}" as "${normalized}".`,
          fix: `Rename it to "${normalized}" to match what Discord will show.`,
          target: { kind: "channel", id: ch.id, name: ch.name },
        });
      }
    }
  }
  return issues;
};

const channelTopics: Rule<ServerDesign> = (design) => {
  const issues: ValidationIssue[] = [];
  for (const ch of design.channels) {
    if (!ch.topic) continue;
    const max =
      ch.type === "forum" ? DiscordLimits.channel.forumTopicMax : DiscordLimits.channel.topicMax;
    if ((ch.type === "voice" || ch.type === "stage") && ch.topic.length > 0) {
      issues.push({
        severity: "warning",
        code: "channel.topic.unsupported",
        message: `"${ch.name}" is a ${ch.type} channel — Discord does not show topics for it.`,
        target: { kind: "channel", id: ch.id, name: ch.name },
      });
    } else if (ch.topic.length > max) {
      issues.push({
        severity: "error",
        code: "channel.topic.length",
        message: `The topic of "#${ch.name}" is ${ch.topic.length} characters; Discord allows at most ${max}.`,
        fix: "Shorten the topic.",
        target: { kind: "channel", id: ch.id, name: ch.name },
      });
    }
  }
  return issues;
};

const structureLimits: Rule<ServerDesign> = (design) => {
  const issues: ValidationIssue[] = [];
  const total = design.channels.length + design.categories.length;
  if (total > DiscordLimits.guild.maxChannels) {
    issues.push({
      severity: "error",
      code: "guild.channels.max",
      message: `This design has ${total} channels/categories; Discord allows at most ${DiscordLimits.guild.maxChannels}.`,
      fix: "Remove some channels or categories.",
      target: { kind: "guild" },
    });
  }
  const perCategory = new Map<string, number>();
  for (const ch of design.channels) {
    if (!ch.parentId) continue;
    perCategory.set(ch.parentId, (perCategory.get(ch.parentId) ?? 0) + 1);
  }
  for (const [catId, count] of perCategory) {
    if (count > DiscordLimits.guild.maxChannelsPerCategory) {
      const cat = design.categories.find((c) => c.id === catId);
      issues.push({
        severity: "error",
        code: "category.channels.max",
        message: `Category "${cat?.name ?? catId}" holds ${count} channels; Discord allows at most ${DiscordLimits.guild.maxChannelsPerCategory}.`,
        fix: "Move some channels into another category.",
        target: { kind: "category", id: catId, name: cat?.name },
      });
    }
  }
  return issues;
};

const referentialIntegrity: Rule<ServerDesign> = (design) => {
  const issues: ValidationIssue[] = [];
  const categoryIds = new Set(design.categories.map((c) => c.id));
  for (const ch of design.channels) {
    if (ch.parentId && !categoryIds.has(ch.parentId)) {
      issues.push({
        severity: "error",
        code: "channel.parent.missing",
        message: `"#${ch.name}" points at a category that no longer exists in this design.`,
        fix: "Move the channel to another category or to the top level.",
        target: { kind: "channel", id: ch.id, name: ch.name },
      });
    }
  }
  for (const cat of design.categories) {
    if (cat.name.trim().length < 1 || cat.name.length > DiscordLimits.channel.nameMax) {
      issues.push({
        severity: "error",
        code: "category.name.length",
        message: `Category name "${truncate(cat.name)}" must be between 1 and ${DiscordLimits.channel.nameMax} characters.`,
        target: { kind: "category", id: cat.id, name: cat.name },
      });
    }
  }
  return issues;
};

const duplicateNames: Rule<ServerDesign> = (design) => {
  const issues: ValidationIssue[] = [];
  const seen = new Map<string, number>();
  for (const ch of design.channels) {
    const key = `${ch.parentId ?? "root"}:${isTextLike(ch) ? normalizeTextChannelName(ch.name) : ch.name.trim().toLowerCase()}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const ch of design.channels) {
    const key = `${ch.parentId ?? "root"}:${isTextLike(ch) ? normalizeTextChannelName(ch.name) : ch.name.trim().toLowerCase()}`;
    if ((seen.get(key) ?? 0) > 1) {
      issues.push({
        severity: "warning",
        code: "channel.name.duplicate",
        message: `Multiple channels named "${ch.name}" in the same place — Discord allows this but it's confusing.`,
        target: { kind: "channel", id: ch.id, name: ch.name },
      });
      seen.set(key, 0); // report once per group
    }
  }
  return issues;
};

const SERVER_RULES: Rule<ServerDesign>[] = [
  channelNames,
  channelTopics,
  structureLimits,
  referentialIntegrity,
  duplicateNames,
];

export function validateServerDesign(design: ServerDesign): ValidationReport {
  return runRules(design, SERVER_RULES);
}

function truncate(s: string, n = 40) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
