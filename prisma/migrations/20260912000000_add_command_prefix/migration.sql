-- AlterTable
-- Prefix commands: a guild's text-command prefix (NULL = the shared default
-- "!"). Written by the bot through /api/internal/guilds/:id/prefix, outside
-- the designated-channels settings flow.
ALTER TABLE "GuildSettings" ADD COLUMN "commandPrefix" TEXT;
