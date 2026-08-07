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
 * produces. Short values (< 4 chars) are excluded — scrubbing them would
 * mangle unrelated text while providing no real secrecy.
 */
export function buildScrubValues(secrets: ReadonlyMap<string, string>): string[] {
  const values = new Set<string>();
  for (const secret of secrets.values()) {
    if (secret.length < 4) continue;
    values.add(secret);
    values.add(encodeURIComponent(secret));
    values.add(Buffer.from(secret, "utf8").toString("base64"));
  }
  return [...values];
}
