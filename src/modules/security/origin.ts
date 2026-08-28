import "server-only";

/**
 * Login-CSRF guard for JSON credential routes: when the browser sends an
 * Origin header it must match the request host. Requests without an Origin
 * header pass — the guard only rejects a provably cross-site submission
 * (including the opaque "null" origin, which fails closed).
 */
export function isCrossOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("host");
  if (!host) return true;
  try {
    return new URL(origin).host.toLowerCase() !== host.trim().toLowerCase();
  } catch {
    return true;
  }
}
