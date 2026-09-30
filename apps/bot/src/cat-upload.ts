import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Message } from "discord.js";
import { CAT_IMAGE_DIRECTORY, CAT_RARITIES } from "./cat-cards.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

interface PendingUpload {
  folder: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Owner-only, DM-only, one-image upload flow for adding cards to the catalog. */
export class CatUploadManager {
  private pending: PendingUpload | null = null;

  constructor(
    private readonly ownerUserId: string | null,
    private readonly directory = CAT_IMAGE_DIRECTORY,
    private readonly timeoutMs = UPLOAD_TIMEOUT_MS,
  ) {}

  /** Intercepts only cat-management commands in servers; normal !cat rolls remain public. */
  async handleGuildCommand(message: Message<true>): Promise<boolean> {
    const command = parseAddCommand(message.content);
    if (!command) return false;
    if (message.author.id !== this.ownerUserId) {
      await message.reply({ content: "🔒 Cat uploads are owner-only; use `!help cat` for card details." });
      return true;
    }
    await message.reply({ content: "📩 Send `!cat add <rarity>` to me in DMs to upload a cat." });
    return true;
  }

  /** Returns true when this DM belongs to the cat upload flow. */
  async handleDirectMessage(message: Message): Promise<boolean> {
    const content = message.content.trim();
    const add = parseAddCommand(content);
    const cancel = /^!(?:cat|c)\s+cancel$/i.test(content);
    const isOwner = Boolean(this.ownerUserId && message.author.id === this.ownerUserId);

    if (add) {
      if (!isOwner) {
        await message.reply("🔒 Cat uploads are reserved for the bot owner.");
        return true;
      }
      const rarity = CAT_RARITIES.find((item) => item.folder === add.folder);
      if (!rarity) {
        await message.reply(`❓ Unknown rarity. Use one of: ${CAT_RARITIES.map((item) => item.label.toLowerCase()).join(", ")}.`);
        return true;
      }
      this.clearPending();
      const timer = setTimeout(() => {
        this.pending = null;
        void message.reply("⌛ Cat upload timed out. Start again with `!cat add <rarity>`.").catch(() => {});
      }, this.timeoutMs);
      timer.unref?.();
      this.pending = { folder: rarity.folder, timer };
      await message.reply(`🐾 Ready for a **${rarity.label}** cat. Upload one image here now, or send \`!cat cancel\`.`);
      return true;
    }

    if (cancel && isOwner) {
      if (!this.pending) await message.reply("No cat upload is waiting.");
      else {
        this.clearPending();
        await message.reply("Cat upload cancelled.");
      }
      return true;
    }

    if (!this.pending || !isOwner) return false;
    if (message.attachments.size === 0) {
      await message.reply("Still waiting for an image. Send one attachment or `!cat cancel`.");
      return true;
    }

    const attachment = message.attachments.first();
    if (!attachment) return true;
    const extension = path.extname(attachment.name ?? "").toLowerCase();
    if (!(extension in IMAGE_TYPES) || (attachment.contentType && !attachment.contentType.startsWith("image/"))) {
      await message.reply("That file type isn't supported. Send a JPG, PNG, GIF, or WEBP image.");
      return true;
    }
    if (attachment.size > MAX_IMAGE_BYTES) {
      await message.reply("That image is over the 10 MB limit. Send a smaller one.");
      return true;
    }

    try {
      const url = new URL(attachment.url);
      if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) {
        await message.reply("I can only download attachments hosted by Discord.");
        return true;
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`download returned ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) {
        await message.reply("That image is empty or over the 10 MB limit.");
        return true;
      }

      const pending = this.pending;
      if (!pending) {
        await message.reply("That upload request expired. Start again with `!cat add <rarity>`.");
        return true;
      }
      const folder = path.join(this.directory, pending.folder);
      await fs.mkdir(folder, { recursive: true });
      const originalStem = path.basename(attachment.name ?? "cat", extension)
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}_ -]/gu, "")
        .trim()
        .replace(/[\s-]+/g, "_")
        .slice(0, 60);
      const stem = originalStem || "cat";
      let filename = `${stem}${extension}`;
      let destination = path.join(folder, filename);
      try {
        await fs.writeFile(destination, data, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        filename = `${stem}-${randomUUID().slice(0, 8)}${extension}`;
        destination = path.join(folder, filename);
        await fs.writeFile(destination, data, { flag: "wx" });
      }
      const rarity = CAT_RARITIES.find((item) => item.folder === pending.folder)!;
      this.clearPending();
      await message.reply(`✅ Added **${path.basename(filename, extension)}** to **${rarity.label}** (${rarity.rate}% drop rate).`);
      return true;
    } catch {
      await message.reply("Couldn't save that image. The upload is still waiting—try again or send `!cat cancel`.");
      return true;
    }
  }

  private clearPending(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }
}

function parseAddCommand(content: string): { folder: string } | null {
  const match = /^!(?:cat|c)\s+add\s+([\p{L}\p{N}.-]+)$/iu.exec(content.trim());
  if (!match) return null;
  const entered = match[1]!.toLowerCase();
  const rarity = CAT_RARITIES.find(
    (item) => item.folder.toLowerCase() === entered || item.label.toLowerCase() === entered,
  );
  return { folder: rarity?.folder ?? entered };
}
