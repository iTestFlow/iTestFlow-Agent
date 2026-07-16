import { z } from "zod";

const ATOMIC_OPERATORS = ["eq", "lte", "gte", "lt", "gt", "ne"] as const;
const ATOMIC_VALUE_TYPES = ["number", "boolean", "enum", "state"] as const;

const BOOLEAN_TRUE_VALUES = new Set([
  "true",
  "yes",
  "enabled",
  "enable",
  "active",
  "allowed",
  "allow",
  "required",
  "require",
  "on",
]);

const BOOLEAN_FALSE_VALUES = new Set([
  "false",
  "no",
  "disabled",
  "disable",
  "inactive",
  "denied",
  "deny",
  "optional",
  "off",
]);

const BOUND_OPERATORS = new Set<string>(["lte", "gte", "lt", "gt"]);

const RawRequiredTextSchema = z
  .string()
  .transform(normalizeProjectKnowledgeAtomicWhitespace)
  .pipe(z.string().min(1));

const RawOptionalTextSchema = z
  .string()
  .optional()
  .transform((value) => {
    const normalized = value === undefined ? "" : normalizeProjectKnowledgeAtomicWhitespace(value);
    return normalized || undefined;
  });

const ProjectKnowledgeAtomicConstraintInputSchema = z
  .object({
    object: RawRequiredTextSchema,
    property: RawRequiredTextSchema,
    condition: RawOptionalTextSchema,
    operator: z.enum(ATOMIC_OPERATORS),
    value: RawRequiredTextSchema,
    valueType: z.enum(ATOMIC_VALUE_TYPES),
    unit: RawOptionalTextSchema,
  })
  .superRefine((constraint, context) => {
    if (!canonicalizeAtomicIdentityText(constraint.object)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["object"],
        message: "Constraint objects require a comparable identity.",
      });
    }
    if (!canonicalizeAtomicIdentityText(constraint.property)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["property"],
        message: "Constraint properties require a comparable identity.",
      });
    }
    if (constraint.valueType === "number" && parseAtomicNumber(constraint.value) === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "Number constraints require one finite scalar value.",
      });
    }
    if (constraint.valueType === "boolean" && canonicalBooleanValue(constraint.value) === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "Boolean constraints require a supported boolean marker.",
      });
    }
    if (
      (constraint.valueType === "enum" || constraint.valueType === "state") &&
      !canonicalizeAtomicValueText(constraint.value)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "Enum and state constraints require a comparable value.",
      });
    }
    if (constraint.valueType !== "number" && constraint.unit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unit"],
        message: "Only number constraints may declare a unit.",
      });
    }
    if (constraint.valueType !== "number" && BOUND_OPERATORS.has(constraint.operator)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operator"],
        message: "Only number constraints may use range operators.",
      });
    }
  });

type ProjectKnowledgeAtomicConstraintInput = z.infer<typeof ProjectKnowledgeAtomicConstraintInputSchema>;

/**
 * A small, isomorphic representation of a rule's single comparable assertion.
 * The raw input is normalized into a stable comparison form at the schema boundary.
 */
export const ProjectKnowledgeAtomicConstraintSchema = ProjectKnowledgeAtomicConstraintInputSchema.transform(
  canonicalizeParsedProjectKnowledgeAtomicConstraint,
);

export type ProjectKnowledgeAtomicConstraint = z.infer<typeof ProjectKnowledgeAtomicConstraintSchema>;
export type ProjectKnowledgeAtomicConstraintOperator = ProjectKnowledgeAtomicConstraint["operator"];
export type ProjectKnowledgeAtomicConstraintValueType = ProjectKnowledgeAtomicConstraint["valueType"];
export type ProjectKnowledgeAtomicConstraintValueComparison =
  | "equivalent"
  | "contradiction"
  | "not_comparable";

export type ProjectKnowledgeRuleFingerprintOptions = {
  /** Values extracted into a constraint must remain byte-for-byte untouched. */
  protectedTokens?: readonly string[];
};

export function canonicalizeProjectKnowledgeAtomicConstraint(input: unknown): ProjectKnowledgeAtomicConstraint {
  return ProjectKnowledgeAtomicConstraintSchema.parse(input);
}

/**
 * Accepts only a well-formed structured constraint whose raw value is visibly
 * grounded in at least one cited quote. Persisted constraints can already hold
 * canonical boolean or numeric spellings, so those scalar equivalents are
 * accepted on a generated-prompt round-trip.
 */
