import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@monarch/shared",
    "@monarch/schemas",
    "@monarch/validation",
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
};

export default nextConfig;
