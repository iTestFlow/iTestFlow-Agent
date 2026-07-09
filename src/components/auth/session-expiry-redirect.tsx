"use client";

import { useEffect } from "react";

/**
 * Global session-expiry handler.
 *
 * The auth middleware only checks that a session cookie is PRESENT (it runs before
 * the DB and can't validate the token), so a stale or expired cookie still lets a
 * protected page load — its API calls then fail with 401 "Authentication required".
 * Rather than surface a cryptic error toast, we intercept any 401 coming back from a
 * same-origin API call and send the user to /login, preserving where they were via a
 * `next` query param. This also covers normal mid-session expiry, not just the
 * stale-cookie case.
 *
 * We deliberately ignore 401s while already on /login (e.g. a wrong-PAT sign-in
 * attempt) so the login form can show its own error instead of looping.
 */
export function SessionExpiryRedirect() {
  useEffect(() => {
    const originalFetch = window.fetch.bind(window);
    let redirecting = false;

    window.fetch = async (...args: Parameters<typeof window.fetch>) => {
      const response = await originalFetch(...args);
      try {
        if (response.status === 401 && !redirecting && !window.location.pathname.startsWith("/login")) {
          const [input] = args;
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
          const sameOriginApi = url.startsWith("/api/") || url.startsWith(`${window.location.origin}/api/`);
          const integrationError = response.headers.get("x-itf-error-scope") === "integration";
          if (sameOriginApi && !integrationError) {
            redirecting = true;
            const next = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.assign(`/login?next=${next}`);
          }
        }
      } catch {
        // Never let session handling break the underlying request.
      }
      return response;
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return null;
}