export function validateProjectKnowledgeAtomicConstraint(
  input: unknown,
  citedQuotes: readonly string[] | undefined,
): ProjectKnowledgeAtomicConstraint | null {
  const parsed = ProjectKnowledgeAtomicConstraintInputSchema.safeParse(input);
  if (!parsed.success || !valueAppearsInCitedQuote(parsed.data.value, parsed.data.valueType, citedQuotes)) return null;
  return canonicalizeParsedProjectKnowledgeAtomicConstraint(parsed.data);
}

/**
 * Conservative English-only fallback for entries that have no structured
 * constraint. It deliberately abstains whenever a rule could express more
 * than one value or a range instead of a single atomic assertion.
 */
export function extractAtomicConstraint(rule: string): ProjectKnowledgeAtomicConstraint | null {
  const normalized = normalizeProjectKnowledgeAtomicWhitespace(rule).replace(/[.;]+$/g, "");
  if (!normalized || !isLikelyEnglishAtomicRule(normalized) || hasAmbiguousAtomicSyntax(normalized)) {
    return null;
  }

  const conditioned = splitAtomicCondition(normalized);
  if (!conditioned || /\bnot\b/i.test(conditioned.condition ?? "")) {
    return null;
  }

  const expression = parseAtomicExpression(conditioned.subject);
  if (
    !expression ||
    /\bnot\b/i.test(expression.subject) ||
    hasAmbiguousAtomicValue(expression.value)
  ) {
    return null;
  }

  let subject = expression.subject;
  let operator = expression.operator;
  const maximumSubject = subject.match(/^(?:the\s+)?(?:maximum|max)\s+(.+)$/i);
  const minimumSubject = subject.match(/^(?:the\s+)?(?:minimum|min)\s+(.+)$/i);
  if (maximumSubject?.[1]) {
    subject = maximumSubject[1];
    if (operator === "eq") operator = "lte";
  } else if (minimumSubject?.[1]) {
    subject = minimumSubject[1];
    if (operator === "eq") operator = "gte";
  }

  const value = classifyAtomicValue(expression.value, subject);
  if (!value || (BOUND_OPERATORS.has(operator) && value.valueType !== "number")) return null;

  const identity = splitAtomicSubject(subject);
  if (!identity) return null;

  const parsed = ProjectKnowledgeAtomicConstraintSchema.safeParse({
    ...identity,
    ...(conditioned.condition ? { condition: conditioned.condition } : {}),
    operator,
    value: value.value,
    valueType: value.valueType,
    ...(value.unit ? { unit: value.unit } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * A module-qualified, collision-safe key for grouping comparable atomic claims.
 * Deliberately excludes operator and value: they are compared after grouping.
 */
export function projectKnowledgeAtomicConstraintIdentity(
  constraintInput: ProjectKnowledgeAtomicConstraint,
  moduleName?: string | null,
) {
  const constraint = canonicalizeProjectKnowledgeAtomicConstraint(constraintInput);
  const canonicalModuleName = moduleName ? canonicalizeAtomicIdentityText(moduleName) : "";
  return JSON.stringify([
    canonicalModuleName || null,
    constraint.object,
    constraint.property,
    constraint.condition ?? null,
  ]);
}

export function compareProjectKnowledgeAtomicConstraintValues(
  firstInput: ProjectKnowledgeAtomicConstraint,
  secondInput: ProjectKnowledgeAtomicConstraint,
): ProjectKnowledgeAtomicConstraintValueComparison {
  const first = canonicalizeProjectKnowledgeAtomicConstraint(firstInput);
  const second = canonicalizeProjectKnowledgeAtomicConstraint(secondInput);

  if (first.valueType !== second.valueType || !haveComparableAtomicUnits(first, second)) {
    return "not_comparable";
  }

  if (first.operator === second.operator && first.value === second.value) {
    return "equivalent";
  }

  if (first.operator === "eq" && second.operator === "eq") {
    return first.value === second.value ? "equivalent" : "contradiction";
  }

  if (first.operator === "ne" || second.operator === "ne") {
    return compareNotEqualAtomicConstraints(first, second);
  }

  if (first.valueType !== "number") return "not_comparable";
  const firstRange = projectKnowledgeAtomicNumericRange(first);
  const secondRange = projectKnowledgeAtomicNumericRange(second);
  if (!firstRange || !secondRange) return "not_comparable";
  return rangesAreDisjoint(firstRange, secondRange) ? "contradiction" : "not_comparable";
}

/**
 * Fingerprints are intentionally modest: they normalize surface grammar but
 * do not contain a domain synonym table. Values supplied in protectedTokens
 * bypass every transform so value-bearing text cannot be silently rewritten.
 */
export function normalizeProjectKnowledgeRuleFingerprint(
  text: string,
  options: ProjectKnowledgeRuleFingerprintOptions = {},
) {
  const protectedText = protectFingerprintTokens(
    normalizeProjectKnowledgeAtomicWhitespace(text),
    options.protectedTokens ?? [],
  );
  const normalized = protectedText.text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\b(?:a|an|the)\b/g, " ")
    .replace(/\b(?:must|shall|should|will)\s+be\b/g, " is ")
    .replace(/\b(?:is|are|was|were)\b/g, " is ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map(singularizeFingerprintToken)
    .join(" ");
  return restoreFingerprintTokens(normalized, protectedText.tokens);
}

function canonicalizeParsedProjectKnowledgeAtomicConstraint(
  constraint: ProjectKnowledgeAtomicConstraintInput,
) {
  const value = canonicalizeAtomicValue(constraint.value, constraint.valueType);
  const condition = constraint.condition ? canonicalizeAtomicIdentityText(constraint.condition) : "";
  const unit = constraint.unit ? canonicalizeAtomicUnit(constraint.unit) : "";
  return {
    object: canonicalizeAtomicIdentityText(constraint.object),
    property: canonicalizeAtomicIdentityText(constraint.property),
    ...(condition ? { condition } : {}),
    operator: constraint.operator,
    value,
    valueType: constraint.valueType,
    ...(unit ? { unit } : {}),
  };
}

function normalizeProjectKnowledgeAtomicWhitespace(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function canonicalizeAtomicIdentityText(value: string) {
  return normalizeProjectKnowledgeAtomicWhitespace(value)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map(singularizeFingerprintToken)
    .join(" ");
}

function canonicalizeAtomicValue(value: string, valueType: ProjectKnowledgeAtomicConstraintValueType) {
  if (valueType === "number") {
    const parsed = parseAtomicNumber(value);
    if (parsed === null) throw new Error("Atomic number constraints require a finite scalar value.");
    return canonicalizeAtomicNumber(parsed);
  }
  if (valueType === "boolean") {
    const parsed = canonicalBooleanValue(value);
    if (parsed === null) throw new Error("Atomic boolean constraints require a supported boolean marker.");
    return parsed;
  }
  return canonicalizeAtomicValueText(value);
}

function canonicalizeAtomicNumber(value: number) {
  const serialized = String(value);
  if (!/[eE]/u.test(serialized)) return serialized;

  if (Number.isInteger(value) && Math.abs(value) >= 1e21) {
    return BigInt(value).toString();
  }

  // Expand the shortest round-trippable serialization before falling back to
  // toFixed: `toFixed(100)` exposes binary noise for values such as 0.0000001.
  const expanded = expandAtomicScientificNumber(serialized);
  const fixedPoint = expanded ?? value.toFixed(100);
  const trimmed = fixedPoint.includes(".")
    ? fixedPoint.replace(/0+$/u, "").replace(/\.$/u, "")
    : fixedPoint;
  return trimmed === "" || trimmed === "-0" ? "0" : trimmed;
}

function expandAtomicScientificNumber(value: string) {
  const match = value.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/u);
  if (!match) return null;

  const [, sign, integer, fraction = "", exponentText] = match;
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + Number(exponentText);
  if (decimalIndex <= 0) return `${sign}0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function canonicalizeAtomicValueText(value: string) {
  return normalizeProjectKnowledgeAtomicWhitespace(value)
    .replace(/^(["'`])(.+)\1$/u, "$2")
    .replace(/[.;]+$/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeAtomicUnit(value: string) {
  const canonical = canonicalizeAtomicValueText(value).replace(/\s+/g, " ");
  const singularUnits: Record<string, string> = {
    seconds: "second",
    milliseconds: "millisecond",
    minutes: "minute",
    hours: "hour",
    days: "day",
    weeks: "week",
    months: "month",
    years: "year",
    bytes: "byte",
  };
  return singularUnits[canonical] ?? canonical;
}

function canonicalBooleanValue(value: string) {
  const canonical = canonicalizeAtomicValueText(value);
  if (BOOLEAN_TRUE_VALUES.has(canonical)) return "true";
  if (BOOLEAN_FALSE_VALUES.has(canonical)) return "false";
  return null;
}

function parseAtomicNumber(value: string) {
  const normalized = normalizeProjectKnowledgeAtomicWhitespace(value);
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(normalized.replace(/,/g, ""))) return null;
  const parsed = Number(normalized.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function valueAppearsInCitedQuote(
  value: string,
  valueType: ProjectKnowledgeAtomicConstraintValueType,
  citedQuotes: readonly string[] | undefined,
) {
  const needle = normalizeProjectKnowledgeAtomicWhitespace(value).toLowerCase();
  if (!needle) return false;
  const quotes = (citedQuotes ?? [])
    .filter((quote): quote is string => typeof quote === "string")
    .map((quote) => normalizeProjectKnowledgeAtomicWhitespace(quote).toLowerCase());
  if (quotes.some((quote) => containsCompleteAtomicValue(quote, needle))) return true;
  if (valueType === "boolean") {
    const expected = canonicalBooleanValue(value);
    return expected !== null && quotes.some((quote) => {
      const markers = quote.match(/\b(?:true|false|yes|no|enabled|disabled|enable|disable|active|inactive|allowed|denied|allow|deny|required|optional|require|on|off)\b/gi) ?? [];
      return markers.some((marker) => canonicalBooleanValue(marker) === expected);
    });
  }
  if (valueType === "number") {
    const expected = parseAtomicNumber(value);
    return expected !== null && quotes.some((quote) => {
      const numbers = quote.match(/[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)/g) ?? [];
      return numbers.some((number) => parseAtomicNumber(number) === expected);
    });
  }
  return false;
}

function containsCompleteAtomicValue(haystack: string, needle: string) {
  let position = haystack.indexOf(needle);
  while (position >= 0) {
    const before = haystack[position - 1] ?? "";
    const after = haystack[position + needle.length] ?? "";
    const startsNumeric = /[0-9]/.test(needle[0] ?? "");
    const endsNumeric = /[0-9]/.test(needle[needle.length - 1] ?? "");
    const previousCharacter = haystack[position - 2] ?? "";
    const nextCharacter = haystack[position + needle.length + 1] ?? "";
    const continuesBeforeNumber = startsNumeric &&
      (/[0-9,]/.test(before) || (before === "." && /[0-9]/.test(previousCharacter)));
    const continuesAfterNumber = endsNumeric &&
      (/[0-9,]/.test(after) || (after === "." && /[0-9]/.test(nextCharacter)));
    const validBefore = !isAtomicWordCharacter(before) && !continuesBeforeNumber;
    const validAfter = !isAtomicWordCharacter(after) && !continuesAfterNumber;
    if (validBefore && validAfter) return true;
    position = haystack.indexOf(needle, position + 1);
  }
  return false;
}

function isAtomicWordCharacter(value: string) {
  return /[\p{L}\p{N}_]/u.test(value);
}

function isLikelyEnglishAtomicRule(rule: string) {
  if (/[^\x00-\x7F]/.test(rule.replace(/[“”‘’–—]/g, ""))) return false;
  return !/\b(?:debe|deben|doit|doivent|muss|mussen|soll|sollen|deve|devono)\b/i.test(rule);
}

function hasAmbiguousAtomicSyntax(rule: string) {
  return /[;\n]/.test(rule) ||
    /\.\s+\S/.test(rule) ||
    /\b(?:between|range)\b/i.test(rule) ||
    /\bfrom\s+[^.]+\s+to\s+/i.test(rule) ||
    /\d\s*(?:-|–|to)\s*\d/.test(rule);
}

function splitAtomicCondition(rule: string) {
  const leading = rule.match(/^(?:when|if)\s+(.+?),\s*(.+)$/i);
  if (leading?.[1] && leading[2]) {
    return { subject: leading[2], condition: leading[1] };
  }
  const trailing = rule.match(/^(.+?)\s+(?:when|if)\s+(.+)$/i);
  if (trailing?.[1] && trailing[2]) {
    return { subject: trailing[1], condition: trailing[2] };
  }
  return { subject: rule };
}

function parseAtomicExpression(value: string): {
  subject: string;
  operator: ProjectKnowledgeAtomicConstraintOperator;
  value: string;
} | null {
  const symbolic = value.match(/^(.+?)\s*(<=|>=|!=|<>|=|<|>)\s*(.+)$/);
  if (symbolic?.[1] && symbolic[2] && symbolic[3]) {
    const operators: Record<string, ProjectKnowledgeAtomicConstraintOperator> = {
      "=": "eq",
      "!=": "ne",
      "<>": "ne",
      "<=": "lte",
      ">=": "gte",
      "<": "lt",
      ">": "gt",
    };
    return { subject: symbolic[1], operator: operators[symbolic[2]], value: symbolic[3] };
  }

  const bounded = value.match(
    /^(.+?)\s+(?:must|shall)\s+be\s+(at\s+most|no\s+more\s+than|less\s+than\s+or\s+equal\s+to|at\s+least|no\s+less\s+than|greater\s+than\s+or\s+equal\s+to|less\s+than|under|below|greater\s+than|more\s+than|over|above)\s+(.+)$/i,
  ) ?? value.match(
    /^(.+?)\s+(?:is|are)\s+(at\s+most|no\s+more\s+than|less\s+than\s+or\s+equal\s+to|at\s+least|no\s+less\s+than|greater\s+than\s+or\s+equal\s+to|less\s+than|under|below|greater\s+than|more\s+than|over|above)\s+(.+)$/i,
  );
  if (bounded?.[1] && bounded[2] && bounded[3]) {
    return { subject: bounded[1], operator: atomicBoundOperator(bounded[2]), value: bounded[3] };
  }

  const notEqual = value.match(/^(.+?)\s+(?:must|shall)\s+not\s+be\s+(.+)$/i) ??
    value.match(/^(.+?)\s+(?:is|are)\s+not\s+(.+)$/i) ??
    value.match(/^(.+?)\s+(?:does|do)\s+not\s+equal\s+(.+)$/i);
  if (notEqual?.[1] && notEqual[2]) {
    return { subject: notEqual[1], operator: "ne", value: notEqual[2] };
  }

  const equal = value.match(/^(.+?)\s+(?:must|shall)\s+be\s+(.+)$/i) ??
    value.match(/^(.+?)\s+(?:is|are)\s+(.+)$/i) ??
    value.match(/^(.+?)\s+(?:equals|equal\s+to)\s+(.+)$/i);
  if (!equal?.[1] || !equal[2]) return null;
  return { subject: equal[1], operator: "eq", value: equal[2] };
}

function atomicBoundOperator(value: string): ProjectKnowledgeAtomicConstraintOperator {
  const normalized = normalizeProjectKnowledgeAtomicWhitespace(value).toLowerCase();
  if (["at most", "no more than", "less than or equal to"].includes(normalized)) return "lte";
  if (["at least", "no less than", "greater than or equal to"].includes(normalized)) return "gte";
  if (["less than", "under", "below"].includes(normalized)) return "lt";
  return "gt";
}

function hasAmbiguousAtomicValue(value: string) {
  const normalized = normalizeProjectKnowledgeAtomicWhitespace(value);
  const numericWithOptionalUnit = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s+[A-Za-z%][A-Za-z0-9% /-]*)?$/u.test(normalized) ||
    /^[+-]?\.\d+(?:\s+[A-Za-z%][A-Za-z0-9% /-]*)?$/u.test(normalized);
  return !normalized ||
    /;/.test(normalized) ||
    (/,/.test(normalized) && !numericWithOptionalUnit) ||
    /\b(?:and|or|between|range)\b/i.test(normalized) ||
    /\bfrom\s+.+\s+to\s+/i.test(normalized) ||
    /\d\s*(?:-|–|to)\s*\d/.test(normalized) ||
    /\bnot\b/i.test(normalized);
}

function classifyAtomicValue(
  value: string,
  subject: string,
): { value: string; valueType: ProjectKnowledgeAtomicConstraintValueType; unit?: string } | null {
  const normalized = normalizeProjectKnowledgeAtomicWhitespace(value).replace(/[.;]+$/g, "");
  const numeric = normalized.match(/^([+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+))(?:\s+([A-Za-z%][A-Za-z0-9% /-]*))?$/);
  if (numeric?.[1]) {
    return { value: numeric[1], valueType: "number", ...(numeric[2] ? { unit: numeric[2] } : {}) };
  }
  if (canonicalBooleanValue(normalized) !== null) {
    return { value: normalized, valueType: "boolean" };
  }
  if (/^(?:true|false|yes|no|enabled|disabled|enable|disable|active|inactive|allowed|denied|allow|deny|required|optional|require|on|off)\b/i.test(normalized)) {
    return null;
  }

  const words = normalized.replace(/^(["'`])(.+)\1$/u, "$2").split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return null;
  const valueType = /\b(?:status|state|phase|stage)\b/i.test(subject) ? "state" : "enum";
  return { value: normalized, valueType };
}

function splitAtomicSubject(subject: string) {
  const normalized = normalizeProjectKnowledgeAtomicWhitespace(subject)
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/[’']s\b/gi, " ");
  const canonical = canonicalizeAtomicIdentityText(normalized);
  const tokens = canonical.split(" ").filter(Boolean);
  if (!tokens.length) return null;
  if (tokens.length === 1) return { object: tokens[0], property: "value" };
  return { object: tokens.slice(0, -1).join(" "), property: tokens[tokens.length - 1] ?? "value" };
}

function haveComparableAtomicUnits(
  first: ProjectKnowledgeAtomicConstraint,
  second: ProjectKnowledgeAtomicConstraint,
) {
  if (first.valueType !== "number") return true;
  return Boolean(first.unit) === Boolean(second.unit) && first.unit === second.unit;
}

function compareNotEqualAtomicConstraints(
  first: ProjectKnowledgeAtomicConstraint,
  second: ProjectKnowledgeAtomicConstraint,
): ProjectKnowledgeAtomicConstraintValueComparison {
  if (first.operator === "ne" && second.operator === "ne") {
    return first.value === second.value ? "equivalent" : "not_comparable";
  }
  const notEqual = first.operator === "ne" ? first : second;
  const equal = first.operator === "eq" ? first : second;
  return equal.operator === "eq" && equal.value === notEqual.value ? "contradiction" : "not_comparable";
}

type NumericRange = {
  lower: number | null;
  lowerInclusive: boolean;
  upper: number | null;
  upperInclusive: boolean;
};

function projectKnowledgeAtomicNumericRange(constraint: ProjectKnowledgeAtomicConstraint): NumericRange | null {
  const value = parseAtomicNumber(constraint.value);
  if (value === null) return null;
  switch (constraint.operator) {
    case "eq":
      return { lower: value, lowerInclusive: true, upper: value, upperInclusive: true };
    case "lte":
      return { lower: null, lowerInclusive: false, upper: value, upperInclusive: true };
    case "lt":
      return { lower: null, lowerInclusive: false, upper: value, upperInclusive: false };
    case "gte":
      return { lower: value, lowerInclusive: true, upper: null, upperInclusive: false };
    case "gt":
      return { lower: value, lowerInclusive: false, upper: null, upperInclusive: false };
    default:
      return null;
  }
}

function rangesAreDisjoint(first: NumericRange, second: NumericRange) {
  return isRangeEntirelyBefore(first, second) || isRangeEntirelyBefore(second, first);
}

function isRangeEntirelyBefore(first: NumericRange, second: NumericRange) {
  if (first.upper === null || second.lower === null) return false;
  if (first.upper < second.lower) return true;
  if (first.upper > second.lower) return false;
  return !first.upperInclusive || !second.lowerInclusive;
}

function protectFingerprintTokens(text: string, protectedTokens: readonly string[]) {
  const tokens = new Map<string, string>();
  let result = text;
  Array.from(new Set(protectedTokens.map(normalizeProjectKnowledgeAtomicWhitespace).filter(Boolean)))
    .sort((first, second) => second.length - first.length || first.localeCompare(second))
    .forEach((token, index) => {
      const placeholder = `zqpkprotectedtoken${index}qz`;
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matcher = new RegExp(escaped, "giu");
      if (!matcher.test(result)) return;
      result = result.replace(matcher, placeholder);
      tokens.set(placeholder, token);
    });
  return { text: result, tokens };
}

function restoreFingerprintTokens(text: string, tokens: Map<string, string>) {
  let restored = text;
  tokens.forEach((token, placeholder) => {
    restored = restored.replace(new RegExp(placeholder, "g"), token);
  });
  return restored;
}

function singularizeFingerprintToken(token: string) {
  if (
    token.length <= 3 ||
    !/^[a-z]+$/.test(token) ||
    /(?:ss|us|is|ness)$/.test(token)
  ) {
    return token;
  }
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (/(?:ches|shes|xes|zes|ses)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
}
