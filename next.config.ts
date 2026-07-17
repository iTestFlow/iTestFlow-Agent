import type { NextConfig } from "next";

const devWatchIgnored =
  /(^|[\\/])(?:\.git|\.next|node_modules)([\\/]|$)|^[A-Za-z]:[\\/](?:DumpStack\.log\.tmp|System Volume Information|hiberfil\.sys|pagefile\.sys|swapfile\.sys)$/i;

const nextConfig: NextConfig = {
  // pg is a Node-only runtime dependency; never bundle it. The transformers.js
  // stack ships native ONNX runtime binaries that webpack must not touch either.
  serverExternalPackages: ["pg", "pg-connection-string", "@huggingface/transformers", "onnxruntime-node"],
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

export default nextConfig;
