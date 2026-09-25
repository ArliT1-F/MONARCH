#!/usr/bin/env node
/**
 * postinstall: generate the Prisma client, without making the install fatal
 * when Prisma's binaries cannot be reached.
 *
 * Why this exists instead of a bare `"postinstall": "prisma generate"`:
 * `prisma generate` downloads a schema engine from binaries.prisma.sh. On a
 * restricted network (corporate proxy, a sandbox, an offline runner) that
 * request fails — and with the raw command in `postinstall`, `npm install`
 * exits 1 *after* every dependency is already in place, so a clean clone looks
 * broken. Monarch degrades gracefully without the generated client: the file
 * store keeps the whole product running and vitest.config.ts filters out the
 * suites that import the client, with a printed notice. So the install should
 * not die for it.
 *
 * The exception is anywhere the client is load-bearing and invisible. CI (a red
 * `npm ci` is the correct outcome there) and a container build — both
 * docker/Dockerfiles generate the client *through this very hook*, so a silent
 * skip would ship an image that cannot talk to its own database.
 *
 *   - CI=1 / inside a container → failures propagate (exit 1)
 *   - MONARCH_SKIP_CODEGEN=1    → never runs generate, prints the status only
 *   - otherwise                 → warn, exit 0
 *
 * Generation is skipped when the client is present and newer than
 * prisma/schema.prisma, so re-running `npm install` costs nothing.
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** Where `generator client { output = … }` in prisma/schema.prisma writes. */
const GENERATED_DIR = path.join(root, "apps", "dashboard", "lib", "generated", "prisma");
const SCHEMA = path.join(root, "prisma", "schema.prisma");
const STRICT = Boolean(process.env.CI) || existsSync("/.dockerenv");

/** The generated client entry point (`client.ts`, or `.js`/`.mjs`). */
function clientEntry() {
  for (const ext of ["ts", "js", "mjs"]) {
    const file = path.join(GENERATED_DIR, `client.${ext}`);
    if (existsSync(file)) return file;
  }
  return null;
}

function isFresh() {
  const entry = clientEntry();
  if (!entry || !existsSync(SCHEMA)) return false;
  return statSync(entry).mtimeMs >= statSync(SCHEMA).mtimeMs;
}

const HOW_TO_FIX =
  "  The dashboard still runs on the file store, but the five suites that\n" +
  "  import the store are skipped and `tsc` cannot resolve\n" +
  "  @/lib/generated/prisma/client.  Fix: npm run db:generate\n";

if (process.env.MONARCH_SKIP_CODEGEN === "1") {
  if (!clientEntry()) {
    console.log(
      `Monarch: codegen skipped (MONARCH_SKIP_CODEGEN=1) — no Prisma client.\n${HOW_TO_FIX}`,
    );
  }
  process.exit(0);
}

if (isFresh()) {
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [require.resolve("prisma/build/index.js"), "generate", "--schema", SCHEMA],
  { cwd: root, stdio: "inherit" },
);

if (!result.error && result.status === 0) {
  process.exit(0);
}

const why = result.error?.message ?? `prisma generate exited with ${result.status}`;
console.error(`\nMonarch: \`prisma generate\` failed (${why}).`);
if (STRICT) {
  console.error(
    "  This is CI or a container build, where the client must exist before the\n" +
      "  image can be trusted — so this is fatal.\n",
  );
  process.exit(1);
}
console.error(`Monarch: continuing without it.\n${HOW_TO_FIX}`);
console.error(
  "  Not fatal here. Re-run `npm run db:generate` once binaries.prisma.sh is\n" +
    "  reachable to get the database suites back.\n",
);
process.exit(0);
