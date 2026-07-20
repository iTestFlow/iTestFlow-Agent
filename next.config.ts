import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const devWatchIgnored =
  /(^|[\\/])(?:\.git|\.next|node_modules)([\\/]|$)|^[A-Za-z]:[\\/](?:DumpStack\.log\.tmp|System Volume Information|hiberfil\.sys|pagefile\.sys|swapfile\.sys)$/i;

export default function nextConfig(phase: string): NextConfig {
  return {
    // Keep dev output isolated so a validation build cannot invalidate HMR chunks.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
    // pg is a Node-only runtime dependency; never bundle it. The transformers.js
    // stack ships native ONNX runtime binaries that webpack must not touch either.
    serverExternalPackages: ["pg", "pg-connection-string", "@huggingface/transformers", "onnxruntime-node"],
    turbopack: {
      // Next 15 Turbopack does not resolve the packages' style-only exports on Windows.
      resolveAlias: {
        "tw-animate-css": "./node_modules/tw-animate-css/dist/tw-animate.css",
        "shadcn/tailwind.css": "./node_modules/shadcn/dist/tailwind.css",
      },
    },
    webpack: (config, { dev }) => {
      if (dev) {
        config.watchOptions = {
          ...(config.watchOptions ?? {}),
          ignored: devWatchIgnored,
        };
      }
      return config;
    },
  };
}
