import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module: keep it out of the bundle.
  serverExternalPackages: ["better-sqlite3"],
  // Pin the project root (there is another package-lock.json higher up in the home folder).
  turbopack: { root: process.cwd() },
};

export default nextConfig;
