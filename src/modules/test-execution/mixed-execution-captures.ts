/** Case-local values never enter model context or persisted operation evidence. */
export class CaseCaptures {
  private readonly values = new Map<string, string | number | boolean | null>();

  names(): string[] { return [...this.values.keys()]; }

  capture(name: string, source: unknown, path: string): void {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name) || this.values.size >= 30 && !this.values.has(name)) throw new Error("Capture name or count is invalid.");
    const value = readResultPath(source, path);
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error("Only scalar result values may be captured.");
    if (typeof value === "string" && value.length > 4096 || typeof value === "number" && !Number.isFinite(value)) throw new Error("Captured value exceeds limits.");
    this.values.set(name, value as string | number | boolean | null);
  }

  substitute<T>(value: T): T {
    if (typeof value === "string") {
      const exact = /^\{\{capture:([a-z][a-z0-9_]{0,62})\}\}$/.exec(value);
      if (exact) return this.require(exact[1]) as T;
      return value.replace(/\{\{capture:([a-z][a-z0-9_]{0,62})\}\}/g, (_match, name: string) => String(this.require(name))) as T;
    }
    if (Array.isArray(value)) return value.map((entry) => this.substitute(entry)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.substitute(entry)])) as T;
    return value;
  }

  secretValues(): string[] { return [...this.values.values()].filter((value): value is string => typeof value === "string" && value.length > 0); }

  private require(name: string) {
    if (!this.values.has(name)) throw new Error(`Capture "${name}" is unavailable in this case.`);
    return this.values.get(name)!;
  }
}

/** Resolve test data in worker memory, preserving secret values outside model prompts. */
export function substituteTestData<T>(value: T, entries: readonly { title: string; value: string }[]): T {
  if (typeof value === "string") {
    const resolve = (title: string) => {
      const entry = entries.find((item) => item.title === title);
      if (!entry) throw new Error(`Test data "${title}" is unavailable.`);
      return entry.value;
    };
    return value.replace(/\{\{testData:([^{}]{1,200})\}\}/g, (_match, title: string) => resolve(title)) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => substituteTestData(entry, entries)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substituteTestData(entry, entries)])) as T;
  return value;
}

export function readResultPath(source: unknown, path: string): unknown {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(?:(?:\.[a-zA-Z][a-zA-Z0-9_]*)|(?:\[(?:0|[1-9][0-9]{0,3})\])){0,8}$/.test(path)) throw new Error("Result path is invalid.");
  const parts = path.match(/[a-zA-Z][a-zA-Z0-9_]*|\[(?:0|[1-9][0-9]{0,3})\]/g) ?? [];
  let current: unknown = source;
  for (const part of parts) {
    if (part === "constructor" || part === "prototype" || part === "__proto__") throw new Error("Result path is invalid.");
    const key = part.startsWith("[") ? Number(part.slice(1, -1)) : part;
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) throw new Error("Result path does not exist.");
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

export function assertResult(source: unknown, path: string, operator: "equals" | "not_equals" | "contains" | "exists" | "gte" | "lte", expected?: unknown): boolean {
  let actual: unknown;
  try { actual = readResultPath(source, path); }
  catch { return operator === "exists" && expected === false; }
  if (operator === "exists") return expected === false ? actual === null || actual === undefined : actual !== null && actual !== undefined;
  if (operator === "equals") return typeof actual === typeof expected && actual === expected;
  if (operator === "not_equals") return typeof actual !== typeof expected || actual !== expected;
  if (operator === "contains") return typeof actual === "string" && typeof expected === "string" && actual.includes(expected) || Array.isArray(actual) && actual.some((entry) => entry === expected);
  if (typeof actual !== "number" || typeof expected !== "number" || !Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  return operator === "gte" ? actual >= expected : actual <= expected;
}
