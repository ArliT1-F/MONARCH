# Cat-card image catalog

Put one image per cat directly in its rarity folder. Supported formats: `.jpg`, `.jpeg`, `.png`, `.gif`, and `.webp`. The image filename (without its extension) becomes the displayed cat name; use names such as `little_mittens.jpg` or `Sir Pounce.png`. Keep filenames stable after launch: the folder plus filename is the cat's permanent card id for pull statistics and adoptions.

| Folder | Rarity | Drop rate |
| --- | --- | ---: |
| `common-69.99/` | Common | 69.99% |
| `uncommon-20/` | Uncommon | 20% |
| `rare-8/` | Rare | 8% |
| `epic-1.8/` | Epic | 1.8% |
| `legendary-0.2/` | Legendary | 0.2% |
| `mythic-0.01/` | Mythic | 0.01% |

Rates total 100%. Empty rarity folders are skipped and the remaining rates are renormalized, so the bot can be tested before every tier is populated. Within a tier, every image has an equal chance.

Only add images you own or have permission to use and redistribute. A public post or an image being easy to download does not automatically grant reuse rights. Keep any creator/source/license notes with your image collection.

The configured bot owner (`MONARCH_OWNER_USER_ID`) can also DM the bot `!cat add mythic` (or another rarity), then send one image attachment within 10 minutes. The bot saves it into the selected folder. Set `CAT_IMAGE_DIR` to a mounted persistent directory in container deployments; otherwise files added at runtime may be lost when the bot redeploys. The image must be at most 10 MB and use one of the supported formats above.
