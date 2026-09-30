import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type APIEmbed,
  type ButtonInteraction,
} from "discord.js";
import type { CommandContext, CommandFile } from "./context.js";

export const CAT_RARITIES = [
  { folder: "common-69.99", label: "Common", rate: 69.99, color: 0x95a5a6 },
  { folder: "uncommon-20", label: "Uncommon", rate: 20, color: 0x2ecc71 },
  { folder: "rare-8", label: "Rare", rate: 8, color: 0x3498db },
  { folder: "epic-1.8", label: "Epic", rate: 1.8, color: 0x9b59b6 },
  { folder: "legendary-0.2", label: "Legendary", rate: 0.2, color: 0xf1c40f },
  { folder: "mythic-0.01", label: "Mythic", rate: 0.01, color: 0xe84393 },
] as const;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const ADOPT_BUTTON_PREFIX = "cat-adopt:";
export const CAT_IMAGE_DIRECTORY = process.env.CAT_IMAGE_DIR
  ? path.resolve(process.env.CAT_IMAGE_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../cats");

export interface CatCard {
  /** Stable global catalog id, e.g. `common-70/ginger-cat.jpg`. */
  id: string;
  name: string;
  filename: string;
  path: string;
  rarity: (typeof CAT_RARITIES)[number];
}

export interface CatCardStore {
  incrementPull(catId: string): Promise<number>;
  adopt(guildId: string, catId: string, userId: string): Promise<boolean>;
}

/**
 * A deliberately simple fallback for local/dev runs without INTERNAL_API_TOKEN.
 * It is shared across guilds on this worker, but is lost on restart and isn't
 * shared across multiple bot workers; production should use internalCatCardStore.
 */
export class MemoryCatCardStore implements CatCardStore {
  private readonly pulls = new Map<string, number>();
  private readonly adoptions = new Set<string>();

  async incrementPull(catId: string): Promise<number> {
    const total = (this.pulls.get(catId) ?? 0) + 1;
    this.pulls.set(catId, total);
    return total;
  }

  async adopt(guildId: string, catId: string, userId: string): Promise<boolean> {
    const key = `${guildId}:${catId}`;
    if (this.adoptions.has(key)) return false;
    this.adoptions.add(key);
    return true;
  }
}

export function internalCatCardStore(appUrl: string, token: string): CatCardStore {
  const endpoint = `${appUrl.replace(/\/$/, "")}/api/internal/cats`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  return {
    async incrementPull(catId) {
      const response = await fetch(`${endpoint}/pulls`, {
        method: "POST",
        headers,
        body: JSON.stringify({ catId }),
      });
      if (!response.ok) throw new Error(`cat pull counter failed (${response.status})`);
      const body = (await response.json()) as { total?: unknown };
      if (typeof body.total !== "number" || !Number.isSafeInteger(body.total)) {
        throw new Error("cat pull counter returned an invalid total");
      }
      return body.total;
    },
    async adopt(guildId, catId, userId) {
      const response = await fetch(`${endpoint}/adoptions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ guildId, catId, userId }),
      });
      if (!response.ok) throw new Error(`cat adoption claim failed (${response.status})`);
      const body = (await response.json()) as { adopted?: unknown };
      return body.adopted === true;
    },
  };
}

export class CatCards {
  constructor(
    private readonly store: CatCardStore,
    private readonly directory = CAT_IMAGE_DIRECTORY,
    private readonly random = Math.random,
  ) {}

  async roll(ctx: CommandContext): Promise<void> {
    const cards = await this.catalog();
    if (cards.length === 0) {
      await ctx.replyHidden(
        "🐾 No cat pictures are in the catalog yet. Add an image to one of the `cats/` rarity folders and try again.",
      );
      return;
    }

    const card = this.choose(cards);
    const globalPulls = await this.store.incrementPull(card.id);
    const imageName = `cat-card${path.extname(card.filename).toLowerCase()}`;
    const file: CommandFile = {
      name: imageName,
      body: (await fs.readFile(card.path)).toString("base64"),
      encoding: "base64",
    };
    const embed = new EmbedBuilder()
      .setColor(card.rarity.color)
      .setTitle(`🐱 ${card.name}`)
      .setDescription(
        `**Rarity:** ${card.rarity.label}\n**Pulled globally:** ${globalPulls.toLocaleString()}`,
      )
      .setImage(`attachment://${imageName}`)
      .setFooter({ text: "Adopt this cat by pressing the button below!" });
    const buttonId = `${ADOPT_BUTTON_PREFIX}${shortCardKey(card.id)}`;
    const components = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(buttonId).setLabel("Adopt 🐾").setStyle(ButtonStyle.Primary),
      ),
    ];
    await ctx.replyEmbedsWithFiles([embed.toJSON() as APIEmbed], [file], { components });
  }

  async handleAdoption(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith(ADOPT_BUTTON_PREFIX)) return false;
    const key = interaction.customId.slice(ADOPT_BUTTON_PREFIX.length);
    const card = (await this.catalog()).find((item) => shortCardKey(item.id) === key);
    if (!card) {
      await interaction.reply({
        content: "🐾 I couldn't find that cat in the current catalog. The card may be from an old catalog version.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const adopted = await this.store.adopt(interaction.guildId ?? "", card.id, interaction.user.id);
    await interaction.reply({
      content: adopted
        ? `🎉 **${card.name}** is now yours! You adopted this cat in this server.`
        : `🐾 **${card.name}** has already been adopted in this server. Try \`!cat\` for another cat!`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  async catalog(): Promise<CatCard[]> {
    const cards: CatCard[] = [];
    for (const rarity of CAT_RARITIES) {
      const folder = path.join(this.directory, rarity.folder);
      let entries: string[];
      try {
        entries = await fs.readdir(folder);
      } catch {
        continue;
      }
      for (const filename of entries.sort((a, b) => a.localeCompare(b))) {
        if (filename.startsWith(".")) continue;
        if (!IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase())) continue;
        const imagePath = path.join(folder, filename);
        try {
          if (!(await fs.stat(imagePath)).isFile()) continue;
        } catch {
          continue;
        }
        const base = path.basename(filename, path.extname(filename));
        cards.push({
          id: `${rarity.folder}/${filename}`,
          name: base.replace(/[_-]+/g, " ").trim() || "Mystery Cat",
          filename,
          path: imagePath,
          rarity,
        });
      }
    }
    return cards;
  }

  private choose(cards: CatCard[]): CatCard {
    // Ignore empty rarity folders, then renormalize the remaining configured
    // rates. This lets the bot launch with a partially populated catalog.
    const byRarity = CAT_RARITIES.map((rarity) => ({
      rarity,
      cards: cards.filter((card) => card.rarity.folder === rarity.folder),
    })).filter((bucket) => bucket.cards.length > 0);
    const totalRate = byRarity.reduce((sum, bucket) => sum + bucket.rarity.rate, 0);
    let selection = this.random() * totalRate;
    let chosen = byRarity[byRarity.length - 1]!;
    for (const bucket of byRarity) {
      selection -= bucket.rarity.rate;
      if (selection < 0) {
        chosen = bucket;
        break;
      }
    }
    return chosen.cards[Math.floor(this.random() * chosen.cards.length)]!;
  }
}

export function shortCardKey(id: string): string {
  // Button custom ids must remain under Discord's 100-character limit even
  // when someone uses a long descriptive image filename. 80 hash bits make
  // catalog-key collisions negligible while keeping the component id compact.
  return createHash("sha256").update(id).digest("hex").slice(0, 20);
}
