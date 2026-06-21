import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/modules/auth/session-cookie";

/**
 * Auth gate: page navigations require a session cookie, otherwise redirect to
 * /login. Login is the entry point for the hosted multi-user app.
 *
 * This is a presence check only (Edge runtime cannot reach the database); the
 * session is fully validated by requireSession() in API routes / server code.
 * API routes are excluded here — they return 401 (JSON), not a redirect.
 */
const PUBLIC_PATHS = ["/login"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  runtime: "nodejs",
  // Run on page routes only: skip API, Next internals, and static assets.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|brand|.*\\.).*)"],
};
