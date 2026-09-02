import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 CLI configuration.
 *
 * - `directUrl` lives here (not in schema.prisma anymore): pooled providers
 *   such as Neon / Vercel Postgres expose a pooled URL for the serverless
 *   app and a direct, non-pooled URL for migrations. Set both to the same
 *   value when running against plain PostgreSQL (local dev, Docker).
 * - Loaded by every `prisma` CLI invocation; the runtime client does not
 *   read this file — the dashboard passes DATABASE_URL to the pg driver
 *   adapter itself (apps/dashboard/lib/prisma.ts).
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
  },
});
