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

const TEST_PLANS_LICENSE_MESSAGE =
  "Your Azure DevOps account isn’t licensed to use Test Plans. Ask an Azure DevOps administrator to assign Basic + Test Plans or Visual Studio Enterprise access, then try again.";

const TEST_PLANS_ACCESS_MESSAGE =
  "You don’t have access to Azure Test Plans for this project. Ask an Azure DevOps administrator to grant the required license and project permissions. If you use a PAT, make sure it includes the Test Management scope, then try again.";

/**
 * Converts an Azure DevOps HTTP failure into text that is safe and useful in any
 * client-facing surface. Test Plans access failures get actionable guidance rather
 * than Azure's exception JSON; other failures retain Azure's message without the
 * response envelope.
 */
export function formatAzureDevOpsError(status: number, responseBody: string, requestPath = "") {
  const safeBody = sanitizeAzureError(responseBody).trim();
  const azureMessage = extractAzureErrorMessage(safeBody);
  const searchableError = `${safeBody} ${azureMessage ?? ""}`.toLowerCase();

  if (status === 403 && isTestPlansLicenseError(searchableError)) {
    return TEST_PLANS_LICENSE_MESSAGE;
  }

  if (status === 403 && isTestPlansRequest(requestPath)) {
    return TEST_PLANS_ACCESS_MESSAGE;
  }

  if (status === 403) {
    return "Azure DevOps denied this request. Ask an Azure DevOps administrator to check your project permissions and Personal Access Token scopes, then try again.";
  }

  if (status === 401) {
    return "Azure DevOps authentication failed. Check that your Personal Access Token is valid and has not expired, then sign in again.";
  }

  const detail = azureMessage ?? plainTextExcerpt(safeBody);
  return detail
    ? `Azure DevOps request failed (${status}): ${detail}`
    : `Azure DevOps request failed (${status}). Please try again.`;
}

function extractAzureErrorMessage(value: string) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { message?: unknown };
    return typeof parsed.message === "string" && parsed.message.trim()
      ? parsed.message.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function isTestPlansLicenseError(value: string) {
  return value.includes("tf400409")
    || value.includes("missinglicenseexception")
    || (
      value.includes("licensing rights")
      && (value.includes("test execution") || value.includes("test plans"))
    );
}

function isTestPlansRequest(path: string) {
  return /\/_apis\/(?:testplan|test)(?:\/|\?|$)/i.test(path);
}

function plainTextExcerpt(value: string) {
  if (!value || value.startsWith("<")) return undefined;
  return value.replace(/\s+/g, " ").slice(0, 500);
}
