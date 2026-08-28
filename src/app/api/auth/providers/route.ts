import { NextResponse } from "next/server";

import { getEnabledLoginProviders, LOGIN_PROVIDER_LABELS } from "@/modules/auth/enabled-providers";
import { checkRateLimit, clientIp } from "@/modules/security/rate-limit";

export const runtime = "nodejs";

/**
 * Pre-auth provider picker for the login page. Returns the sign-in providers
 * this deployment enables, in display order — display data only. The picker is
 * convenience: the provider-specific auth routes re-check enablement and fail
 * closed. Lightly rate-limited per IP to blunt enumeration.
 */
export async function GET(request: Request) {
  const rate = await checkRateLimit(`providerlist:${clientIp(request)}`, 60, 5 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  try {
    const providers = (await getEnabledLoginProviders()).map((id) => ({ id, label: LOGIN_PROVIDER_LABELS[id] }));
    return NextResponse.json({ providers }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // Fail closed without turning the public picker into a 500 (database
    // outage or enablement drift after a clean boot).
    return NextResponse.json({ error: "Unable to load sign-in options. Try again later." }, { status: 503 });
  }
}
