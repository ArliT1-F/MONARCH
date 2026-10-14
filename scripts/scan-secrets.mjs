#!/usr/bin/env node
/**
 * Monarch secret scanner — `npm run security:scan`.
 *
 * Scans every *tracked* file (plus any paths given as arguments) for
 * credentials and fails the build when one is found.
 *
 * ⚠️ OUTPUT POLICY: this script never prints a discovered secret. A finding
 * is reported as `path:line  rule-name  value=[REDACTED]`. That keeps CI
 * logs (which are frequently world-readable on public repositories) from
 * becoming a second disclosure channel — the whole point of scanning.
 *
 * Allow-listing a line is deliberate and auditable:
 *
 *   DATABASE_URL=postgresql://<user>:<password>@host/db   # secret-scan:allow local dev default
 *
 * The reason after `secret-scan:allow` is required; a bare marker is ignored.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ALLOW_MARKER = /(?:^|[\s#/'";-])secret-scan:allow\s+(\S.*)$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip binaries/huge files
const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".mp3",
  ".ogg",
  ".wav",
  ".mp4",
  ".webm",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".lock",
  ".map",
  ".snap",
  ".pyc",
  ".node",
  ".bin",
]);
const SKIP_BASENAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
/** Directories never worth scanning (build output, caches, VCS internals). */
const DIR_SKIP = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".monarch",
  ".monarch-data",
  ".cache",
  "__pycache__",
]);

/**
 * Values that are obviously not credentials: empty, placeholders, shell/CI
 * interpolation, and the documented local-development defaults that
 * docker-compose.yml actually uses for its throwaway Postgres container.
 */
const NOT_A_SECRET = [
  /^$/,
  /^<.*>$/, // <password>, <REDACTED-PASSWORD>, <user>
  /^\$\{.*\}$/, // ${POSTGRES_PASSWORD:-monarch}
  /^\$[A-Z_]+$/,
  /^%[A-Z_]+%$/,
  /^(change[-_]?me|changeme|please-change-me|your[-_].*|example|placeholder|dummy|sample|todo|none|null|undefined|true|false)$/i,
  /^(dev-only-secret-change-me|monarch|postgres|password|secret|test|testing|local|localhost)$/i,
  // Test fixtures: `test-internal-token`, `mock_api_key`, `dummy-password`…
  /^(test|tests|dummy|fake|mock|mocked|stub|example|sample|fixture|invalid|bogus|placeholder|not-a-real|local)(?:[-_.][a-z0-9._-]+)*$/i,
  /^[x*•]+$/i,
  /^\.\.\.$/,
  /^#{3,}$/,
];

/**
 * Rules. `mask` is applied before anything reaches stdout.
 * Each rule is deliberately narrow: a broad "anything that looks random"
 * heuristic would bury real findings under false positives.
 */
