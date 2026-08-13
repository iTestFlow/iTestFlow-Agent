import { describe, expect, it } from "vitest";

import {
  MAX_REF_DEPTH,
  MAX_SCHEMA_NODES,
  createRefResolutionBudget,
  resolveBoundedSchema,
  resolveLocalComponentRef,
} from "./openapi-ref-resolver";

function documentWithSchemas(schemas: Record<string, unknown>): Record<string, unknown> {
  return { openapi: "3.1.0", components: { schemas } };
}

function schemaRef(name: string): Record<string, unknown> {
  return { $ref: `#/components/schemas/${name}` };
}

/** Chain of `length` refs: resolving Link1 follows `length` refs before the terminal. */
function refChainDocument(length: number): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (let index = 1; index < length; index += 1) {
    schemas[`Link${index}`] = schemaRef(`Link${index + 1}`);
  }
  schemas[`Link${length}`] = { type: "string" };
  return documentWithSchemas(schemas);
}

/** Object schema nested `levels` property descents deep. */
function nestedSchema(levels: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < levels; index += 1) {
    schema = { type: "object", properties: { child: schema } };
  }
  return schema;
}

/** Object schema with `count` sibling string properties: consumes count + 2 nodes. */
function wideSchema(count: number): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`p${index}`, { type: "string" }]),
    ),
  };
}

