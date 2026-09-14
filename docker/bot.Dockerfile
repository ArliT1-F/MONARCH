FROM node:22-alpine AS base
WORKDIR /app
# No ffmpeg, no yt-dlp, no opus/libsodium: audio decoding, Opus encoding and the
# Discord voice socket all live in the Lavalink node (docker/docker-compose.yml
# service `lavalink`), which the bot drives over websocket + REST. This image is
# a plain Node process — nothing native to install and nothing that needs UDP
# egress, so /music works from any host that can reach a node.
COPY package.json package-lock.json* ./
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/bot/package.json apps/bot/
COPY packages/shared/package.json packages/shared/
COPY packages/schemas/package.json packages/schemas/
COPY packages/validation/package.json packages/validation/
COPY packages/analyzer/package.json packages/analyzer/
COPY packages/design-engine/package.json packages/design-engine/
COPY packages/renderer/package.json packages/renderer/
COPY packages/discord/package.json packages/discord/
COPY packages/music/package.json packages/music/
# Prisma schema + config for the root postinstall hook (prisma generate).
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --no-audit --no-fund

COPY . .
# Exec node directly so the bot *is* PID 1 and receives the runtime's SIGTERM.
# `npm run start` swallows SIGTERM, exits with 143 (which reads like a crash in
# deploy logs) and never forwards the signal, so the bot would be SIGKILLed
# mid-session instead of closing its gateway connection — see the shutdown
# handler in apps/bot/src/index.ts.
CMD ["node", "--import", "tsx", "apps/bot/src/index.ts"]
