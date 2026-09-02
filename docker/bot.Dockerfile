FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/bot/package.json apps/bot/
COPY packages/shared/package.json packages/shared/
COPY packages/schemas/package.json packages/schemas/
COPY packages/validation/package.json packages/validation/
COPY packages/design-engine/package.json packages/design-engine/
COPY packages/renderer/package.json packages/renderer/
COPY packages/discord/package.json packages/discord/
# Prisma schema + config for the root postinstall hook (prisma generate).
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm install --no-audit --no-fund

COPY . .
CMD ["npm", "run", "start", "--workspace", "@monarch/bot"]
