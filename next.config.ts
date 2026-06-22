import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg is a Node-only runtime dependency; never bundle it.
  serverExternalPackages: ["pg", "pg-connection-string"],
};

export default nextConfig;
