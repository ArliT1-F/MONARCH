-- AlterTable
-- Confessions: the guild's anonymous confession channel (NULL = off) and its
-- optional staff-only log channel. Written by the bot through
-- /api/internal/guilds/:id/confession, outside the designated-channels
-- settings flow (same rule as commandPrefix above).
ALTER TABLE "GuildSettings" ADD COLUMN "confessionChannelId" TEXT;
ALTER TABLE "GuildSettings" ADD COLUMN "confessionLogChannelId" TEXT;