describe("resolveBoundedSchema", () => {
  it("resolves a simple local schema ref", () => {
    const document = documentWithSchemas({
      Pet: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    });
    expect(resolveBoundedSchema(schemaRef("Pet"), document, createRefResolutionBudget())).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
  });

  it("resolves nested ref chains within the depth limit", () => {
    const document = documentWithSchemas({
      A: { type: "object", properties: { b: schemaRef("B") } },
      B: { type: "array", items: schemaRef("C") },
      C: { type: "string", format: "uuid" },
    });
    expect(resolveBoundedSchema(schemaRef("A"), document, createRefResolutionBudget())).toEqual({
      type: "object",
      properties: { b: { type: "array", items: { type: "string", format: "uuid" } } },
    });
    expect(
      resolveBoundedSchema(schemaRef("Link1"), refChainDocument(MAX_REF_DEPTH), createRefResolutionBudget()),
    ).toEqual({ type: "string" });
  });

  it("returns null for a direct cycle", () => {
    const document = documentWithSchemas({ Self: schemaRef("Self") });
    expect(resolveBoundedSchema(schemaRef("Self"), document, createRefResolutionBudget())).toBeNull();
  });

  it("returns null for an indirect cycle", () => {
    const document = documentWithSchemas({
      A: { type: "object", properties: { b: schemaRef("B") } },
      B: { type: "object", properties: { a: schemaRef("A") } },
    });
    expect(resolveBoundedSchema(schemaRef("A"), document, createRefResolutionBudget())).toBeNull();
  });

  it("resolves a diamond where two siblings reference the same component", () => {
    const document = documentWithSchemas({
      Base: { type: "string" },
      Wrapper: { type: "object", properties: { first: schemaRef("Base"), second: schemaRef("Base") } },
    });
    expect(resolveBoundedSchema(schemaRef("Wrapper"), document, createRefResolutionBudget())).toEqual({
      type: "object",
      properties: { first: { type: "string" }, second: { type: "string" } },
    });
  });

  it("returns null for a ref chain deeper than MAX_REF_DEPTH", () => {
    for (const length of [MAX_REF_DEPTH + 1, MAX_REF_DEPTH + 4]) {
      expect(
        resolveBoundedSchema(schemaRef("Link1"), refChainDocument(length), createRefResolutionBudget()),
      ).toBeNull();
    }
  });

  it("returns null for property nesting deeper than MAX_REF_DEPTH", () => {
    expect(resolveBoundedSchema(nestedSchema(MAX_REF_DEPTH), {}, createRefResolutionBudget())).not.toBeNull();
    expect(resolveBoundedSchema(nestedSchema(MAX_REF_DEPTH + 1), {}, createRefResolutionBudget())).toBeNull();
  });

  it("returns null when a wide object exceeds the node budget", () => {
    expect(resolveBoundedSchema(wideSchema(MAX_SCHEMA_NODES + 100), {}, createRefResolutionBudget())).toBeNull();
  });

  it("returns null when the resolved schema exceeds the byte cap", () => {
    const schema = {
      type: "string",
      enum: Array.from({ length: 200 }, (_, index) => `${"x".repeat(400)}${index}`),
    };
    expect(resolveBoundedSchema(schema, {}, createRefResolutionBudget())).toBeNull();
  });

  it("returns null for external and non-local refs", () => {
    const document = documentWithSchemas({ Pet: { type: "string" } });
    for (const ref of [
      "https://evil.example.test/schemas.json#/components/schemas/Pet",
      "./other.json#/components/schemas/Pet",
      "#/definitions/Pet",
      "#/components/parameters/Pet",
      "#/components/schemas/a~1b",
      "#/components/schemas/Pet/properties/name",
      "#/components/schemas/",
    ]) {
      expect(resolveBoundedSchema({ $ref: ref }, document, createRefResolutionBudget())).toBeNull();
    }
    expect(resolveBoundedSchema({ $ref: 42 }, document, createRefResolutionBudget())).toBeNull();
    expect(resolveBoundedSchema(schemaRef("Missing"), document, createRefResolutionBudget())).toBeNull();
  });

  it("resolves allOf/oneOf/anyOf members", () => {
    const document = documentWithSchemas({ Base: { type: "object" } });
    expect(
      resolveBoundedSchema(
        {
          allOf: [schemaRef("Base"), { type: "object", properties: { id: { type: "integer" } } }],
          oneOf: [{ type: "string" }],
          anyOf: [{ type: "boolean" }, { type: "null" }],
        },
        document,
        createRefResolutionBudget(),
      ),
    ).toEqual({
      allOf: [{ type: "object" }, { type: "object", properties: { id: { type: "integer" } } }],
      oneOf: [{ type: "string" }],
      anyOf: [{ type: "boolean" }, { type: "null" }],
    });
  });

  it("propagates a null composition member and rejects empty composition arrays", () => {
    const document = documentWithSchemas({ Base: { type: "object" } });
    expect(
      resolveBoundedSchema({ anyOf: [schemaRef("Base"), schemaRef("Missing")] }, document, createRefResolutionBudget()),
    ).toBeNull();
    expect(resolveBoundedSchema({ oneOf: [] }, document, createRefResolutionBudget())).toBeNull();
    expect(resolveBoundedSchema({ allOf: { not: "an array" } }, document, createRefResolutionBudget())).toBeNull();
  });

  it("resolves not sub-schemas and fails closed when they cannot resolve", () => {
    expect(resolveBoundedSchema({ not: { type: "string" } }, {}, createRefResolutionBudget())).toEqual({
      not: { type: "string" },
    });
    expect(resolveBoundedSchema({ not: schemaRef("Missing") }, {}, createRefResolutionBudget())).toBeNull();
  });

  it("converts nullable:true into a type union", () => {
    expect(resolveBoundedSchema({ type: "string", nullable: true }, {}, createRefResolutionBudget())).toEqual({
      type: ["string", "null"],
    });
    expect(resolveBoundedSchema({ type: "integer", nullable: true }, {}, createRefResolutionBudget())).toEqual({
      type: ["integer", "null"],
    });
    expect(resolveBoundedSchema({ nullable: true }, {}, createRefResolutionBudget())).toEqual({});
  });

  it("passes through 3.1 type arrays only when every entry is a known type", () => {
    expect(resolveBoundedSchema({ type: ["string", "null"] }, {}, createRefResolutionBudget())).toEqual({
      type: ["string", "null"],
    });
    expect(resolveBoundedSchema({ type: ["string", "file"] }, {}, createRefResolutionBudget())).toEqual({});
    expect(resolveBoundedSchema({ type: "file" }, {}, createRefResolutionBudget())).toEqual({});
  });

  it("strips everything outside the keyword allowlist", () => {
    const resolved = resolveBoundedSchema(
      {
        type: "string",
        description: "must not survive",
        example: "must not survive",
        examples: ["must not survive"],
        "x-internal": true,
        readOnly: true,
        writeOnly: true,
        deprecated: true,
        discriminator: { propertyName: "kind" },
        xml: { name: "s" },
        externalDocs: { url: "https://example.test" },
        $id: "https://example.test/schema",
        format: "email",
        pattern: "^a+$",
        minLength: 1,
        maxLength: 10,
        default: "a",
      },
      {},
      createRefResolutionBudget(),
    );
    expect(resolved).toEqual({
      type: "string",
      format: "email",
      pattern: "^a+$",
      minLength: 1,
      maxLength: 10,
      default: "a",
    });
  });

  it("copies enum only when it is a bounded array of scalars", () => {
    expect(resolveBoundedSchema({ enum: ["a", 1, true, null] }, {}, createRefResolutionBudget())).toEqual({
      enum: ["a", 1, true, null],
    });
    expect(resolveBoundedSchema({ enum: ["a", { bad: true }] }, {}, createRefResolutionBudget())).toBeNull();
    expect(resolveBoundedSchema({ enum: "not-an-array" }, {}, createRefResolutionBudget())).toBeNull();
    expect(
      resolveBoundedSchema({ enum: Array.from({ length: 201 }, (_, index) => index) }, {}, createRefResolutionBudget()),
    ).toBeNull();
  });

  it("copies const only when scalar", () => {
    expect(resolveBoundedSchema({ const: "fixed" }, {}, createRefResolutionBudget())).toEqual({ const: "fixed" });
    expect(resolveBoundedSchema({ const: null }, {}, createRefResolutionBudget())).toEqual({ const: null });
    expect(resolveBoundedSchema({ const: { nested: true } }, {}, createRefResolutionBudget())).toBeNull();
  });

  it("drops wrong-typed constraint keywords without failing the resolution", () => {
    expect(
      resolveBoundedSchema(
        {
          type: "object",
          required: ["a", 5],
          properties: { a: { type: "string", minLength: "3", maximum: 5, pattern: 9 } },
        },
        {},
        createRefResolutionBudget(),
      ),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string", maximum: 5 } },
    });
  });

  it("resolves single-schema items and rejects the tuple form", () => {
    const document = documentWithSchemas({ Id: { type: "integer" } });
    expect(
      resolveBoundedSchema({ type: "array", items: schemaRef("Id") }, document, createRefResolutionBudget()),
    ).toEqual({ type: "array", items: { type: "integer" } });
    expect(
      resolveBoundedSchema({ type: "array", items: [{ type: "string" }] }, document, createRefResolutionBudget()),
    ).toBeNull();
  });

  it("handles boolean schemas and fail-closed propagation from properties", () => {
    expect(resolveBoundedSchema(true, {}, createRefResolutionBudget())).toEqual({});
    expect(resolveBoundedSchema(false, {}, createRefResolutionBudget())).toBeNull();
    expect(resolveBoundedSchema({ type: "array", items: true }, {}, createRefResolutionBudget())).toEqual({
      type: "array",
      items: {},
    });
    expect(
      resolveBoundedSchema({ type: "object", properties: { a: false } }, {}, createRefResolutionBudget()),
    ).toBeNull();
  });

  it("copies boolean additionalProperties as-is and resolves object form", () => {
    expect(
      resolveBoundedSchema({ type: "object", additionalProperties: false }, {}, createRefResolutionBudget()),
    ).toEqual({ type: "object", additionalProperties: false });
    const document = documentWithSchemas({ Value: { type: "number" } });
    expect(
      resolveBoundedSchema(
        { type: "object", additionalProperties: schemaRef("Value") },
        document,
        createRefResolutionBudget(),
      ),
    ).toEqual({ type: "object", additionalProperties: { type: "number" } });
  });

  it("returns null for non-object non-boolean schema input", () => {
    for (const input of [null, undefined, "schema", 42, ["array"]]) {
      expect(resolveBoundedSchema(input, {}, createRefResolutionBudget())).toBeNull();
    }
  });

  it("accumulates the shared budget across calls for one operation", () => {
    const budget = createRefResolutionBudget();
    expect(resolveBoundedSchema({ type: "string" }, {}, budget)).toEqual({ type: "string" });
    expect(budget.nodesUsed).toBe(1);
    expect(resolveBoundedSchema({ type: "string" }, {}, budget)).toEqual({ type: "string" });
    expect(budget.nodesUsed).toBe(2);

    const sharedBudget = createRefResolutionBudget();
    const halfOfBudget = wideSchema(Math.floor(MAX_SCHEMA_NODES * 0.6));
    expect(resolveBoundedSchema(halfOfBudget, {}, sharedBudget)).not.toBeNull();
    expect(resolveBoundedSchema(halfOfBudget, {}, sharedBudget)).toBeNull();
    expect(resolveBoundedSchema(halfOfBudget, {}, createRefResolutionBudget())).not.toBeNull();
  });
});

