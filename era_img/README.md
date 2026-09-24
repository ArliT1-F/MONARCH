# era_img

Hidden prefix commands — not on `!help`, `/monarch help`, or the dashboard
Help page. They answer only the **server owner** and the **bot owner**
(`MONARCH_OWNER_USER_ID`). Anyone else is ignored, the same as an unknown
`!word`.

Drop images here (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`). `!era zhvishu`
picks one at random and posts it in the channel, using the name and avatar of
Discord user `1484616497568550985` (a webhook — the bot needs **Manage
Webhooks** in that channel). Right before the photo it sends one saved line,
picked at random, as `<message> @whoever-ran-it`.

| Command              | What it does                           |
| -------------------- | -------------------------------------- |
| `!era zhvishu`       | Random saved line, then a random photo |
| `!era add <message>` | Save a line for this server            |
| `!era messages`      | Show this server's saved lines         |
| `!era photos`        | Show the photos in this folder         |
| `!era remove <n>`    | Drop line number `n`                   |

Saved lines live in `messages.json` in this folder, **per server**. This
folder is gitignored on purpose (see `.gitignore`) — only this README is
tracked, so nobody accidentally commits personal images or lines. The bot
resolves the folder relative to the repo root, so it works the same in dev
(`npm run dev:bot`) and in the Docker image; set `ERA_IMG_DIR` to point
somewhere else if you'd rather keep the images outside the repo entirely.

Replies for `add` / `messages` / `photos` / `remove` are DMed when Discord
allows it, so the list doesn't land in the channel. If DMs are closed they
fall back to the channel.

If the folder is empty (or missing), `!era zhvishu` just says so instead of
failing. A restart doesn't clear the saved lines — they're the JSON file.
