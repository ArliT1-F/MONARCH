import type { AnalyzerReport } from "@monarch/analyzer";

export function reportToMarkdown(guildName: string, report: AnalyzerReport): string {
  const lines: string[] = [
    `# Monarch design report — ${guildName}`,
    "",
    `Overall: **${report.overall}/100**`,
    "",
    `${report.stats.categories} categories · ${report.stats.channels} channels (${report.stats.topicsSet} with topics) · ${report.stats.roles} roles (${report.stats.coloredRoles} colored)`,
    "",
    "## Scores",
    "",
    ...report.categories.map((c) => `- ${c.label}: **${c.score}%**`),
    "",
    "## Suggestions",
    "",
  ];
  for (const cat of report.categories) {
    const flagged = cat.checks.filter((c) => !c.pass || c.suggestion);
    if (flagged.length === 0) continue;
    lines.push(`### ${cat.label} (${cat.score}%)`, "");
    for (const check of flagged) {
      lines.push(
        `- **${check.label}** — score ${Math.round(check.score * 100)}%${check.dismissed ? " (marked intentional)" : ""}`,
      );
      if (check.suggestion) {
        lines.push(`  - ${check.suggestion.title}`);
        if (check.suggestion.detail) lines.push(`  - ${check.suggestion.detail}`);
        if (check.suggestion.fix) lines.push(`  - Suggestion: ${check.suggestion.fix}`);
        if (check.suggestion.affected?.length)
          lines.push(`  - Affected: ${check.suggestion.affected.join(", ")}`);
      }
    }
    lines.push("");
  }
  lines.push(`_Computed ${report.checkedAt} by Monarch. Suggestions only — nothing was changed._`);
  return lines.join("\n");
}

