CREATE TABLE "CatCardPull" (
    "catId" TEXT NOT NULL,
    "pullCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CatCardPull_pkey" PRIMARY KEY ("catId")
);

CREATE TABLE "CatAdoption" (
    "guildId" TEXT NOT NULL,
    "catId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CatAdoption_pkey" PRIMARY KEY ("guildId", "catId")
);

CREATE INDEX "CatAdoption_guildId_userId_idx" ON "CatAdoption"("guildId", "userId");
