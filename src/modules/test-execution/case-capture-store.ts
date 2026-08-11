import { collectSensitiveValues, isSensitiveKey } from "@/modules/shared/sensitive-data";

import {
  buildScrubValuesFromValues,
  substituteSecretPlaceholders,
} from "./secret-resolution";

export const MAX_CASE_CAPTURE_COUNT = 32;
export const MAX_CAPTURE_VALUE_BYTES = 4 * 1024;
export const MAX_CAPTURE_AGGREGATE_BYTES = 16 * 1024;

export type CaptureScalar = string | number | boolean | null;

export type RuntimeCapture = {
  name: string;
  value: CaptureScalar;
  sensitive: boolean;
  sourceLayer: "api" | "db";
};

export type RuntimeCaptureInput = Omit<RuntimeCapture, "value"> & { value: unknown };

export type PersistableCapture = {
  name: string;
  value: CaptureScalar | "<redacted>";
  sensitive: boolean;
  sourceLayer: "api" | "db";
};

/** Case-local values shared across UI/API/DB actions. */
export class CaseCaptureStore {
  private readonly captures = new Map<string, RuntimeCapture>();

  names(): string[] {
    return [...this.captures.keys()];
  }

  summaries(): string[] {
    return [...this.captures.values()].map((capture) =>
      capture.sensitive
        ? `${capture.name}=<sensitive ${capture.sourceLayer} capture>`
        : `${capture.name}=${boundedDisplay(capture.value)}`,
    );
  }

  persistable(): PersistableCapture[] {
    return [...this.captures.values()].map((capture) => ({
      name: capture.name,
      value: capture.sensitive ? "<redacted>" : capture.value,
      sensitive: capture.sensitive,
      sourceLayer: capture.sourceLayer,
    }));
  }

  /**
   * Substring representations added to the execution scrubber after a
   * sensitive capture. Booleans/nulls are skipped and values below 4 chars
   * are excluded: substring-replacing "true"/"1" poisons every later JSON
   * payload. Short values remain protected by exact scalar redaction
   * (sensitiveExactValues) and by the structural sensitive flag.
   */
  sensitiveScrubValues(): string[] {
    const values = [...this.captures.values()]
      .filter((capture) => capture.sensitive)
      .map((capture) => scalarScrubText(capture.value))
      .filter((value): value is string => value !== null);
    return buildScrubValuesFromValues(values, { minimumLength: 4 });
  }

  /**
   * Exact scalar forms of sensitive capture values, at any length — feeds
   * whole-scalar redaction of persisted observations, which cannot corrupt
   * JSON and therefore safely covers 1–3 character secrets.
   */
  sensitiveExactValues(): Set<string> {
    const values = new Set<string>();
    for (const capture of this.captures.values()) {
      if (!capture.sensitive) continue;
      const text = scalarScrubText(capture.value);
      if (text !== null) values.add(text);
    }
    return values;
  }

  set(capture: RuntimeCaptureInput, overwrite = false): void {
    const existing = this.captures.get(capture.name);
    if (existing && !overwrite) {
      throw new Error(`Capture "${capture.name}" already exists in this case.`);
    }
    if (!existing && this.captures.size >= MAX_CASE_CAPTURE_COUNT) {
      throw new Error(`A case can contain at most ${MAX_CASE_CAPTURE_COUNT} captures.`);
    }
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(capture.name)) {
      throw new Error("Capture names must start with a letter and contain at most 64 safe characters.");
    }
    const value = capture.value;
    assertScalarCapture(value);
    const valueBytes = captureSize(value);
    if (valueBytes > MAX_CAPTURE_VALUE_BYTES) {
      throw new Error(`Capture "${capture.name}" exceeds the ${MAX_CAPTURE_VALUE_BYTES}-byte value limit.`);
    }
    const aggregateBytes = this.aggregateBytes() - (existing ? captureSize(existing.value) : 0) + valueBytes;
    if (aggregateBytes > MAX_CAPTURE_AGGREGATE_BYTES) {
      throw new Error(`Case captures exceed the ${MAX_CAPTURE_AGGREGATE_BYTES}-byte aggregate limit.`);
    }
    this.captures.set(capture.name, {
      ...capture,
      value,
      // Sensitivity can only increase. Neither an explicit false flag nor an
      // overwrite may downgrade an already-sensitive value.
      sensitive: capture.sensitive || existing?.sensitive === true || looksSensitive(capture.name),
    });
  }

  captureJson(input: {
    name: string;
    pointer: string;
    document: unknown;
    sensitive?: boolean;
    overwrite?: boolean;
  }): void {
    const value = resolveJsonPointer(input.document, input.pointer);
    this.set({
      name: input.name,
      value,
      // Provenance first (name/pointer), then value-aliasing: a value equal to
      // one stored under a sensitive key elsewhere in the same document is
      // sensitive even when captured through an innocent-looking path.
      sensitive: input.sensitive === true
        || looksSensitive(input.name)
        || pointerLooksSensitive(input.pointer)
        || valueAliasesSensitive(value, input.document),
      sourceLayer: "api",
    }, input.overwrite);
  }

  captureRow(input: {
    name: string;
    rows: readonly Record<string, unknown>[];
    rowIndex?: number;
    column: string;
    sensitive?: boolean;
    overwrite?: boolean;
  }): void {
    const rowIndex = input.rowIndex ?? 0;
    const row = input.rows[rowIndex];
    if (!row) throw new Error(`Cannot capture row ${rowIndex}; the database result has no such row.`);
    if (!Object.prototype.hasOwnProperty.call(row, input.column)) {
      throw new Error(`Cannot capture column "${input.column}"; it is not present in row ${rowIndex}.`);
    }
    const value = row[input.column];
    this.set({
      name: input.name,
      value,
      sensitive: input.sensitive === true
        || looksSensitive(input.name)
        || looksSensitive(input.column)
        || valueAliasesSensitive(value, input.rows),
      sourceLayer: "db",
    }, input.overwrite);
  }

  resolve<T>(value: T, secrets: ReadonlyMap<string, string>): T {
    return resolveDeep(value, this.captures, secrets) as T;
  }

  private aggregateBytes(): number {
    let total = 0;
    for (const capture of this.captures.values()) total += captureSize(capture.value);
    return total;
  }
}

