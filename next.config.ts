import type { NextConfig } from "next";

/**
 * cacheComponents/partialPrefetching are intentionally disabled: every page in
 * this app is per-user and permission-filtered, so the classic dynamic model
 * (reading cookies() makes a route dynamic) is simpler and safer. See
 * docs/adr/0002-nextjs-rendering-model.md before re-enabling.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  cacheComponents: false,
  poweredByHeader: false,
  serverExternalPackages: ["embedded-postgres", "unpdf", "mammoth", "@electric-sql/pglite"],
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
