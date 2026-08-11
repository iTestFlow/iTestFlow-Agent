/**
 * {{secret:NAME}} placeholder handling — pure string logic, no crypto.
 *
 * Plans, step rows, agent transcripts, and reports only ever contain
 * placeholders. Substitution happens exclusively in worker memory immediately
 * before a validated action executes; buildScrubValues supplies the redaction
 * list applied to every string persisted afterwards (see output-scrubber in
 * integrations/browser-automation).
 */

export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

const PLACEHOLDER_REGEX = /\{\{secret:([A-Z][A-Z0-9_]{0,63})\}\}/g;

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/** Distinct secret names referenced by a single string, in order of appearance. */
export function extractSecretReferences(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_REGEX)) {
    const name = match[1];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export type SecretSubstitutionResult = {
  value: string;
  /** Referenced names that had no entry in the provided map. */
  missing: string[];
};

export function substituteSecretPlaceholders(
  text: string,
  secrets: ReadonlyMap<string, string>,
): SecretSubstitutionResult {
  const missing: string[] = [];
  const value = text.replace(PLACEHOLDER_REGEX, (placeholder, name: string) => {
    const secret = secrets.get(name);
    if (secret === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return placeholder;
    }
    return secret;
  });
  return { value, missing };
}

/**
 * Every representation of a secret value that must never appear in persisted
 * text: the raw value plus the encodings a browser or log line commonly
 * produces. Short values remain present; createScrubber matches them only at
 * token boundaries to avoid mangling ordinary words.
 */
export function buildScrubValues(secrets: ReadonlyMap<string, string>): string[] {
  return buildScrubValuesFromValues(secrets.values());
}

/**
 * Build scrub representations for arbitrary sensitive runtime values. Values
 * are retained by default, while callers may set a stricter minimum.
 */
export function buildScrubValuesFromValues(
  sensitiveValues: Iterable<string>,
  options: { minimumLength?: number } = {},
): string[] {
  const minimumLength = options.minimumLength ?? 1;
  const values = new Set<string>();
  for (const secret of sensitiveValues) {
    if (!secret || secret.length < minimumLength) continue;
    values.add(secret);
    values.add(encodeURIComponent(secret));
    values.add(Buffer.from(secret, "utf8").toString("base64"));
    // JSON.stringify escapes quotes, slashes, control characters, and newlines.
    // Store the inner representation so replacing it leaves surrounding JSON
    // string quotes intact and the persisted document remains parseable.
    const jsonEncoded = JSON.stringify(secret);
    if (jsonEncoded) values.add(jsonEncoded.slice(1, -1));
  }
  return [...values];
}
