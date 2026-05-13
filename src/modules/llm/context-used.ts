import { z } from "zod";

export const ContextUsedSchema = z.array(z.string()).default([]).transform(sanitizeContextUsed);

export function sanitizeContextUsed(values: string[]) {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter((value) => value && !isPromptContainerLabel(value))
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function isPromptContainerLabel(value: string) {
  return /^pasted\s+markdown(?:\(\d+\))?\.md$/i.test(value) || /^pasted\s+(?:text|file|content)/i.test(value);
}
