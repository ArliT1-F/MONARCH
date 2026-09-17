#!/usr/bin/env node
/**
 * Quick Lavalink health check for Monarch.
 * Reads .env (repo root) and tries to reach the configured node(s).
 *
 * Usage:
 *   node scripts/check-lavalink.mjs
 *   npm run music:check
 *
 * It mimics what the bot does: parse LAVALINK_NODES / HOST / PORT / PASSWORD
 * and GET /version and /v4/info.
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const ENV_PATHS = [
  path.join(REPO_ROOT, ".env"),
  path.join(REPO_ROOT, "docker", ".env"),
];

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

for (const p of ENV_PATHS) loadDotEnv(p);

function boolEnv(name, fallback = false) {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  return !(raw === "0" || raw === "false" || raw === "no");
}
function intEnv(name, fallback) {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function parseNode(raw, password, index) {
  let text = raw.trim();
  if (!text) return null;
  let name = null;
  const at = text.indexOf("@");
  if (at > 0) {
    name = text.slice(0, at).trim();
    text = text.slice(at + 1).trim();
  }
  let secure = boolEnv("LAVALINK_SECURE", false);
  const scheme = text.match(/^(wss|ws|https|http):\/\//i);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    secure = proto === "wss" || proto === "https";
    text = text.slice(scheme[0].length);
  }
  text = text.split("/")[0] ?? text;
  let host = text;
  let port = intEnv("LAVALINK_PORT", 2333);
  const m = text.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? text.match(/^([^:]+)(?::(\d+))?$/);
  if (m?.[1]) {
    host = m[1];
    if (m[2]) port = Number.parseInt(m[2], 10);
  }
  if (!host) return null;
  return { name: name || `node-${index + 1}`, host, port, password, secure };
}

function nodesFromEnv() {
  const password = process.env.LAVALINK_PASSWORD?.trim() || "youshallnotpass";
  const port = intEnv("LAVALINK_PORT", 2333);
  const secure = boolEnv("LAVALINK_SECURE", false);
  const configured = (process.env.LAVALINK_NODES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length > 0) {
    const nodes = [];
    configured.forEach((e, i) => {
      const n = parseNode(e, password, i);
      if (n) nodes.push(n);
    });
    if (nodes.length > 0) return nodes;
  }
  const host = process.env.LAVALINK_HOST?.trim() || "localhost";
  return [{ name: "node-1", host, port, password, secure }];
}

const nodes = nodesFromEnv();

console.log("Monarch — Lavalink health check");
console.log("=================================");
console.log(`Env files checked: ${ENV_PATHS.join(", ")}`);
console.log(`LAVALINK_NODES=${process.env.LAVALINK_NODES || "(blank → uses LAVALINK_HOST)"}`);
console.log(`LAVALINK_HOST=${process.env.LAVALINK_HOST || "localhost (default)"}`);
console.log(`LAVALINK_PORT=${process.env.LAVALINK_PORT || "2333 (default)"}`);
console.log(`LAVALINK_PASSWORD=${process.env.LAVALINK_PASSWORD ? "(set, length " + process.env.LAVALINK_PASSWORD.length + ")" : "youshallnotpass (default)"}`);
console.log("");
console.log(`Found ${nodes.length} node(s): ${nodes.map((n) => `${n.name}(${n.host}:${n.port}${n.secure ? " secure" : ""})`).join(", ")}`);
console.log("");

let hadFailure = false;

for (const node of nodes) {
  const proto = node.secure ? "https" : "http";
  const base = `${proto}://${node.host}:${node.port}`;
  console.log(`→ Checking ${node.name} at ${base} ...`);
  const headers = { Authorization: node.password };

  // 1. /version (no auth needed on some versions, but try with auth)
  try {
    const res = await fetch(`${base}/version`, { headers });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.log(`  ✗ /version HTTP ${res.status}: ${txt.slice(0, 200)}`);
      if (res.status === 401) {
        console.log(`    → 401 means LAVALINK_PASSWORD mismatch. Your .env has a custom password but the node is still on default, or vice versa.`);
        console.log(`       Fix: ensure LAVALINK_PASSWORD in .env equals lavalink.server.password in docker/lavalink/application.yml`);
        console.log(`       Then: docker compose -f docker/docker-compose.yml up -d --force-recreate lavalink`);
      }
      hadFailure = true;
    } else {
      const data = await res.json().catch(() => null);
      console.log(`  ✓ /version OK: ${JSON.stringify(data).slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`  ✗ /version fetch failed: ${String(e).slice(0, 300)}`);
    console.log(`    → The node isn't running or not reachable at ${node.host}:${node.port}`);
    if (node.host === "localhost" || node.host === "127.0.0.1" || node.host === "lavalink") {
      console.log(`       Start it:`);
      console.log(`         docker compose -f docker/docker-compose.yml up -d lavalink   # from repo root`);
      console.log(`         docker compose up -d lavalink                                 # from docker/ folder`);
      console.log(`         ./deploy/laptop-install.sh                                    # systemd on your own box`);
      console.log(`       Then:`);
      console.log(`         curl http://localhost:${node.port}/version`);
      console.log(`         docker logs monarch-lavalink -f`);
    }
    hadFailure = true;
    console.log("");
    continue;
  }

  // 2. /v4/info (needs auth)
  try {
    const res = await fetch(`${base}/v4/info`, { headers });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.log(`  ✗ /v4/info HTTP ${res.status}: ${txt.slice(0, 200)}`);
      hadFailure = true;
    } else {
      const info = await res.json().catch(() => null);
      const plugins = info?.plugins?.map?.((p) => p.name).join(", ") || "none listed";
      console.log(`  ✓ /v4/info OK — plugins: ${plugins}`);
      console.log(`    version: ${info?.version?.semver ?? "unknown"}, sources: ${Object.keys(info?.sourceManagers ?? {}).join(", ") || "default"}`);
    }
  } catch (e) {
    console.log(`  ✗ /v4/info fetch failed: ${String(e).slice(0, 300)}`);
    hadFailure = true;
  }

  // 3. /v4/stats
  try {
    const res = await fetch(`${base}/v4/stats`, { headers });
    if (res.ok) {
      const stats = await res.json();
      console.log(`  ✓ /v4/stats — players: ${stats.players}, playing: ${stats.playingPlayers}, uptime: ${Math.round(stats.uptime / 1000)}s`);
    }
  } catch {
    // non-fatal
  }

  console.log("");
}

if (hadFailure) {
  console.log("Result: ❌ Some checks failed.");
  console.log("");
  console.log("Common fixes for 'Couldn't reach the Lavalink node at localhost:2333':");
  console.log("  1. Start the node:");
  console.log("     docker compose -f docker/docker-compose.yml up -d lavalink");
  console.log("  2. If you run the bot with `npm run dev:bot` outside Docker, ensure:");
  console.log("     - docker-compose.yml exposes 2333 (it does by default)");
  console.log("     - .env has LAVALINK_HOST=localhost and LAVALINK_PORT=2333 (or blank LAVALINK_NODES)");
  console.log("     - LAVALINK_PASSWORD in .env matches docker/lavalink/application.yml");
  console.log("  3. Check logs:");
  console.log("     docker logs monarch-lavalink -f");
  console.log("     curl -v http://localhost:2333/version -H \"Authorization: <your password>\"");
  console.log("  4. If you deployed the bot on Render/Railway/etc, Lavalink can't run there (no UDP egress).");
  console.log("     Host it on a VPS/Fly.io/your laptop and set LAVALINK_NODES=wss://your-node:2333");
  console.log("     See docs/hosting-laptop.md and deploy/laptop-install.sh");
  process.exit(1);
} else {
  console.log("Result: ✅ All nodes reachable. If /music still fails, check bot logs and LAVALINK_PASSWORD.");
}
