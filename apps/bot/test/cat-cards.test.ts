import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatCards, CAT_RARITIES, shortCardKey, type CatCardStore } from "../src/cat-cards.js";

const tempDirs: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "monarch-cat-cards-"));
  tempDirs.push(root);
  for (const tier of CAT_RARITIES) await mkdir(path.join(root, tier.folder));
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fakeContext() {
  return {
    replyHidden: vi.fn(async () => undefined),
    replyEmbedsWithFiles: vi.fn(async () => undefined),
  } as never;
}

describe("CatCards", () => {
  it("discovers supported images and uses their filenames as card names", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "common-69.99", "Mister_Mittens.JPG"), "cat");
    await writeFile(path.join(root, "common-69.99", "notes.txt"), "not an image");
    const cards = await new CatCards(new MemoryStore(), root).catalog();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: "common-69.99/Mister_Mittens.JPG",
      name: "Mister Mittens",
      rarity: CAT_RARITIES[0],
    });
  });

  it("renormalizes the configured rates when some rarity folders are empty", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "rare-8", "rare-cat.png"), "cat");
    await writeFile(path.join(root, "legendary-0.2", "legendary-cat.png"), "cat");
    const random = vi.fn().mockReturnValueOnce(0.99).mockReturnValueOnce(0);
    const context = fakeContext();
    const cards = new CatCards(new MemoryStore(), root, random);
    await cards.roll(context);

    const call = (context as { replyEmbedsWithFiles: ReturnType<typeof vi.fn> }).replyEmbedsWithFiles.mock
      .calls[0]![0];
    expect(call[0].title).toBe("🐱 legendary cat");
  });

  it("adds a global pull total, attached image, and adoption button to the card embed", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "common-69.99", "paws.png"), "cat-bytes");
    const store = new MemoryStore();
    const context = fakeContext();
    await new CatCards(store, root, () => 0).roll(context);

    const [embeds, files, options] = (context as {
      replyEmbedsWithFiles: ReturnType<typeof vi.fn>;
    }).replyEmbedsWithFiles.mock.calls[0]!;
    expect(embeds[0]).toMatchObject({
      title: "🐱 paws",
      description: expect.stringContaining("Pulled globally:** 1"),
      image: { url: "attachment://cat-card.png" },
    });
    expect(files[0]).toMatchObject({ name: "cat-card.png", body: Buffer.from("cat-bytes").toString("base64") });
    expect(options.components[0].components[0].data.label).toBe("Adopt 🐾");
    expect(await store.incrementPull("common-69.99/paws.png")).toBe(2);
  });

  it("has stable compact button keys", () => {
    expect(shortCardKey("rare-8/a-cat.jpeg")).toBe(shortCardKey("rare-8/a-cat.jpeg"));
    expect(shortCardKey("rare-8/a-cat.jpeg")).not.toBe(shortCardKey("epic-1.8/a-cat.jpeg"));
  });
});

class MemoryStore implements CatCardStore {
  readonly pulls = new Map<string, number>();
  readonly adoptions = new Set<string>();

  async incrementPull(catId: string): Promise<number> {
    const count = (this.pulls.get(catId) ?? 0) + 1;
    this.pulls.set(catId, count);
    return count;
  }

  async adopt(guildId: string, catId: string, _userId: string): Promise<boolean> {
    const key = `${guildId}:${catId}`;
    if (this.adoptions.has(key)) return false;
    this.adoptions.add(key);
    return true;
  }
}
