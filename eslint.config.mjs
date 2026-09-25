import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Monarch's lint gate — deliberately narrow.
 *
 * The repo's real safety net is `npm test` (unit tests over the pure engines,
 * the store and both command surfaces) plus strict `tsc --noEmit`. So ESLint
 * is not here to re-check types or to restyle code Prettier already owns. It
 * catches the handful of runtime-shape bugs TypeScript cannot see — dead code,
 * self-assignment, useless assignments, un-awaited promises in the places
 * where nothing awaits them.
 *
 * Three rules are load-bearing for this codebase's conventions:
 *  - `no-console`: logging goes through `createLogger` in @monarch/shared,
 *    which redacts secret-looking keys (docs/objective.md B.4). Scripts, the
 *    installer and tests may print.
 *  - `no-restricted-imports`: `@discordjs/rest` / `discord.js` stay behind the
 *    `DiscordGateway` seam (agent.md §14).
 *  - `@typescript-eslint/no-floating-promises` + `no-misused-promises` on
 *    `apps/bot/src`: the worker's event handlers are the one place where a
 *    dangling promise means a failure nobody logged. These two are
 *    type-aware, hence `projectService` on that block only — the rest of the
 *    repo lints without type information so `npm run lint` stays a few seconds.
 *
 * `@next/next/no-img-element` and `react-hooks/exhaustive-deps` are registered
 * because the source already carries disable comments for them (the embed
 * preview needs plain `<img>` for arbitrary user URLs); keeping them as warns
 * means those comments stay honest instead of silently decaying.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      // Build output: `**` on the left, because Next writes `.next/` inside
      // apps/dashboard (a bare ".next/**" only matches it at the root, and
      // linting 1.7k lines of a bundled framework is not a signal).
      "**/.next/**",
      "dist/**",
      "coverage/**",
      "apps/dashboard/lib/generated/**",
      "apps/dashboard/next-env.d.ts",
    ],
  },

  // ---------------------------------------------------------------- TS + TSX
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // Types are tsc's job; keep the overlap minimal and the signal high.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-unused-expressions": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-constant-condition": ["error", { checkLoops: false }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
      "@next/next/no-img-element": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/rules-of-hooks": "error",
    },
  },

  // ------------------------------------------------- the bot worker (type-aware)
  {
    files: ["apps/bot/src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },

  // ------------------------------------------------------------- plain JS + mjs
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: { ...globals.node, ...globals.es2022 } },
    rules: {
      // No TypeScript here and no `globals` declaration can cover every
      // Node/GPU-adjacent global a script touches; these run in one place, on
      // purpose, and are exercised by `npm run music:check`.
      "no-undef": "off",
    },
  },

  {
    // Scripts, installers and the slash-command registrar talk to the terminal.
    files: ["scripts/**/*.{mjs,js,ts}", "apps/**/src/register-commands.ts"],
    rules: { "no-console": "off" },
  },

  {
    // Tests: doubles are loose by design, and a suite may print why it fails.
    files: ["**/test/**/*.ts", "**/*.test.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },

  // ------------------------------------------------------- architecture seams
  {
    files: ["apps/dashboard/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@discordjs/rest",
              message: "Discord REST calls live behind DiscordGateway — see agent.md §14.",
              importNames: ["REST"],
            },
          ],
          patterns: [
            {
              group: ["discord.js", "@discordjs/*"],
              message:
                "Discord-specific code belongs in packages/discord or apps/bot, not in the dashboard or shared packages (agent.md §14).",
            },
          ],
        },
      ],
    },
  },
  {
    // The bot and the gateway package are the two places allowed to speak
    // discord.js directly.
    files: ["apps/bot/**/*.{ts,tsx}", "packages/discord/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": "off" },
  },
);
