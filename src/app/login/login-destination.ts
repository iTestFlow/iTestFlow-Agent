const DEFAULT_LOGIN_DESTINATION = "/dashboards"

export function resolveLoginDestination(nextParam: string | null) {
  // Aligned with the server-side safeReturnTo (jira-oauth-state.ts): reject
  // backslashes and percent-encoded path separators too — WHATWG URL
  // resolution treats "/\" like "//", which would leave the app's origin.
  const isSafeInAppPath =
    nextParam !== null &&
    nextParam.startsWith("/") &&
    !nextParam.startsWith("//") &&
    !nextParam.includes("\\") &&
    !/%(?:2f|5c)/i.test(nextParam)

  // Never bounce back to the login route itself (a crafted next=/login would otherwise
  // navigate straight back here after a successful sign-in).
  const isLoginPath =
    nextParam === "/login" ||
    (nextParam?.startsWith("/login?") ?? false) ||
    (nextParam?.startsWith("/login/") ?? false)

  if (!isSafeInAppPath || nextParam === "/" || isLoginPath) {
    return DEFAULT_LOGIN_DESTINATION
  }

  return nextParam
}
