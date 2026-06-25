import type { NextConfig } from "next";

const devWatchIgnored =
  /(^|[\\/])(?:\.git|\.next|node_modules)([\\/]|$)|^[A-Za-z]:[\\/](?:DumpStack\.log\.tmp|System Volume Information|hiberfil\.sys|pagefile\.sys|swapfile\.sys)$/i;

const nextConfig: NextConfig = {
  // pg is a Node-only runtime dependency; never bundle it.
  serverExternalPackages: ["pg", "pg-connection-string"],
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
