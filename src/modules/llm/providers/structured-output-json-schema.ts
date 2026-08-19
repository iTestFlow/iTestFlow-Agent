import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export function unwrapZodEffects(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  for (;;) {
    const def = current._def as { typeName?: string; schema?: z.ZodTypeAny };
    if (def.typeName !== "ZodEffects" || !def.schema) return current;
    current = def.schema;
  }
}

export function toOpenAIStrictJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(unwrapZodEffects(schema), {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  delete jsonSchema.definitions;
  delete jsonSchema.$defs;
  return flattenRootUnion(replaceFreeFormRecords(jsonSchema) as Record<string, unknown>);
}

export function toAnthropicCompatibleJsonSchema(schema: z.ZodTypeAny): unknown {
  return replaceFreeFormRecords(zodToJsonSchema(unwrapZodEffects(schema), {
    $refStrategy: "none",
    target: "jsonSchema7",
  }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isFreeFormRecord(node: Record<string, unknown>): boolean {
  if (node.type !== undefined && node.type !== "object") return false;
  const properties = asRecord(node.properties);
  if (properties && Object.keys(properties).length > 0) return false;
  return node.additionalProperties !== false && node.additionalProperties !== undefined;
}

function replaceFreeFormRecords(value: unknown, propertyMap = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => replaceFreeFormRecords(entry));
  const node = asRecord(value);
  if (!node) return value;
  const mapped = Object.fromEntries(
    Object.entries(node).map(([key, entry]) => [
      key,
      replaceFreeFormRecords(entry, !propertyMap && key === "properties"),
    ]),
  );
  if (!propertyMap && isFreeFormRecord(mapped)) {
    return { type: "string", description: "JSON-encoded object" };
  }
  return mapped;
}

function flattenRootUnion(schema: Record<string, unknown>): Record<string, unknown> {
  const variants = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(variants) || variants.length < 2) {
    return closeObjects(schema);
  }
  const objects = variants
    .map(asRecord)
    .filter((variant): variant is Record<string, unknown> => (
      variant !== null && (variant.type === "object" || variant.properties !== undefined)
    ));
  if (objects.length !== variants.length) return closeObjects(schema);

  const properties: Record<string, Record<string, unknown>> = {};
  const requiredCounts = new Map<string, number>();
  for (const variant of objects) {
    const props = asRecord(variant.properties) ?? {};
    const required = new Set(Array.isArray(variant.required) ? variant.required.filter((key): key is string => typeof key === "string") : []);
    for (const [key, value] of Object.entries(props)) {
      const property = asRecord(value) ?? { type: "string" };
      properties[key] = properties[key] ? mergePropertySchemas(properties[key], property) : property;
      if (required.has(key)) requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
    }
  }

  const closedProperties = Object.fromEntries(
    Object.entries(properties).map(([key, property]) => [
      key,
      (requiredCounts.get(key) ?? 0) === objects.length ? property : nullableSchema(property),
    ]),
  );
  return closeObjects({
    type: "object",
    properties: closedProperties,
    required: Object.keys(closedProperties),
    additionalProperties: false,
  });
}

function mergePropertySchemas(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(left) === JSON.stringify(right)) return left;
  if (left.const !== undefined && right.const !== undefined && left.const !== right.const) {
    return { type: "string", enum: [left.const, right.const] };
  }
  const leftEnum = Array.isArray(left.enum) ? left.enum : left.const !== undefined ? [left.const] : undefined;
  const rightEnum = Array.isArray(right.enum) ? right.enum : right.const !== undefined ? [right.const] : undefined;
  if (leftEnum && rightEnum) {
    return { type: "string", enum: [...new Set([...leftEnum, ...rightEnum])] };
  }
  return { anyOf: [left, right] };
}

function nullableSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(schema.type) && schema.type.includes("null")) return schema;
  if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] };
  return { anyOf: [schema, { type: "null" }] };
}

function closeObjects(value: unknown, propertyMap = false): Record<string, unknown> {
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "object" && entry ? closeObjects(entry) : entry)) as unknown as Record<string, unknown>;
  }
  const node = asRecord(value);
  if (!node) return value as Record<string, unknown>;
  const mapped = Object.fromEntries(
    Object.entries(node).map(([key, entry]) => [
      key,
      entry && typeof entry === "object"
        ? closeObjects(entry, !propertyMap && key === "properties")
        : entry,
    ]),
  );
  if (!propertyMap && (mapped.type === "object" || mapped.properties)) {
    mapped.additionalProperties = false;
  }
  return mapped;
}

export function reviveJsonEncodedRecords(value: unknown, schema: z.ZodTypeAny): unknown {
  const inner = unwrapZodEffects(schema);
  const def = inner._def as {
    typeName?: string;
    innerType?: z.ZodTypeAny;
    type?: z.ZodTypeAny;
    valueType?: z.ZodTypeAny;
    shape?: (() => Record<string, z.ZodTypeAny>) | Record<string, z.ZodTypeAny>;
    options?: z.ZodTypeAny[] | Map<string, z.ZodTypeAny>;
    discriminator?: string;
  };

  if (def.typeName === "ZodDefault") {
    if (value === undefined) return value;
    return reviveJsonEncodedRecords(value, def.innerType!);
  }
  if (def.typeName === "ZodOptional" || def.typeName === "ZodNullable") {
    if (value == null) return value;
    return reviveJsonEncodedRecords(value, def.innerType!);
  }
  if (def.typeName === "ZodRecord") {
    const objectValue = parseJsonObjectIfString(value);
    if (!objectValue || typeof objectValue !== "object" || Array.isArray(objectValue) || !def.valueType) {
      return objectValue;
    }
    return Object.fromEntries(
      Object.entries(objectValue as Record<string, unknown>).map(([key, entry]) => [
        key,
        reviveJsonEncodedRecords(entry, def.valueType!),
      ]),
    );
  }
  if (def.typeName === "ZodObject") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const shape = typeof def.shape === "function" ? def.shape() : def.shape;
    if (!shape) return value;
    const record = value as Record<string, unknown>;
    const revived: Record<string, unknown> = { ...record };
    for (const [key, fieldSchema] of Object.entries(shape)) {
      if (key in record) revived[key] = reviveJsonEncodedRecords(record[key], fieldSchema);
    }
    return revived;
  }
  if (def.typeName === "ZodArray") {
    if (!Array.isArray(value) || !def.type) return value;
    return value.map((entry) => reviveJsonEncodedRecords(entry, def.type!));
  }
  if (def.typeName === "ZodDiscriminatedUnion") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const options = def.options instanceof Map ? [...def.options.values()] : def.options ?? [];
    const matched = options.find((option) => {
      const optionDef = option._def as {
        shape?: (() => Record<string, z.ZodTypeAny>) | Record<string, z.ZodTypeAny>;
      };
      const shape = typeof optionDef.shape === "function" ? optionDef.shape() : optionDef.shape;
      const discriminator = def.discriminator ? shape?.[def.discriminator] : undefined;
      const values = discriminator?._def as { value?: unknown; values?: unknown[] } | undefined;
      const kind = def.discriminator ? record[def.discriminator] : undefined;
      return values?.value === kind || values?.values?.includes(kind);
    });
    return matched ? reviveJsonEncodedRecords(value, matched) : value;
  }
  return value;
}

function parseJsonObjectIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}
