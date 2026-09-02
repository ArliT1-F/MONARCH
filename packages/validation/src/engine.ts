/**
 * Validation engine core.
 *
 * Rules produce ValidationIssues; the engine aggregates them. Issues carry
 * a severity: "error" blocks applying/publishing, "warning" is surfaced but
 * doesn't block. Every issue must be phrased for humans, with a fix where
 * one exists.
 */
export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: IssueSeverity;
  /** Stable code, e.g. "channel.name.length" */
  code: string;
  message: string;
  fix?: string;
  /** Path to the offending entity, e.g. { kind: "channel", id: "…" } */
  target?: { kind: "guild" | "category" | "channel" | "role"; id?: string; name?: string };
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  issues: ValidationIssue[];
}

export function buildReport(issues: ValidationIssue[]): ValidationReport {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { valid: errors.length === 0, errors, warnings, issues };
}

export type Rule<T> = (subject: T) => ValidationIssue[];

export function runRules<T>(subject: T, rules: Rule<T>[]): ValidationReport {
  return buildReport(rules.flatMap((rule) => rule(subject)));
}