export function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) throw new Error("Capture pointer must be an RFC 6901 JSON Pointer.");
  let current = document;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) throw new Error(`Invalid array index "${segment}" in capture pointer.`);
      current = current[Number(segment)];
    } else if (current && typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        throw new Error(`Capture pointer segment "${segment}" does not exist.`);
      }
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new Error(`Capture pointer cannot traverse segment "${segment}".`);
    }
    if (current === undefined) throw new Error(`Capture pointer segment "${segment}" does not exist.`);
  }
  return current;
}

function resolveDeep(
  value: unknown,
  captures: ReadonlyMap<string, RuntimeCapture>,
  secrets: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") return resolveString(value, captures, secrets);
  if (Array.isArray(value)) return value.map((item) => resolveDeep(item, captures, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, resolveDeep(item, captures, secrets)]));
  }
  return value;
}

function resolveString(
  value: string,
  captures: ReadonlyMap<string, RuntimeCapture>,
  secrets: ReadonlyMap<string, string>,
): unknown {
  const wholeCapture = /^\{\{capture:([A-Za-z][A-Za-z0-9_.-]{0,63})\}\}$/.exec(value);
  if (wholeCapture) {
    const capture = captures.get(wholeCapture[1]);
    if (!capture) throw new Error(`Unknown capture "${wholeCapture[1]}".`);
    assertCaptureMayBeSubstituted(capture);
    return capture.value;
  }
  const withCaptures = value.replace(
    /\{\{capture:([A-Za-z][A-Za-z0-9_.-]{0,63})\}\}/g,
    (_, name: string) => {
      const capture = captures.get(name);
      if (!capture) throw new Error(`Unknown capture "${name}".`);
      assertCaptureMayBeSubstituted(capture);
      if (capture.value === null || typeof capture.value === "object") {
        throw new Error(`Capture "${name}" cannot be embedded inside a string.`);
      }
      return String(capture.value);
    },
  );
  return substituteSecretPlaceholders(withCaptures, secrets).value;
}

function looksSensitive(name: string) {
  return isSensitiveKey(name);
}

/**
 * A3 value-alias fallback: the captured scalar equals a value that appears
 * under a sensitive-named key/column somewhere in the same source document.
 * Over-redaction of coincidental equal values is accepted — safe, cosmetic.
 */
function valueAliasesSensitive(value: unknown, sourceDocument: unknown): boolean {
  if (value === null || typeof value === "boolean") return false;
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
  if (!text) return false;
  return collectSensitiveValues(sourceDocument).has(text);
}

function pointerLooksSensitive(pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;
  return pointer.slice(1).split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .some(looksSensitive);
}

function assertCaptureMayBeSubstituted(capture: RuntimeCapture): void {
  if (capture.sensitive) {
    throw new Error(`Sensitive capture "${capture.name}" cannot be substituted into an external action.`);
  }
}

function assertScalarCapture(value: unknown): asserts value is CaptureScalar {
  if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error("Capture values must be scalar; select a more specific API pointer or database column.");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Capture numbers must be finite.");
  }
}

function captureSize(value: CaptureScalar): number {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(rendered, "utf8");
}

function scalarScrubText(value: CaptureScalar): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function boundedDisplay(value: unknown) {
  let rendered: string;
  try {
    rendered = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    rendered = "<unserializable>";
  }
  return rendered.length > 120 ? `${rendered.slice(0, 117)}...` : rendered;
}
