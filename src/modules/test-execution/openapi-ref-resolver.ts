export const MAX_REF_DEPTH = 8;
export const MAX_SCHEMA_NODES = 2_000;
export const MAX_RESOLVED_SCHEMA_BYTES = 64 * 1024;

/** Budget shared across all resolutions for ONE operation. */
export type RefResolutionBudget = { nodesUsed: number };

export function createRefResolutionBudget(): RefResolutionBudget {
  return { nodesUsed: 0 };
}

const SCHEMA_REF_PATTERN = /^#\/components\/schemas\/([A-Za-z0-9_.-]+)$/;
const COMPONENT_REF_PATTERN = /^#\/components\/(schemas|parameters|requestBodies)\/([A-Za-z0-9_.-]+)$/;

const JSON_SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

const NUMERIC_CONSTRAINT_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "multipleOf",
] as const;

const COMPOSITION_KEYWORDS = ["allOf", "oneOf", "anyOf"] as const;

/**
 * Resolve an OpenAPI schema object into a fully-inlined JSON Schema with no
 * remaining $ref, or null when the schema cannot be safely resolved
 * (external/non-local ref, cycle, depth/node/byte budget exceeded, or
 * malformed input). Null means the CALLER decides to drop the parameter/body/
 * operation — this function never throws on untrusted input.
 */
export function resolveBoundedSchema(
  schema: unknown,
  rootDocument: unknown,
  budget: RefResolutionBudget,
): Record<string, unknown> | null {
  const resolved = resolveSchemaNode(schema, asRecord(rootDocument), budget, 0, []);
  if (!resolved) return null;
  return JSON.stringify(resolved).length > MAX_RESOLVED_SCHEMA_BYTES ? null : resolved;
}

/**
 * Resolve a request-body or parameter OBJECT that may itself be a $ref into
 * #/components/requestBodies/<name> or #/components/parameters/<name>.
 * Returns the referenced object (NOT deep-resolved — callers then resolve the
 * inner schema via resolveBoundedSchema) or null when non-local/missing/not
 * an object. Only single-level: a ref-to-ref returns null.
 */
export function resolveLocalComponentRef(
  value: unknown,
  rootDocument: unknown,
  allowedSections: readonly ("schemas" | "parameters" | "requestBodies")[],
): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  if (!hasOwn(record, "$ref")) return record;
  const ref = record.$ref;
  if (typeof ref !== "string") return null;
  const match = COMPONENT_REF_PATTERN.exec(ref);
  if (!match) return null;
  const section = match[1] as "schemas" | "parameters" | "requestBodies";
  if (!allowedSections.includes(section)) return null;
  const components = asRecord(ownValue(asRecord(rootDocument), "components"));
  const target = asRecord(ownValue(asRecord(ownValue(components, section)), match[2]));
  return target && !hasOwn(target, "$ref") ? target : null;
}