const RULES = [
  {
    id: "neon-role-password",
    description: "Neon PostgreSQL role password (npg_…)",
    pattern: /\bnpg_[A-Za-z0-9]{6,}\b/g,
    check: (m) => !isPlaceholder(m),
  },
  {
    id: "db-url-with-password",
    description: "database connection string carrying a password",
    pattern:
      /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|rediss):\/\/([^\s:@/'"]+):([^\s@/'"]+)@[^\s/'"]*/gi,
    check: (m, groups) => {
      const password = groups[1];
      if (/^(?:<.*>|\$\{.*\}|\$[A-Z_]+)$/.test(password)) return false;
      // Only explicitly local, well-known defaults are exempt. A short real
      // password or a common username on a remote database must still fail.
      if (
        /^(?:postgres|monarch)$/.test(password) &&
        /@(?:localhost|127\.0\.0\.1|postgres|\$\{hostPort\})(?::|\/|@|$)/.test(m)
      )
        return false;
      return true;
    },
    group: 1,
  },
  {
    id: "discord-bot-token",
    description: "Discord bot or client token",
    pattern: /\b[MNO][A-Za-z\d_-]{22,}\.[A-Za-z\d_-]{5,}\.[A-Za-z\d_-]{20,}\b/g,
  },
  {
    id: "github-token",
    description: "GitHub personal access / app token",
    pattern: /\bgh[pousr]_[A-Za-z\d]{20,}\b/g,
  },
  {
    id: "aws-access-key-id",
    description: "AWS access key id",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "slack-token",
    description: "Slack bot/user token",
    pattern: /\bxox[baprs]-[A-Za-z\d-]{10,}\b/g,
  },
  {
    id: "stripe-secret-key",
    description: "Stripe secret or restricted key",
    pattern: /\b[sr]k_(?:live|test)_[A-Za-z\d]{16,}\b/g,
  },
  {
    id: "openai-api-key",
    description: "OpenAI-style API key",
    pattern: /\bsk-(?:proj-)?[A-Za-z\d_-]{24,}\b/g,
  },
  {
    id: "private-key-block",
    description: "PEM private key block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "jwt",
    description: "signed JWT (three base64url segments)",
    pattern: /\beyJ[A-Za-z\d_-]{8,}\.eyJ[A-Za-z\d_-]{8,}\.[A-Za-z\d_-]{8,}\b/g,
  },
  {
    id: "secret-assignment",
    description: "credential-looking value assigned to a secret variable",
    pattern:
      /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY|SIGNING_KEY|DSN|CONNECTION_STRING)[A-Z0-9_]*)\s*(?::|=)\s*["']?([^\s"'`,;#${}]{16,})["']?/g,
    check: (_m, groups) => !isPlaceholder(groups[1]),
    group: 1,
    // `X_TOKEN = process.env.X_TOKEN` and friends are plumbing, not secrets.
    ignore:
      /(process\.env|import\.meta\.env|os\.environ|ENV\[|\$\{|System\.getenv|readEnv|randomBytes\()/i,
  },
  {
    id: "authorization-bearer-literal",
    description: "hard-coded Authorization: Bearer credential",
    pattern:
      /["'`]?(?:authorization|proxy-authorization)["'`]?\s*[:=]\s*["'`]Bearer\s+([A-Za-z\d._~+/-]{20,}=*)["'`]/gi,
    check: (_m, groups) => !isPlaceholder(groups[0]) && !/\$\{|process\.env|\+/.test(groups[0]),
    group: 0,
  },
];

function isPlaceholder(value) {
  if (typeof value !== "string") return true;
  const v = value.trim();
  if (v.length < 8) return true;
  return NOT_A_SECRET.some((re) => re.test(v));
}

/** No credential material, even prefixes/suffixes, belongs in CI logs. */
function mask() {
  return "[REDACTED]";
}

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function collectFiles(argv) {
  if (argv.length > 0) {
    const out = [];
    for (const target of argv) {
      const st = statSync(target, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) out.push(...walk(target));
      else out.push(target);
    }
    return out;
  }
  const tracked = trackedFiles();
  return tracked.length > 0 ? tracked : walk(".");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const skipDir =
      entry.isDirectory() &&
      (entry.name === "node_modules" || entry.name === ".git" || DIR_SKIP.has(entry.name));
    if (skipDir) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function shouldScan(file) {
  const base = path.basename(file);
  if (SKIP_BASENAMES.has(base)) return false;
  const ext = path.extname(base).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return false;
  if (file.includes("node_modules/") || file.includes("/.git/")) return false;
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return false;
  } catch {
    return false;
  }
  return true;
}

function scanFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (text.includes("\0")) return []; // binary
  const findings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const allow = line.match(ALLOW_MARKER);
    for (const f of matchLine(line, file, i + 1)) {
      findings.push({ ...f, allowed: allow ? allow[1].trim() : null });
    }
  });
  return findings;
}

export { ALLOW_MARKER, RULES, isPlaceholder, mask, scanFile, shouldScan, collectFiles };

/** Scan raw text (no filesystem) — used by the scanner's own tests. */
export function scanText(text, file = "<memory>") {
  const findings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const allow = line.match(ALLOW_MARKER);
    for (const f of matchLine(line, file, i + 1)) {
      findings.push({ ...f, allowed: allow ? allow[1].trim() : null });
    }
  });
  return findings;
}

function matchLine(line, file, lineNo) {
  const out = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(line)) !== null) {
      const matched = m[0];
      if (rule.ignore && rule.ignore.test(matched)) {
        if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
        continue;
      }
      const groups = m.slice(1);
      const secret = rule.group !== undefined ? (groups[rule.group] ?? matched) : matched;
      if (rule.check && !rule.check(matched, groups)) {
        if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
        continue;
      }
      if (!rule.check && isPlaceholder(secret)) {
        if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
        continue;
      }
      out.push({
        file,
        line: lineNo,
        rule: rule.id,
        description: rule.description,
        masked: mask(secret),
      });
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const quiet = process.argv.includes("--quiet");
  const files = collectFiles(argv).filter(shouldScan);
  const all = files.flatMap(scanFile);
  const findings = all.filter((f) => !f.allowed);
  const allowed = all.filter((f) => f.allowed);

  if (!quiet) {
    console.log(
      `secret scan: ${files.length} file(s) inspected, ${RULES.length} rule(s), ` +
        `${findings.length} finding(s), ${allowed.length} allow-listed`,
    );
  }
  for (const f of allowed) {
    console.log(`  allow  ${f.file}:${f.line}  ${f.rule}  value=${f.masked}`);
  }
  for (const f of findings) {
    // Value is masked on purpose — see the header comment.
    console.error(`  FOUND  ${f.file}:${f.line}  ${f.rule}  value=${f.masked}`);
    console.error(`         ${f.description}`);
    console.error(
      `         Remove it, rotate the credential, and add an inline\n` +
        `         "# secret-scan:allow <reason>" marker only if this line is genuinely not a secret.`,
    );
  }
  if (findings.length > 0) {
    console.error(
      `\nsecret scan FAILED: ${findings.length} credential-like value(s) in tracked files.\n` +
        `A credential that was ever committed must be ROTATED — deleting the line does not\n` +
        `unpublish it from Git history. See docs/security.md.`,
    );
    process.exitCode = 1;
  }
}

// Run only as a CLI (`node scripts/scan-secrets.mjs`), never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
