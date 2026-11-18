import type { NextConfig } from "next";

/**
 * Content security policy for every page. Next.js writes small inline scripts into each page, so scripts need
 * 'unsafe-inline' (a nonce setup is a later improvement). 'unsafe-eval' is added ONLY for `next dev`.
 * form-action is deliberately NOT set: after a payment click our server redirects the browser to the wallet's
 * consent page, and some browsers apply form-action to that redirect.
 */
export function contentSecurityPolicy(production: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${production ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${production ? "" : " ws: wss:"}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const nextConfig: NextConfig = {
  // The bundle test builds into its own folder so it never disturbs a running dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // better-sqlite3 is a native module: keep it out of the bundle.
  serverExternalPackages: ["better-sqlite3", "@interledger/open-payments"],
  // Pin the project root (there is another package-lock.json higher up in the home folder).
  turbopack: { root: process.cwd() },
  poweredByHeader: false,
  async headers() {
    const production = process.env.NODE_ENV === "production";
    return [
      {
        // Basic security headers on every page and route.
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy(production) },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
      {
        // Public receipt pages: never cached, never indexed, never leak the URL as a referrer (the route sets these too).
        source: "/r/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
