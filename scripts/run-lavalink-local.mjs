#!/usr/bin/env node
/**
 * Run Lavalink locally WITHOUT Docker.
 * Perfect if Docker crashes your laptop — this just needs Java 17+.
 *
 * Usage:
 *   node scripts/run-lavalink-local.mjs
 *   npm run music:local
 *
 * What it does:
 *   1. Checks java is on PATH (java -version)
 *   2. Creates .lavalink/ in repo root (or uses ~/.local/share/monarch-lavalink if exists)
 *   3. Downloads Lavalink.jar 4.2.2 if missing (~60MB)
 *   4. Copies docker/lavalink/application.yml next to the jar
 *   5. Runs: java -Xmx512M -jar Lavalink.jar
 *
 * It reads LAVALINK_PASSWORD and LAVALINK_PORT from .env so bot and node match.
 * First boot downloads youtube-source plugin into ./plugins — give it ~30s.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DOTENV = path.join(REPO_ROOT, ".env");
const CONFIG_SRC = path.join(REPO_ROOT, "docker/lavalink/application.yml");

// Keep it local to repo so it's easy to delete, but reuse laptop-install dir if already there
const HOME_LL = path.join(process.env.HOME || process.env.USERPROFILE || REPO_ROOT, ".local/share/monarch-lavalink");
const LOCAL_LL = path.join(REPO_ROOT, ".lavalink");
const LL_DIR = fs.existsSync(path.join(HOME_LL, "Lavalink.jar")) ? HOME_LL : LOCAL_LL;

const LAVALINK_VERSION = "4.2.2";
const JAR_URL = `https://github.com/lavalink-devs/Lavalink/releases/download/${LAVALINK_VERSION}/Lavalink.jar`;
const JAR_PATH = path.join(LL_DIR, "Lavalink.jar");
const CONFIG_DST = path.join(LL_DIR, "application.yml");

function loadEnv() {
  if (!fs.existsSync(DOTENV)) return;
  const txt = fs.readFileSync(DOTENV, "utf8");
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^[\"']|[\"']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const PASSWORD = process.env.LAVALINK_PASSWORD?.trim() || "youshallnotpass";
const PORT = process.env.LAVALINK_PORT?.trim() || "2333";
const HEAP = process.env.LAVALINK_HEAP?.trim() || "512M"; // lower than Docker's 1G — saves your laptop

console.log("Monarch — Lavalink local runner (no Docker)");
console.log("============================================");
console.log(`Repo: ${REPO_ROOT}`);
console.log(`Lavalink dir: ${LL_DIR}`);
console.log(`Version: ${LAVALINK_VERSION}`);
console.log(`Heap: -Xmx${HEAP}`);
console.log(`Port: ${PORT}`);
console.log(`Password: ${PASSWORD === "youshallnotpass" ? "youshallnotpass (default — set a real one in .env)" : "(set, length " + PASSWORD.length + ")"}`);
console.log("");

function checkJava() {
  try {
    const out = execSync("java -version", { stdio: ["ignore", "pipe", "pipe"] }).toString() + execSync("java -version 2>&1", { encoding: "utf8" });
    console.log(out.split("\n")[0]);
    return true;
  } catch {
    try {
      const out = execSync("java -version 2>&1", { encoding: "utf8" });
      console.log(out.split("\n")[0]);
      // check major version
      const m = out.match(/version \"?(\d+)/);
      if (m) {
        const major = parseInt(m[1], 10) === 1 ? parseInt(out.match(/version \"1\.(\d+)/)?.[1] || "0", 10) : parseInt(m[1], 10);
        if (major < 17) {
          console.error(`\n✗ Java ${major} too old — Lavalink 4 needs 17+ (21 recommended)`);
          return false;
        }
      }
      return true;
    } catch (e) {
      console.error("\n✗ java not found on PATH");
      console.error("Install Java 17+ (21 recommended):");
      console.error("  Windows: https://adoptium.net → Temurin 21 JRE");
      console.error("  macOS:   brew install --cask temurin@21");
      console.error("  Linux:   sudo apt install openjdk-21-jre-headless");
      console.error("           sudo dnf install java-21-openjdk-headless");
      console.error("           sudo pacman -S jre21-openjdk-headless");
      return false;
    }
  }
}

if (!checkJava()) process.exit(1);

fs.mkdirSync(LL_DIR, { recursive: true });

if (!fs.existsSync(CONFIG_SRC)) {
  console.error(`✗ Config source missing: ${CONFIG_SRC}`);
  process.exit(1);
}
fs.copyFileSync(CONFIG_SRC, CONFIG_DST);
console.log(`✓ Config copied: ${CONFIG_SRC} → ${CONFIG_DST}`);

// ── Clean up stale / broken plugins ───────────────────────────────────────
// Previous versions of application.yml used ${YOUTUBE_PLUGIN_VERSION} which
// could be set to a snapshot hash like 6579cdf via .env. That hash only exists
// in the snapshots repo, not releases, so Lavalink crashes with:
//   FileNotFoundException: .../youtube-plugin/6579cdf/youtube-plugin-6579cdf.jar
// We now pin to 1.18.2 in application.yml and explicitly remove any old
// snapshot-named jars and empty files to allow a clean re-download.
try {
  const pluginsDir = path.join(LL_DIR, "plugins");
  if (fs.existsSync(pluginsDir)) {
    const files = fs.readdirSync(pluginsDir);
    let cleaned = 0;
    for (const f of files) {
      const fp = path.join(pluginsDir, f);
      try {
        const stat = fs.statSync(fp);
        // Empty file (failed download) → delete
        if (stat.size === 0) {
          fs.unlinkSync(fp);
          console.log(`  cleaned empty plugin file: ${f}`);
          cleaned++;
          continue;
        }
        // Old snapshot hash pattern: youtube-plugin-<7-char-hash>.jar or similar
        // e.g. youtube-plugin-6579cdf.jar
        if (/youtube-plugin-.*\.jar$/i.test(f)) {
          // Keep only the pinned stable version
          if (!f.includes("1.18.2")) {
            fs.unlinkSync(fp);
            console.log(`  cleaned stale youtube plugin: ${f} (will re-download 1.18.2)`);
            cleaned++;
          }
        }
      } catch {}
    }
    if (cleaned > 0) {
      console.log(`✓ Cleaned ${cleaned} stale plugin file(s) from ${pluginsDir}`);
    }
  }
} catch (e) {
  console.warn(`⚠ Could not clean plugins dir: ${e.message}`);
}

async function downloadJar() {
  if (fs.existsSync(JAR_PATH)) {
    const verFile = path.join(LL_DIR, ".lavalink-version");
    const existingVer = fs.existsSync(verFile) ? fs.readFileSync(verFile, "utf8").trim() : "";
    if (existingVer === LAVALINK_VERSION) {
      console.log(`✓ Lavalink.jar ${LAVALINK_VERSION} already exists`);
      return;
    }
    console.log(`→ Version mismatch (${existingVer} → ${LAVALINK_VERSION}), re-downloading...`);
  }

  console.log(`→ Downloading ${JAR_URL} (~60MB) to ${JAR_PATH} ...`);
  const res = await fetch(JAR_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading Lavalink.jar`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = JAR_PATH + ".tmp";
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, JAR_PATH);
  fs.writeFileSync(path.join(LL_DIR, ".lavalink-version"), LAVALINK_VERSION);
  console.log(`✓ Downloaded ${Math.round(buf.length / 1024 / 1024)}MB`);
}

await downloadJar();

console.log("");
console.log(`Starting Lavalink in ${LL_DIR} ...`);
console.log(`Command: java -Xmx${HEAP} -jar Lavalink.jar`);
console.log(`Env: LAVALINK_PASSWORD=${PASSWORD.slice(0, 4)}**** LAVALINK_PORT=${PORT}`);
console.log("");
console.log("First boot downloads youtube-source plugin into ./plugins — give it ~30s");
console.log("Then test: curl http://localhost:" + PORT + "/version");
console.log("And:       npm run music:check");
console.log("Logs:      ./logs/ inside lavalink dir");
console.log("Stop:      Ctrl+C");
console.log("");

// Explicitly strip YOUTUBE_PLUGIN_VERSION so a stale .env value like
// 6579cdf (a snapshot commit that no longer exists in releases) doesn't
// override the pinned version in application.yml via Spring's ${VAR:default}
// placeholder. The config now hardcodes 1.18.2, but we also guard here.
const cleanEnv = { ...process.env };
delete cleanEnv.YOUTUBE_PLUGIN_VERSION;

const child = spawn("java", [`-Xmx${HEAP}`, "-jar", JAR_PATH], {
  cwd: LL_DIR,
  env: {
    ...cleanEnv,
    LAVALINK_PASSWORD: PASSWORD,
    LAVALINK_PORT: PORT,
    // Force the stable version for this process even if .env contains a hash
    YOUTUBE_PLUGIN_VERSION: "1.18.2",
  },
  stdio: "inherit",
});

child.on("close", (code) => {
  console.log(`\nLavalink exited with code ${code}`);
  process.exit(code ?? 0);
});
process.on("SIGINT", () => {
  console.log("\nStopping Lavalink...");
  child.kill("SIGTERM");
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
