"use client";

import { Analytics } from "@vercel/analytics/next";

/**
 * Vercel Web Analytics – one line in the root layout, pageviews are
 * tracked automatically. The component is a no-op in development and is
 * disabled outright when `NEXT_PUBLIC_ANALYTICS_DISABLED=1`, so CI builds
 * and opt-out deployments ship without the tracking script.
 *
 * Set `NEXT_PUBLIC_ANALYTICS_DISABLED=1` to keep analytics out of the
 * client bundle entirely (privacy-sensitive forks, EU-only deployments,
 * smoke tests). Set it on the Vercel project or in `apps/dashboard/.env.local`.
 */
export function VercelAnalytics() {
  if (process.env.NEXT_PUBLIC_ANALYTICS_DISABLED === "1") return null;
  return <Analytics />;
}