function resolveSchemaNode(
  schema: unknown,
  root: Record<string, unknown> | null,
  budget: RefResolutionBudget,
  depth: number,
  refStack: string[],
): Record<string, unknown> | null {
  if (depth > MAX_REF_DEPTH) return null;
  // JSON Schema boolean form: `true` accepts everything, `false` accepts nothing.
  if (schema === true) return {};
  if (schema === false) return null;
  const node = asRecord(schema);
  if (!node) return null;
  if (!consumeNode(budget)) return null;

  if (hasOwn(node, "$ref")) {
    const ref = node.$ref;
    if (typeof ref !== "string") return null;
    const match = SCHEMA_REF_PATTERN.exec(ref);
    if (!match) return null;
    const name = match[1];
    // Re-entering a name already being expanded is a cycle; the same name on
    // two sibling branches (diamond) is fine because the stack is popped.
    if (refStack.includes(name)) return null;
    const schemas = asRecord(ownValue(asRecord(ownValue(root, "components")), "schemas"));
    if (!schemas || !hasOwn(schemas, name)) return null;
    refStack.push(name);
    const resolved = resolveSchemaNode(schemas[name], root, budget, depth + 1, refStack);
    refStack.pop();
    return resolved;
  }

  const output: Record<string, unknown> = {};

  const typeValue = ownValue(node, "type");
  let resolvedType: string | string[] | undefined;
  if (typeof typeValue === "string" && JSON_SCHEMA_TYPES.has(typeValue)) {
    resolvedType = typeValue;
  } else if (Array.isArray(typeValue)) {
    if (!consumeNode(budget)) return null;
    if (typeValue.every((entry) => typeof entry === "string" && JSON_SCHEMA_TYPES.has(entry))) {
      resolvedType = [...typeValue] as string[];
    }
  }
  // OpenAPI 3.0 nullable → JSON Schema type union; without a type there is
  // nothing to union with, so nullable is dropped silently.
  if (ownValue(node, "nullable") === true && typeof resolvedType === "string" && resolvedType !== "null") {
    resolvedType = [resolvedType, "null"];
  }
  if (resolvedType !== undefined) output.type = resolvedType;

  const propertiesValue = ownValue(node, "properties");
  if (propertiesValue !== undefined) {
    const properties = asRecord(propertiesValue);
    if (!properties || !consumeNode(budget)) return null;
    const entries: Array<[string, Record<string, unknown>]> = [];
    for (const name of Object.keys(properties)) {
      const resolved = resolveSchemaNode(properties[name], root, budget, depth + 1, refStack);
      if (!resolved) return null;
      entries.push([name, resolved]);
    }
    // fromEntries defines own data properties, so a "__proto__" property name
    // cannot mutate the output object's prototype.
    output.properties = Object.fromEntries(entries);
  }

  const requiredValue = ownValue(node, "required");
  if (Array.isArray(requiredValue)) {
    if (!consumeNode(budget)) return null;
    if (requiredValue.every((entry) => typeof entry === "string")) {
      output.required = [...requiredValue];
    }
  }

  const itemsValue = ownValue(node, "items");
  if (itemsValue !== undefined) {
    // Tuple form (array of schemas) is out of scope — fail closed.
    if (Array.isArray(itemsValue)) return null;
    const resolved = resolveSchemaNode(itemsValue, root, budget, depth + 1, refStack);
    if (!resolved) return null;
    output.items = resolved;
  }

  const additionalPropertiesValue = ownValue(node, "additionalProperties");
  if (typeof additionalPropertiesValue === "boolean") {
    output.additionalProperties = additionalPropertiesValue;
  } else if (asRecord(additionalPropertiesValue)) {
    const resolved = resolveSchemaNode(additionalPropertiesValue, root, budget, depth + 1, refStack);
    if (!resolved) return null;
    output.additionalProperties = resolved;
  }

  for (const keyword of COMPOSITION_KEYWORDS) {
    const value = ownValue(node, keyword);
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length === 0 || !consumeNode(budget)) return null;
    const members: Array<Record<string, unknown>> = [];
    for (const member of value) {
      const resolved = resolveSchemaNode(member, root, budget, depth + 1, refStack);
      if (!resolved) return null;
      members.push(resolved);
    }
    output[keyword] = members;
  }

  const notValue = ownValue(node, "not");
  if (notValue !== undefined) {
    const resolved = resolveSchemaNode(notValue, root, budget, depth + 1, refStack);
    if (!resolved) return null;
    output.not = resolved;
  }

  if (hasOwn(node, "enum")) {
    const enumValue = node.enum;
    if (!Array.isArray(enumValue) || enumValue.length > 200 || !consumeNode(budget)) return null;
    if (!enumValue.every(isScalar)) return null;
    output.enum = [...enumValue];
  }

  if (hasOwn(node, "const")) {
    if (!isScalar(node.const)) return null;
    output.const = node.const;
  }

  for (const keyword of NUMERIC_CONSTRAINT_KEYWORDS) {
    const value = ownValue(node, keyword);
    if (typeof value === "number" && Number.isFinite(value)) output[keyword] = value;
  }
  for (const keyword of ["format", "pattern"] as const) {
    const value = ownValue(node, keyword);
    if (typeof value === "string") output[keyword] = value;
  }

  if (hasOwn(node, "default")) {
    const cloned = cloneJsonValue(node.default, budget, depth + 1);
    // The clone charges the shared node budget as it walks; running out of
    // budget is fatal, an unrepresentable default is merely dropped.
    if (budget.nodesUsed > MAX_SCHEMA_NODES) return null;
    if (cloned !== UNREPRESENTABLE) output.default = cloned;
  }

  return output;
}

const UNREPRESENTABLE = Symbol("unrepresentable");

/**
 * Deep-copy an arbitrary default value while charging the node budget, so an
 * attacker-supplied default cannot smuggle unbounded structure (or a cyclic
 * object, which the depth cap terminates) into the resolved schema.
 */
function cloneJsonValue(
  value: unknown,
  budget: RefResolutionBudget,
  depth: number,
): unknown | typeof UNREPRESENTABLE {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : UNREPRESENTABLE;
  if (Array.isArray(value)) {
    if (!consumeNode(budget) || depth > MAX_REF_DEPTH) return UNREPRESENTABLE;
    const entries: unknown[] = [];
    for (const entry of value) {
      const cloned = cloneJsonValue(entry, budget, depth + 1);
      if (cloned === UNREPRESENTABLE) return UNREPRESENTABLE;
      entries.push(cloned);
    }
    return entries;
  }
  const record = asRecord(value);
  if (!record) return UNREPRESENTABLE;
  if (!consumeNode(budget) || depth > MAX_REF_DEPTH) return UNREPRESENTABLE;
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(record)) {
    const cloned = cloneJsonValue(record[key], budget, depth + 1);
    if (cloned === UNREPRESENTABLE) return UNREPRESENTABLE;
    entries.push([key, cloned]);
  }
  return Object.fromEntries(entries);
}

function consumeNode(budget: RefResolutionBudget): boolean {
  budget.nodesUsed += 1;
  return budget.nodesUsed <= MAX_SCHEMA_NODES;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function ownValue(record: Record<string, unknown> | null, key: string): unknown {
  return record && hasOwn(record, key) ? record[key] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
