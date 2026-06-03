import "server-only";

export function normalizeProviderBaseUrl(
  baseUrl: string | undefined,
  fallbackBaseUrl: string,
  options: { requiredPath?: string } = {},
) {
  const root = (baseUrl?.trim() || fallbackBaseUrl).replace(/\/+$/, "");
  const requiredPath = options.requiredPath ? normalizeRequiredPath(options.requiredPath) : "";

  if (!requiredPath || root.endsWith(requiredPath)) return root;
  return `${root}${requiredPath}`;
}

function normalizeRequiredPath(path: string) {
  const trimmed = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `/${trimmed}` : "";
}
