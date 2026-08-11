/**
 * Compile the only dynamic API reads the model may perform without a catalog
 * operation. Requiring an explicit GET/HEAD token prevents a vague natural
 * step from turning into endpoint guessing.
 */
export function extractExplicitApiReadPaths(...sources: Array<string | null | undefined>): Set<string> {
  const paths = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(/\b(?:GET|HEAD)\s+((?:\/|\.\/)[^\s`"'<>]+)/gi)) {
      const trimmed = trimTrailingPunctuation(match[1]);
      if (trimmed && isSafeRelativePath(trimmed)) paths.add(normalizeRelativePath(trimmed));
    }
  }
  return paths;
}

function trimTrailingPunctuation(value: string) {
  return value.replace(/[),.;:\]}]+$/g, "");
}

function isSafeRelativePath(value: string) {
  if (value.startsWith("//")) return false;
  try {
    return new URL(value, "https://configured.invalid/").origin === "https://configured.invalid";
  } catch {
    return false;
  }
}

function normalizeRelativePath(value: string) {
  const url = new URL(value, "https://configured.invalid/");
  return `${url.pathname}${url.search}`;
}
