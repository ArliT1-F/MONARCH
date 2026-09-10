-- AlterTable
-- Design Analyzer (FEATURE 9): check ids the guild marked "intentional"
-- (JSON array of stable analyzer check ids), managed outside the
-- designated-channels settings flow.
ALTER TABLE "GuildSettings" ADD COLUMN "analyzerDismissed" JSONB;
