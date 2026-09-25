import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest at the repo root: every package and app contributes `test/*.test.ts`,
 * and `@/*` is aliased to the dashboard the way its own tsconfig does, so
 * store-level tests can import the code under test.
 *
 * Prisma-client awareness. `apps/dashboard/lib/prisma.ts` statically imports
 * the generated client from `apps/dashboard/lib/generated/prisma/client`, and
 * `lib/store.ts` imports it in turn — so on a machine where `prisma generate`
 * could not run, every suite that touches the store dies on `Cannot find
 * module`, and `npm test` goes red for a reason unrelated to the change under
 * test. Those suites are filtered out instead, with a printed notice.
 *
 * The filter is derived, never hardcoded: each test file is walked through its
 * static and dynamic imports and excluded exactly when that walk reaches the
 * generated directory — honouring `vi.mock(...)` seams, which is how
 * command-prefix.test.ts and confession.test.ts test the FileStore while
 * staying runnable offline. Add a store import to a new suite and it is
 * covered; remove one and it runs again.
 *
 * In CI a silent skip would be a lie, so `MONARCH_REQUIRE_CODEGEN=1` (set by
 * .github/workflows/ci.yml) turns a missing client into a hard error instead.
 */

const repoRoot = __dirname;
const dashboardRoot = path.join(repoRoot, "apps", "dashboard");

/** Where `generator client { output = … }` in prisma/schema.prisma writes. */
const generatedDir = path.join(dashboardRoot, "lib", "generated");
const prismaGenerated = ["client.ts", "client.js", "client.mjs"].some((name) =>
  existsSync(path.join(generatedDir, "prisma", name)),
);

if (!prismaGenerated && process.env.MONARCH_REQUIRE_CODEGEN === "1") {
  throw new Error(
    "vitest: the Prisma client is not generated (apps/dashboard/lib/generated/prisma).\n" +
      "  MONARCH_REQUIRE_CODEGEN=1 means the database suites must run — execute\n" +
      "  `npm run db:generate` before `npm test`.",
  );
}

/** `import x from "…"`, `import "…"`, `export * from "…"`, `import("…")`. */
const SPECIFIER_RE = /(?:\bfrom|\bimport|\bexport\s*\*)\s*\(?\s*["']([^"']+)["']/g;

/** Modules a suite replaced with a double — `vi.mock("./x", …)`, hoisted above imports. */
const MOCK_RE = /\bvi\.(?:mock|doMock)\s*\(\s*["']([^"']+)["']/g;

/** The client is unresolvable precisely when it is missing, so match the text. */
const pointsAtGeneratedClient = (spec: string) => spec.includes("lib/generated/");

/** Resolve the specifiers that can matter: the dashboard alias and relatives. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(dashboardRoot, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // a workspace package or node_modules — never the client
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function specifiersOf(file: string, re: RegExp): string[] {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return [...source.matchAll(re)].map((match) => match[1]!);
}

/**
 * True when `file` reaches apps/dashboard/lib/generated through its imports.
 * `mocked` holds files the test replaced with `vi.mock` — a mocked edge is a
 * dead end by construction, which is exactly what those tests rely on.
 */
function needsPrismaClient(file: string, mocked: Set<string>, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  for (const spec of specifiersOf(file, SPECIFIER_RE)) {
    const resolved = resolveSpecifier(spec, file);
    if (resolved && mocked.has(resolved)) continue;
    if (pointsAtGeneratedClient(spec)) return true;
    if (resolved && needsPrismaClient(resolved, mocked, seen)) return true;
  }
  return false;
}

function listTestFiles(dir: string, into: string[] = []): string[] {
  if (!existsSync(dir)) return into;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listTestFiles(full, into);
    else if (/\.test\.tsx?$/.test(entry.name)) into.push(full);
  }
  return into;
}

const skippedForCodegen: string[] = [];
if (!prismaGenerated) {
  const testRoots = [
    path.join(dashboardRoot, "test"),
    path.join(repoRoot, "apps", "bot", "test"),
    ...readdirSync(path.join(repoRoot, "packages"))
      .map((pkg) => path.join(repoRoot, "packages", pkg, "test"))
      .filter(existsSync),
  ];
  for (const file of testRoots.flatMap((root) => listTestFiles(root))) {
    const mocked = new Set(
      specifiersOf(file, MOCK_RE)
        .map((spec) => resolveSpecifier(spec, file))
        .filter((resolved): resolved is string => resolved !== null),
    );
    if (needsPrismaClient(file, mocked)) skippedForCodegen.push(path.relative(repoRoot, file));
  }
  if (skippedForCodegen.length > 0) {
    console.warn(
      `\nvitest: no Prisma client — skipping ${skippedForCodegen.length} suite(s) that import it:\n` +
        skippedForCodegen.map((file) => `  - ${file}`).join("\n") +
        "\n  Run `npm run db:generate` to include them.\n",
    );
  }
}

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", ...skippedForCodegen],
    environment: "node",
  },
  resolve: {
    alias: [
      // Mirror apps/dashboard/tsconfig.json "@/*" -> "./*" (regex so the
      // workspace packages "@monarch/*" are left untouched).
      { find: /^@\//, replacement: dashboardRoot + "/" },
    ],
  },
});
