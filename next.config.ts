import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

export default function nextConfig(phase: string): NextConfig {
  return {
    // Keep dev output isolated so a validation build cannot invalidate HMR chunks.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
    // pg is a Node-only runtime dependency; never bundle it.
    serverExternalPackages: ["pg", "pg-connection-string"],
    turbopack: {
      // Next 15 Turbopack does not resolve the packages' style-only exports on Windows.
      resolveAlias: {
        "tw-animate-css": "./node_modules/tw-animate-css/dist/tw-animate.css",
        "shadcn/tailwind.css": "./node_modules/shadcn/dist/tailwind.css",
      },
    },
  };
}
