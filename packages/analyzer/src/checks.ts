import type { ServerDesign } from "@monarch/schemas";
import { normalizeTextChannelName } from "@monarch/validation";
import type { AnalyzerCheck } from "./types.js";
import { capAffected, casingStyle } from "./types.js";

/**
 * Design Analyzer checks (FEATURE 9).
 *
 * Every check is a pure function of the ServerDesign. Scores are 0..1 with
 * 1 = nothing to flag; partial credit is used wherever a ratio is fairer
 * than a binary pass/fail (e.g. "80% of channels are categorized"). Check
 * ids are stable API — they are the keys the dashboard stores "mark as
 * intentional" dismissals under. Never rename one without a migration.
 *
 * All checks share one convention: @everyone (whose role id equals the
 * guild id) and `managed` roles are never flagged — Monarch surfaces them
 * but never judges or edits them.
 */

function roleStyleGroups(names: string[]) {
  const counts = { lower: 0, upper: 0, mixed: 0 };
  for (const name of names) counts[casingStyle(name)] += 1;
  const dominant = Math.max(counts.lower, counts.upper, counts.mixed);
  const dominantStyle =
    counts.mixed >= counts.lower && counts.mixed >= counts.upper
      ? "mixed"
      : counts.lower >= counts.upper
        ? "lower"
        : "upper";
  return { counts, dominant, dominantStyle };
}

/** Non-managed, non-@everyone roles — the ones Monarch would let you edit. */
function editableRoles(design: ServerDesign) {
  return design.roles.filter((r) => !r.managed && r.id !== design.guildId);
}

function isTextLike(c: { type: string }): boolean {
  return c.type === "text" || c.type === "announcement" || c.type === "forum";
}

