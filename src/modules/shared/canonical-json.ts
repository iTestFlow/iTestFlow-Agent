import { createHash } from "node:crypto";

/**
 * Deterministic JSON canonicalization shared by snapshot hashing, OpenAPI
 * contract revision hashing, and the agent loop's stable fingerprints/prompt
 * rendering. Keys are sorted by code point (never locale-dependent) so equal
 * payloads hash equally on every machine.
 */
export function canonicalJson(value: unknown): string {
  try {
    return JSON.stringify(sortJsonDeep(value)) ?? "null";
  } catch {
    return "<unserializable>";
  }
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sortJsonDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortJsonDeep(entry)]),
    );
  }
  return value;
}