describe("resolveLocalComponentRef", () => {
  const document = {
    openapi: "3.1.0",
    components: {
      schemas: { Pet: { type: "object" } },
      parameters: {
        PageParam: { name: "page", in: "query", schema: { type: "integer" } },
        RefParam: { $ref: "#/components/parameters/PageParam" },
        Broken: "not-an-object",
      },
      requestBodies: {
        CreateOrder: { content: { "application/json": { schema: { type: "object" } } } },
      },
    },
  };

  it("returns a plain object without $ref as-is", () => {
    const inline = { name: "limit", in: "query" };
    expect(resolveLocalComponentRef(inline, document, ["parameters"])).toBe(inline);
  });

  it("resolves refs into allowed parameters and requestBodies sections", () => {
    expect(
      resolveLocalComponentRef({ $ref: "#/components/parameters/PageParam" }, document, ["parameters"]),
    ).toBe(document.components.parameters.PageParam);
    expect(
      resolveLocalComponentRef({ $ref: "#/components/requestBodies/CreateOrder" }, document, ["requestBodies"]),
    ).toBe(document.components.requestBodies.CreateOrder);
  });

  it("returns null for a ref-to-ref component", () => {
    expect(resolveLocalComponentRef({ $ref: "#/components/parameters/RefParam" }, document, ["parameters"])).toBeNull();
  });

  it("returns null for a missing or non-object component", () => {
    expect(resolveLocalComponentRef({ $ref: "#/components/parameters/Missing" }, document, ["parameters"])).toBeNull();
    expect(resolveLocalComponentRef({ $ref: "#/components/parameters/Broken" }, document, ["parameters"])).toBeNull();
  });

  it("returns null for sections outside the allowlist", () => {
    expect(
      resolveLocalComponentRef({ $ref: "#/components/schemas/Pet" }, document, ["parameters", "requestBodies"]),
    ).toBeNull();
    expect(resolveLocalComponentRef({ $ref: "#/components/headers/Trace" }, document, ["parameters"])).toBeNull();
  });

  it("returns null for malformed values and non-local refs", () => {
    expect(resolveLocalComponentRef("not-an-object", document, ["parameters"])).toBeNull();
    expect(resolveLocalComponentRef(["array"], document, ["parameters"])).toBeNull();
    expect(resolveLocalComponentRef({ $ref: 42 }, document, ["parameters"])).toBeNull();
    expect(
      resolveLocalComponentRef(
        { $ref: "https://evil.example.test/#/components/parameters/PageParam" },
        document,
        ["parameters"],
      ),
    ).toBeNull();
    expect(resolveLocalComponentRef({ $ref: "#/components/parameters/a~0b" }, document, ["parameters"])).toBeNull();
  });
});
