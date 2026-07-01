const DEFAULT_LOGIN_DESTINATION = "/dashboards"

export function resolveLoginDestination(nextParam: string | null) {
  const isSafeInAppPath =
    nextParam !== null &&
    nextParam.startsWith("/") &&
    !nextParam.startsWith("//")

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
