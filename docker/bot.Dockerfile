FROM node:22-alpine AS base
WORKDIR /app
# The audio stack runs in *this* process: yt-dlp fetches, ffmpeg decodes to
# PCM, @discordjs/voice encodes Opus and owns the voice socket. ffmpeg is
# optional in the code (Opus passthrough works without it) but it is what
# makes volume and non-Opus sources work, so ship it. If `apk add yt-dlp`
# ever disappears from Alpine's repos, drop it from this line — the bot then
# downloads its own copy into .monarch/bin on first /music play.
RUN apk add --no-cache ffmpeg yt-dlp
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
