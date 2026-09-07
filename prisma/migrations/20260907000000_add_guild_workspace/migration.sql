-- Add per-guild content workspace (Embed Builder / Message Designer designs).
-- Apply with `npm run db:migrate` (prisma migrate deploy).

-- CreateTable
CREATE TABLE "GuildWorkspace" (
    "guildId" TEXT NOT NULL,
    "embed" JSONB,
    "message" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildWorkspace_pkey" PRIMARY KEY ("guildId")
);

-- AddForeignKey
ALTER TABLE "GuildWorkspace" ADD CONSTRAINT "GuildWorkspace_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
