import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandFile } from "./context.js";

/**
 * `!era zhvishu` — a little easter egg, not a real Monarch feature. It grabs
 * a random image out of `era_img/` (a folder at the repo root, gitignored
 * except for a `.gitkeep`) and posts it. Deliberately prefix-only — this
 * isn't documented in `!help` or registered as a slash command, it's just
 * for the people who already know what to type.
 */

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

// This file lives at apps/bot/src/era.ts, so three levels up from here is the
// repo root — that holds whether the bot runs from the repo root (the
// docker image's WORKDIR) or from apps/bot (`npm run dev:bot`), because it
// never depends on process.cwd().
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Overridable for tests / a non-standard layout; defaults to `<repo>/era_img`. */
export const ERA_IMG_DIR = process.env.ERA_IMG_DIR?.trim() || path.join(REPO_ROOT, "era_img");

/** Picks one image at random out of `dir`. Null when there's nothing usable there. */
export async function pickRandomImage(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const images = entries.filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()));
  if (images.length === 0) return null;
  return images[Math.floor(Math.random() * images.length)] ?? null;
}

/** Loads an image off disk as a base64 {@link CommandFile}, ready for `ctx.attach`. */
async function loadImageFile(dir: string, name: string): Promise<CommandFile> {
  const data = await readFile(path.join(dir, name));
  return { name, body: data.toString("base64"), encoding: "base64" };
}

/** The bit `!era zhvishu` actually needs — kept narrow so it's easy to test. */
export interface EraContext {
  attach(content: string, files: CommandFile[]): Promise<unknown>;
  replyHidden(content: string): Promise<unknown>;
  readonly commandPrefix: string;
}

export async function runEra(ctx: EraContext, sub: string, imgDir = ERA_IMG_DIR): Promise<void> {
  if (sub !== "zhvishu") {
    await ctx.replyHidden(
      `❓ \`era ${sub}\` isn't a thing. Did you mean \`${ctx.commandPrefix}era zhvishu\`?`,
    );
    return;
  }

  const picked = await pickRandomImage(imgDir);
  if (!picked) {
    await ctx.replyHidden(
      "❌ Nothing in `era_img/` yet — drop an image in that folder at the repo root and try again.",
    );
    return;
  }

  try {
    const file = await loadImageFile(imgDir, picked);
    await ctx.attach("", [file]);
  } catch (e) {
    await ctx.replyHidden(`❌ Couldn't read that image — ${String(e)}`);
  }
}
