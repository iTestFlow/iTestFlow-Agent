const DEFAULT_LOGIN_DESTINATION = "/dashboards"

export function resolveLoginDestination(nextParam: string | null) {
  const isSafeInAppPath =
    nextParam !== null &&
    nextParam.startsWith("/") &&
    !nextParam.startsWith("//")

  if (!isSafeInAppPath || nextParam === "/") {
    return DEFAULT_LOGIN_DESTINATION
  }

  return nextParam
}
