import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg is a Node-only runtime dependency; never bundle it.
  serverExternalPackages: ["pg", "pg-connection-string"],
};

// Run middleware on the Node.js runtime (it only checks a session cookie) so Next
// produces no Edge bundle — an Edge bundle otherwise tries to bundle pg via
// instrumentation and fails. `nodeMiddleware` is supported by Next 15.5 at runtime
// but is not yet present in the exported config types.
(nextConfig as { experimental?: Record<string, unknown> }).experimental = {
  nodeMiddleware: true,
};

export default nextConfig;
