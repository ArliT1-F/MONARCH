import type { ServerDesign } from "@monarch/schemas";
import type {
  AnalyzerCategoryScore,
  AnalyzerCheckResult,
  AnalyzerOptions,
  AnalyzerReport,
  AnalyzerStats,
} from "./types.js";
import { ANALYZER_CATEGORIES, capAffected, round2 } from "./types.js";
import { CHECKS } from "./checks.js";

/**
 * Run every analyzer check against a design and aggregate the scores.
 *
 * Pure and deterministic: no clock-dependent math (the timestamp is the
 * report's "computed at" label, not a scoring input), no randomness, no
 * I/O, no Discord calls. Dismissed checks ("marked as intentional") stay
 * in the report for transparency but are excluded from all averages.
 */
export function analyzeServerDesign(
  design: ServerDesign,
  opts: AnalyzerOptions = {},
): AnalyzerReport {
  const dismissed = new Set(opts.dismissed ?? []);

  const results: AnalyzerCheckResult[] = CHECKS.map((check) => {
    const { score, suggestion } = check.apply(design);
    const clamped = Math.min(1, Math.max(0, round2(score)));
    const result: AnalyzerCheckResult = {
      id: check.id,
      label: check.label,
      category: check.category,
      score: clamped,
      pass: clamped >= 1,
      suggestion,
    };
    if (dismissed.has(check.id)) result.dismissed = true;
    return result;
  });

  const categories: AnalyzerCategoryScore[] = ANALYZER_CATEGORIES.map((cat) => {
    const checks = results.filter((r) => r.category === cat.id);
    const scored = checks.filter((r) => !r.dismissed);
    let score = 100;
    if (scored.length > 0) {
      const weightOf = (id: string) =>
        CHECKS.find((c) => c.id === id)?.weight ?? 1;
      const totalWeight = scored.reduce((sum, r) => sum + weightOf(r.id), 0);
      score =
        totalWeight === 0
          ? 100
          : Math.round((scored.reduce((sum, r) => sum + r.score * weightOf(r.id), 0) / totalWeight) * 100);
    }
    return { id: cat.id, label: cat.label, score, checks };
  });

  const overall = Math.round(
    ANALYZER_CATEGORIES.reduce((sum, cat) => {
      const category = categories.find((x) => x.id === cat.id);
      return sum + (category?.score ?? 0) * cat.weight;
    }, 0),
  );

  const textLike = design.channels.filter(isTextLike);
  const stats: AnalyzerStats = {
    categories: design.categories.length,
    channels: design.channels.length,
    textChannels: textLike.length,
    voiceChannels: design.channels.length - textLike.length,
    topicsSet: textLike.filter((c) => (c.topic ?? "").trim().length > 0).length,
    roles: design.roles.length,
    coloredRoles: design.roles.filter(
      (r) => !!r.color && !r.managed && r.id !== design.guildId,
    ).length,
    uncategorizedChannels: design.channels.filter((c) => !c.parentId).length,
  };

  return {
    overall,
    categories,
    dismissedCount: results.filter((r) => r.dismissed).length,
    stats,
    checkedAt: new Date().toISOString(),
  };
}

function isTextLike(c: { type: string }): boolean {
  return c.type === "text" || c.type === "announcement" || c.type === "forum";
}

export { ANALYZER_CATEGORIES, capAffected };
export type {
  AnalyzerCategoryScore,
  AnalyzerCheckResult,
  AnalyzerOptions,
  AnalyzerReport,
  AnalyzerStats,
};
