# era_img

Drop images here (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) and the bot's
`!era zhvishu` prefix command picks one at random and posts it in the channel
it was run in.

This folder is gitignored on purpose (see `.gitignore`) — only this README
is tracked, so nobody accidentally commits personal images. The bot resolves
the folder relative to the repo root, so it works the same in dev
(`npm run dev:bot`) and in the Docker image; set `ERA_IMG_DIR` to point
somewhere else if you'd rather keep the images outside the repo entirely.

If the folder is empty (or missing), `!era zhvishu` just replies saying so
instead of failing.
