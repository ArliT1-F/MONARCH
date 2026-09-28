ALTER TABLE "GuildSettings" ADD COLUMN "jailChannelId" TEXT, ADD COLUMN "jailRoleId" TEXT, ADD COLUMN "jailStaffRoles" JSONB;
CREATE TABLE "JailEntry" (
  "guildId" TEXT NOT NULL, "userId" TEXT NOT NULL, "until" TIMESTAMP(3),
  "jailedBy" TEXT NOT NULL, "style" TEXT NOT NULL, "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JailEntry_pkey" PRIMARY KEY ("guildId","userId")
);
CREATE INDEX "JailEntry_guildId_until_idx" ON "JailEntry"("guildId","until");
ALTER TABLE "JailEntry" ADD CONSTRAINT "JailEntry_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
