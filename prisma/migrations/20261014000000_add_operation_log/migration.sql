CREATE TABLE "OperationLog" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "planDigest" TEXT,
    "stepResults" JSONB,
    "reconciledDesign" JSONB,
    "auditEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OperationLog_guildId_idx" ON "OperationLog"("guildId");
CREATE INDEX "OperationLog_idempotencyKey_idx" ON "OperationLog"("idempotencyKey");
CREATE INDEX "OperationLog_guildId_userId_idx" ON "OperationLog"("guildId", "userId");
