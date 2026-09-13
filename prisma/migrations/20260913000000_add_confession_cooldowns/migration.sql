-- Confession cooldowns: one row per Discord user, global across every server.
-- nextAllowedAt is the earliest moment they may confess again — a 6h window
-- (CONFESSION_COOLDOWN_MS in @monarch/shared), claimed by the bot through
-- /api/internal/users/:id/confession-cooldown just before a confession is
-- posted and released again when the post fails, so a deleted channel can't
-- lock somebody out for six hours.
--
-- No FK to "User": confessors are anonymous by design and rarely sign in to
-- the dashboard, so there is no User row to reference. The row holds the user
-- id and a timestamp only — never the confession text, never a channel.
--
-- Apply with `npm run db:migrate` (prisma migrate deploy).

-- CreateTable
CREATE TABLE "ConfessionCooldown" (
    "userId" TEXT NOT NULL,
    "nextAllowedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfessionCooldown_pkey" PRIMARY KEY ("userId")
);
