/**
 * Redacts Azure DevOps credentials from an error message before it is surfaced to a
 * client or log. Azure errors are interpolated into thrown messages and could embed an
 * Authorization header or PAT; strip those so they never reach a response body or log.
 */
export function sanitizeAzureError(value: string) {
  return value
    .replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "Authorization: Basic [redacted]")
    .replace(/Basic\s+[A-Za-z0-9+/=]{20,}/g, "Basic [redacted]")
    .replace(/personalAccessToken["'\s:=]+[^"',\s}]+/gi, "personalAccessToken: [redacted]")
    .replace(/pat["'\s:=]+[^"',\s}]+/gi, "PAT: [redacted]");
}
