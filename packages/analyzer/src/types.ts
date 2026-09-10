import type { ServerDesign } from "@monarch/schemas";

/**
 * Design Analyzer types (FEATURE 9).
 *
 * The analyzer is pure, deterministic and read-only: same design in, same
 * report out. It scores *design health* — organization, naming, role
 * consistency, branding — and produces suggestions. It never mutates
 * anything and its output is always advisory:
 * "Recommendations must be suggestions. Do not automatically modify the
 * server." (spec, FEATURE 9).
 */

export type AnalyzerCategoryId = "organization" | "naming" | "roles" | "branding";

export interface AnalyzerSuggestion {
  /** One-line summary, e.g. "Role colors are inconsistent." */
  title: string;
  /** Why this matters, in plain language. */
  detail?: string;
  /** What to do about it, e.g. "Use a unified 5-color palette." */
  fix?: string;
  /** Names of the offending entities (capped — see MAX_AFFECTED). */
  affected?: string[];
}

export interface AnalyzerCheckResult {
  /** Stable id, e.g. "naming.capitalization" — the key users dismiss by. */
  id: string;
  /** Human label, e.g. "Channel capitalization". */
  label: string;
  category: AnalyzerCategoryId;
  /** 0..1. 1 = nothing to flag, 0 = maximally flaggable. */
  score: number;
  /** true when score is at its maximum — shown as a green tick. */
  pass: boolean;
  /** Advisory only — an informational check can pass and still suggest. */
  suggestion?: AnalyzerSuggestion;
  /** Present when the user marked this check as intentional. */
  dismissed?: boolean;
}

export interface AnalyzerCategoryScore {
  id: AnalyzerCategoryId;
  label: string;
  /** 0..100, averaged over the non-dismissed checks in the category. */
  score: number;
  checks: AnalyzerCheckResult[];
}

export interface AnalyzerStats {
  categories: number;
  channels: number;
  textChannels: number;
  voiceChannels: number;
  topicsSet: number;
  roles: number;
  coloredRoles: number;
  uncategorizedChannels: number;
}

export interface AnalyzerReport {
  /** 0..100, weighted mean of the category scores. */
  overall: number;
  categories: AnalyzerCategoryScore[];
  /** Checks the user marked as intentional (excluded from scoring). */
  dismissedCount: number;
  stats: AnalyzerStats;
  /** ISO timestamp of when the report was computed. */
  checkedAt: string;
}

/** Weights per category — must sum to 1. Order is display order too. */
export const ANALYZER_CATEGORIES: { id: AnalyzerCategoryId; label: string; weight: number }[] = [
  { id: "organization", label: "Organization", weight: 0.3 },
  { id: "naming", label: "Naming", weight: 0.3 },
  { id: "roles", label: "Role Consistency", weight: 0.2 },
  { id: "branding", label: "Branding", weight: 0.2 },
];

/**
 * Dismissal thresholds shared with the UI: score colors.
 * Green ≥ 80, yellow ≥ 60, red < 60 — same breakpoints as `/monarch health`.
 */
export const SCORE_GOOD = 80;
export const SCORE_FAIR = 60;

/** Cap on affected-entity lists so a 500-channel server can't flood the UI. */
export const MAX_AFFECTED = 6;

export interface AnalyzerOptions {
  /**
   * Check ids the user marked as "intentional". They are still reported
   * (with `dismissed: true`) but excluded from every score.
   */
  dismissed?: readonly string[];
}

export type AnalyzerCategoryIdShape = AnalyzerCategoryId;

export interface AnalyzerCheckResultShape {
  score: number;
  suggestion?: AnalyzerSuggestion;
}

export interface AnalyzerCheck {
  id: string;
  label: string;
  category: AnalyzerCategoryId;
  /**
   * Weight within the category average (default 1). "Basic structure"
   * carries extra weight so a near-empty server can't ride to a high
   * score on vacuous passes.
   */
  weight?: number;
  apply(design: ServerDesign): AnalyzerCheckResultShape;
}

export function capAffected(list: string[]): string[] {
  return list.slice(0, MAX_AFFECTED);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** `lower` | `upper` | `mixed` casing style of a name. */
export function casingStyle(name: string): "lower" | "upper" | "mixed" {
  if (name === name.toLowerCase()) return "lower";
  if (name === name.toUpperCase()) return "upper";
  return "mixed";
}
