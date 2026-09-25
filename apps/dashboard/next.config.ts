import type { NextConfig } from "next";

/**
 * Security headers, served by `next start` / Vercel / the Docker image — and
 * by `next dev`, so a problem here shows up locally rather than on deploy.
 *
 * The Content-Security-Policy is deliberately one that this app can actually
 * live with:
 *
 *  - `script-src … 'unsafe-inline'` is required by the App Router itself,
 *    which streams the RSC payload through inline `self.__next_f.push(…)`
 *    scripts. Tightening it means a per-request nonce
 *    (`csp: { nonce: true }` here + a nonce in the header from middleware),
 *    not just deleting 'unsafe-inline' — a build has to be clicked through
 *    when that change is made, so it is tracked as a follow-up rather than
 *    done by a header commit.
 *  - `style-src … 'unsafe-inline'` likewise: React writes `style="…"` for the
 *    drag-and-drop preview transforms.
 *  - `img-src` accepts any https host on purpose — the Embed/Message preview
 *    renders the thumbnail and image URLs a design points at, exactly as
 *    Discord would. (`next/image` is separately restricted to cdn.discordapp
 *    via `images.remotePatterns` below.)
 *
 * What it does buy: nothing the dashboard loads can come from a third-party
 * origin (no injected analytics, no exfiltration through `<img src>` to an
 * attacker's host — `connect-src 'self'` covers fetch/websocket), nothing can
 * frame Monarch (`frame-ancestors 'none'`), no `<base>` hijack, no plugins,
 * and form posts stay same-origin.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
].join("; ");

/**
 * `X-Frame-Options` is the belt to `frame-ancestors`' braces: it is still what
 * older browsers and some webviews honour. `Referrer-Policy` matters because
 * the dashboard's URLs carry guild snowflakes, and `Permissions-Policy` keeps
 * a design preview from ever being a reason to ask for a camera or microphone.
 */
const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), display-capture=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // Fingerprinting the framework is the least useful thing a response can do.
  poweredByHeader: false,
  // `npm run lint` is the gate, not the build: it covers every workspace
  // (Next's build-time lint only looks at app/pages/components/lib) and it
  // fails with the repo's own config instead of inside a deploy build.
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: [
    "@monarch/shared",
    "@monarch/schemas",
    "@monarch/validation",
    "@monarch/analyzer",
    "@monarch/design-engine",
    "@monarch/renderer",
    "@monarch/discord",
  ],
  // The dashboard may run behind a proxied preview host in development.
  allowedDevOrigins: ["*.e2b.app"],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "cdn.discordapp.com" }],
  },
  // Prisma 7 runtime + pg driver adapter must stay external (server-side
  // only, resolved from node_modules at runtime instead of bundled).
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  // Workspace packages use ESM-style ".js" specifiers in TS source.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"],
  },
  async headers() {
    return [
      {
        // Every response the dashboard produces, API routes included. One
        // rule on purpose: per-path overrides would duplicate header names
        // rather than replace them, and `strict-origin-when-cross-origin`
        // already keeps the code-bearing /api/auth/callback URL from leaving
        // as a referrer on the cross-origin hops (plus `state`, see B.2).
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
