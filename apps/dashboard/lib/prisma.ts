import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { env } from "./env";

/**
 * Prisma client singleton (Prisma 7, engine-free: query compiler + pg driver
 * adapter — no Rust engine binaries to ship, which also keeps Vercel
 * serverless cold starts small).
 *
 * The adapter owns the connection: DATABASE_URL is passed here, never read
 * from the schema. `max: 1` caps each serverless instance at a single
 * backend connection — behind a pooled endpoint (Neon / Vercel Postgres
 * pgbouncer) this avoids connection exhaustion when lambdas scale out.
 *
 * The globalThis cache survives Next.js dev HMR reloads, so we never stack
 * up connection pools per reload.
 */

const globalForPrisma = globalThis as unknown as { __monarchPrisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set — the Prisma store requires PostgreSQL.");
  }
  if (!globalForPrisma.__monarchPrisma) {
    globalForPrisma.__monarchPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: env.databaseUrl, max: 1 }),
    });
  }
  return globalForPrisma.__monarchPrisma;
}