export const CHECKS: AnalyzerCheck[] = [
  // ── Organization ─────────────────────────────────────────────
  {
    id: "org.has-structure",
    label: "Basic structure",
    category: "organization",
    // A server with nothing in it should not ride to a high score on
    // vacuous passes — structure is the point of the whole category.
    weight: 3,
    apply: (design) => {
      const hasCats = design.categories.length > 0;
      const hasChans = design.channels.length > 0;
      if (hasCats && hasChans) return { score: 1 };
      const score = hasCats || hasChans ? 0.5 : 0;
      return {
        score,
        suggestion: {
          title: "This server has barely any structure yet.",
          detail: "Categories group related channels; channels give people places to talk.",
          fix: "Add at least one category with a few channels — or import a template from the Library.",
        },
      };
    },
  },
  {
    id: "org.channels-categorized",
    label: "Channels live in categories",
    category: "organization",
    apply: (design) => {
      if (design.channels.length === 0) return { score: 1 };
      const catIds = new Set(design.categories.map((c) => c.id));
      const uncategorized = design.channels.filter((c) => !c.parentId || !catIds.has(c.parentId));
      const score = 1 - uncategorized.length / design.channels.length;
      if (uncategorized.length === 0) return { score: 1 };
      return {
        score,
        suggestion: {
          title: `${uncategorized.length} channel${uncategorized.length === 1 ? " sits" : "s sit"} outside any category.`,
          detail: "Top-level channels float above your categories and make the sidebar harder to scan.",
          fix: "Move them into the category they belong to.",
          affected: capAffected(uncategorized.map((c) => `#${c.name}`)),
        },
      };
    },
  },
  {
    id: "org.empty-categories",
    label: "No empty categories",
    category: "organization",
    apply: (design) => {
      if (design.categories.length === 0) return { score: 1 };
      const empty = design.categories.filter(
        (cat) => !design.channels.some((ch) => ch.parentId === cat.id),
      );
      const score = 1 - empty.length / design.categories.length;
      if (empty.length === 0) return { score: 1 };
      return {
        score,
        suggestion: {
          title: `${empty.length} categor${empty.length === 1 ? "y is" : "ies are"} empty.`,
          detail:
            "Empty categories render as collapsed headers with nothing in them — clutter without purpose.",
          fix: "Add channels to them, or delete them in the Server Designer.",
          affected: capAffected(empty.map((c) => c.name)),
        },
      };
    },
  },
  {
    id: "org.topics",
    label: "Channels have topics",
    category: "organization",
    apply: (design) => {
      const textLike = design.channels.filter(isTextLike);
      if (textLike.length === 0) return { score: 1 };
      const missing = textLike.filter((c) => !(c.topic ?? "").trim());
      const score = 1 - missing.length / textLike.length;
      if (missing.length === 0) return { score: 1 };
      return {
        score,
        suggestion: {
          title: `${missing.length} of ${textLike.length} text channel${
            missing.length === 1 ? "" : "s"
          } ${missing.length === 1 ? "has" : "have"} no topic.`,
          detail: "A one-line topic tells newcomers what belongs where without asking.",
          fix: "Add a short topic to each channel — its purpose and rules of thumb.",
          affected: capAffected(missing.map((c) => `#${c.name}`)),
        },
      };
    },
  },
  {
    id: "org.clutter",
    label: "Categories aren't overloaded",
    category: "organization",
    apply: (design) => {
      const groups = new Map<string, number>();
      for (const ch of design.channels) {
        const key = ch.parentId ?? "__root__";
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      if (groups.size === 0) return { score: 1 };
      const CLUTTER = 25;
      const overloaded = [...groups.entries()].filter(([, n]) => n > CLUTTER);
      const score = 1 - overloaded.length / groups.size;
      if (overloaded.length === 0) return { score: 1 };
      const names = overloaded.map(([id]) => {
        if (id === "__root__") return "top level";
        return design.categories.find((c) => c.id === id)?.name ?? "unknown category";
      });
      return {
        score,
        suggestion: {
          title: `${overloaded.length === 1 ? "One group holds" : "Some groups hold"} more than ${CLUTTER} channels.`,
          detail:
            "Very long channel lists bury the important ones; Discord caps categories at 50 channels for a reason.",
          fix: "Split busy categories into two focused ones, and archive channels nobody uses.",
          affected: capAffected(names),
        },
      };
    },
  },

  // ── Naming ───────────────────────────────────────────────────
  {
    id: "naming.separator-consistency",
    label: "Consistent word separators",
    category: "naming",
    apply: (design) => {
      const textLike = design.channels.filter(isTextLike);
      const withSep = textLike.filter((c) => /[-_]/.test(c.name));
      if (withSep.length < 2) return { score: 1 };
      const dashUsers = withSep.filter((c) => c.name.includes("-"));
      const underscoreUsers = withSep.filter((c) => !c.name.includes("-"));
      const score = Math.max(dashUsers.length, underscoreUsers.length) / withSep.length;
      if (score >= 1) return { score: 1 };
      const minority = dashUsers.length >= underscoreUsers.length ? underscoreUsers : dashUsers;
      return {
        score,
        suggestion: {
          title: "Channel names mix dashes and underscores.",
          detail:
            "Discord renders `general-chat` and `general_chat` differently, so mixed separators look unplanned.",
          fix: "Pick one separator (dashes are the Discord norm) and rename the odd ones out.",
          affected: capAffected(minority.map((c) => `#${c.name}`)),
        },
      };
    },
  },
  {
    id: "naming.capitalization",
    label: "Channel names are lowercase",
    category: "naming",
    apply: (design) => {
      // Voice/stage channels keep their case on Discord; text-like channels
      // are lowercased by Discord itself, so uppercase here means a rename
      // waiting to happen (or a hand-edited draft).
      const textLike = design.channels.filter(isTextLike);
      if (textLike.length === 0) return { score: 1 };
      const bad = textLike.filter((c) => c.name !== c.name.toLowerCase());
      const score = 1 - bad.length / textLike.length;
      if (bad.length === 0) return { score: 1 };
      return {
        score,
        suggestion: {
          title: `${bad.length} channel ${bad.length === 1 ? "name has" : "names have"} capital letters.`,
          detail:
            "Discord lowercases text-like channel names on save — what you see here is not what would ship.",
          fix: "Convert them to lowercase.",
          affected: capAffected(bad.map((c) => `#${c.name}`)),
        },
      };
    },
  },
  {
    id: "naming.duplicates",
    label: "No confusing duplicate names",
    category: "naming",
    apply: (design) => {
      if (design.channels.length === 0) return { score: 1 };
      // Reuse the validation engine's normalization (mirrors what Discord
      // stores) instead of a second, diverging copy of the logic.
      const norm = (name: string, textLike: boolean) =>
        textLike ? normalizeTextChannelName(name) : name.trim().toLowerCase();
      const groups = new Map<string, string[]>();
      for (const ch of design.channels) {
        const key = `${ch.parentId ?? "root"}:${ch.type}:${norm(ch.name, isTextLike(ch))}`;
        const list = groups.get(key) ?? [];
        list.push(ch.name);
        groups.set(key, list);
      }
      const dupes = [...groups.values()].filter((names) => names.length > 1);
      const score = 1 - dupes.length / groups.size;
      if (dupes.length === 0) return { score: 1 };
      return {
        score,
        suggestion: {
          title: `${dupes.length === 1 ? "One name is" : "Several names are"} used more than once in the same place.`,
          detail:
            "Discord allows duplicates, but #general in two categories is confusing in search and quick-switcher.",
          fix: "Differentiate them, e.g. #general-chat and #general-voice.",
          affected: capAffected(dupes.map((names) => names.join(" · "))),
        },
      };
    },
  },
  {
    id: "naming.voice-style",
    label: "Voice channels follow one style",
    category: "naming",
    apply: (design) => {
      const voice = design.channels.filter((c) => c.type === "voice" || c.type === "stage");
      if (voice.length < 2) return { score: 1 };
      const { dominant, dominantStyle } = roleStyleGroups(voice.map((v) => v.name));
      const score = dominant / voice.length;
      if (score >= 1) return { score: 1 };
      const minority = voice.filter((v) => casingStyle(v.name) !== dominantStyle);
      return {
        score,
        suggestion: {
          title: "Voice channel names mix capitalization styles.",
          detail:
            "Voice channels keep the case you type, so `General`, `GENERAL` and `general` can coexist — pick one.",
          fix: "Match the dominant style used elsewhere in the server.",
          affected: capAffected(minority.map((c) => c.name)),
        },
      };
    },
  },

  // ── Role Consistency ─────────────────────────────────────────
  {
    id: "roles.palette-focus",
    label: "Role colors form a palette",
    category: "roles",
    apply: (design) => {
      const colored = editableRoles(design).filter((r) => !!r.color);
      if (colored.length < 3) return { score: 1 };
      const distinct = new Set(colored.map((r) => (r.color ?? "").toLowerCase()));
      const n = distinct.size;
      if (n <= 5) return { score: 1 };
      return {
        score: n <= 8 ? 0.5 : 0,
        suggestion: {
          title: `Role colors use ${n} different values.`,
          detail: "A rainbow of role colors makes the member list noisy and unreadable.",
          fix: "Use a unified 5-color palette and assign each role one of them.",
          affected: capAffected([...distinct]),
        },
      };
    },
  },
  {
    id: "roles.color-coverage",
    label: "Color usage is all-or-nothing",
    category: "roles",
    apply: (design) => {
      const editable = editableRoles(design);
      if (editable.length < 3) return { score: 1 };
      const coloredList = editable.filter((r) => !!r.color);
      const plainList = editable.filter((r) => !r.color);
      const p = coloredList.length / editable.length;
      // Consistent schemes are p=0 (all plain) and p=1 (all colored); the
      // least consistent is a 50/50 mix. 4p(1-p) peaks at 1 when p=0.5.
      const score = 1 - 4 * p * (1 - p);
      if (score >= 0.999) return { score: 1 };
      const minority = coloredList.length >= plainList.length ? plainList : coloredList;
      return {
        score,
        suggestion: {
          title: "Some roles are colored and some are not.",
          detail:
            "A half-colored role list reads as accidental rather than designed. All plain or all colored both look intentional.",
          fix:
            coloredList.length >= plainList.length
              ? `Color the plain roles from your palette (e.g. ${capAffected(plainList.map((r) => r.name)).join(", ")}).`
              : "Remove color from the minority, or color the rest to match.",
          affected: capAffected(minority.map((r) => r.name)),
        },
      };
    },
  },
  {
    id: "roles.naming-consistency",
    label: "Role names follow one casing",
    category: "roles",
    apply: (design) => {
      const editable = editableRoles(design).filter((r) => r.name.trim().length > 0);
      if (editable.length < 3) return { score: 1 };
      const { dominant, dominantStyle } = roleStyleGroups(editable.map((r) => r.name));
      const score = dominant / editable.length;
      if (score >= 1) return { score: 1 };
      const minority = editable.filter((r) => casingStyle(r.name) !== dominantStyle);
      return {
        score,
        suggestion: {
          title: "Role names mix casing styles.",
          detail:
            "`Admin`, `admin` and `ADMIN` in one role list looks like three people set it up separately.",
          fix: "Restyle the minority to match the dominant casing.",
          affected: capAffected(minority.map((r) => r.name)),
        },
      };
    },
  },
  {
    id: "roles.hoist-discipline",
    label: "Few roles are displayed separately",
    category: "roles",
    apply: (design) => {
      const hoisted = editableRoles(design).filter((r) => r.hoist);
      if (hoisted.length <= 3) return { score: 1 };
      return {
        score: 3 / hoisted.length,
        suggestion: {
          title: `${hoisted.length} roles are set to display separately.`,
          detail:
            "Hoisted roles get their own member-list group — hoisting more than three fragments the list.",
          fix: "Keep hoist on the handful of roles that truly need visibility (e.g. Staff).",
          affected: capAffected(hoisted.map((r) => r.name)),
        },
      };
    },
  },

  // ── Branding ─────────────────────────────────────────────────
  {
    id: "branding.colors-set",
    label: "Brand colors are defined",
    category: "branding",
    apply: (design) => {
      const b = design.branding;
      const present =
        (b.primaryColor ? 0.5 : 0) + (b.secondaryColor ? 0.25 : 0) + (b.accentColor ? 0.25 : 0);
      if (present >= 1) return { score: 1 };
      return {
        score: present,
        suggestion: {
          title: "No brand colors are defined for this server.",
          detail:
            "Monarch can carry a primary/secondary/accent trio into embeds and the role palette so everything matches.",
          fix: "Pick your colors in the Branding editor.",
        },
      };
    },
  },
  {
    id: "branding.role-palette-alignment",
    label: "Roles match the brand palette",
    category: "branding",
    apply: (design) => {
      const palette = (design.branding.rolePalette ?? []).map((c) => c.toLowerCase());
      const colored = editableRoles(design).filter((r) => !!r.color);
      if (palette.length === 0) {
        // Advisory only: without a defined palette there is nothing to
        // align to, so the check passes but nudges toward defining one
        // once there are enough colors to be worth recording.
        if (colored.length < 5) return { score: 1 };
        return {
          score: 1,
          suggestion: {
            title: "Define a role palette to lock in consistency.",
            detail: `You have ${colored.length} colored roles. Recording a palette lets Monarch check them against it.`,
            fix: "Add your 3–5 core colors to the brand palette.",
          },
        };
      }
      if (colored.length === 0) return { score: 1 };
      const off = colored.filter((r) => !palette.includes((r.color ?? "").toLowerCase()));
      const score = 1 - off.length / colored.length;
      if (off.length === 0) return { score: 1 };
      return {
        score,
        suggestion: {
          title: `${off.length} role ${off.length === 1 ? "color is" : "colors are"} off-palette.`,
          detail: "These colors don't appear in the server's brand palette.",
          fix: "Recolor them from the palette, or add the color to the palette if it's intentional.",
          affected: capAffected(off.map((r) => `${r.name} (${r.color})`)),
        },
      };
    },
  },
];
