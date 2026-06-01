import "server-only";

import { z } from "zod";

export function parseExternalStructuredOutput<TSchema extends z.ZodTypeAny>(input: {
  schemaName: string;
  schema: TSchema;
  rawOutput: string;
}): z.infer<TSchema> {
  const parsedJson = parseExternalJson(input.rawOutput);
  const result = input.schema.safeParse(parsedJson);

  if (!result.success) {
    throw new Error(`External LLM output failed schema validation for ${input.schemaName}: ${formatZodIssues(result.error)}`);
  }

  return result.data;
}

export function parseExternalJson(rawOutput: string) {
  const candidate = extractJsonCandidate(rawOutput);
  if (!candidate) {
    throw new Error("Paste the external LLM JSON response before continuing.");
  }

  const attempts = [
    candidate,
    normalizeJsonDelimiters(candidate),
    repairCommonExternalJsonMistakes(normalizeJsonDelimiters(candidate)),
    escapeLikelyUnescapedStringQuotes(normalizeJsonDelimiters(candidate)),
    escapeLikelyUnescapedStringQuotes(repairCommonExternalJsonMistakes(normalizeJsonDelimiters(candidate))),
  ].filter(uniqueStrings);
  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError instanceof Error ? lastError.message : "Unknown JSON parse error.";
  throw new Error(`External LLM output was not valid JSON: ${formatJsonParseError(message, candidate)}`);
}

function extractJsonCandidate(rawOutput: string) {
  const trimmed = rawOutput.trim().replace(/^\uFEFF/, "");
  if (!trimmed) return "";

  const fencedBlocks = Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((match) => match[1].trim());
  const fencedJson = fencedBlocks.find((block) => block.startsWith("{") || block.startsWith("["));
  if (fencedJson) return fencedJson;

  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const start = objectStart >= 0 ? objectStart : arrayStart;
  if (start < 0) return trimmed;

  const end = findBalancedJsonEnd(trimmed, start);
  return end > start ? trimmed.slice(start, end + 1).trim() : trimmed.slice(start).trim();
}

function normalizeJsonDelimiters(value: string) {
  return value
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

function uniqueStrings(value: string, index: number, values: string[]) {
  return values.indexOf(value) === index;
}

function repairCommonExternalJsonMistakes(value: string) {
  return quoteBareNumberDashLabels(stripTrailingCommas(value));
}

function stripTrailingCommas(value: string) {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      repaired += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      repaired += char;
      continue;
    }

    if (char === ",") {
      const next = nextSignificantIndex(value, index + 1);
      if (next !== -1 && (value[next] === "}" || value[next] === "]")) continue;
    }

    repaired += char;
  }

  return repaired;
}

function quoteBareNumberDashLabels(value: string) {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      repaired += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      repaired += char;
      continue;
    }

    if (char === ":") {
      repaired += char;
      let cursor = index + 1;
      while (cursor < value.length && /\s/.test(value[cursor])) {
        repaired += value[cursor];
        cursor += 1;
      }
      const match = value.slice(cursor).match(/^([1-4])\s*-\s*([^,\}\]\n\r]+)/);
      if (match) {
        repaired += `"${escapeJsonString(`${match[1]} - ${match[2].trim()}`)}"`;
        index = cursor + match[0].length - 1;
      }
      continue;
    }

    repaired += char;
  }

  return repaired;
}

function escapeJsonString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function findBalancedJsonEnd(value: string, startIndex: number) {
  const expectedClosers: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      expectedClosers.push("}");
    } else if (char === "[") {
      expectedClosers.push("]");
    } else if (char === "}" || char === "]") {
      if (expectedClosers.pop() !== char) return -1;
      if (!expectedClosers.length) return index;
    }
  }

  return -1;
}

function escapeLikelyUnescapedStringQuotes(value: string) {
  let repaired = "";
  let inString = false;
  let escaped = false;
  let lastSignificant = "";
  let stringRole: "object-key" | "object-value" | "array-value" | "unknown" = "unknown";
  const containers: Array<"object" | "array"> = [];

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (!inString) {
      repaired += char;
      if (char === "{") {
        containers.push("object");
        lastSignificant = char;
      } else if (char === "[") {
        containers.push("array");
        lastSignificant = char;
      } else if (char === "}" || char === "]") {
        containers.pop();
        lastSignificant = char;
      } else if (char === ":" || char === ",") {
        lastSignificant = char;
      } else if (char === '"') {
        inString = true;
        stringRole = inferStringRole(containers.at(-1), lastSignificant);
      } else if (!/\s/.test(char)) {
        lastSignificant = char;
      }
      continue;
    }

    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      if (isValidJsonEscapeStart(value[index + 1])) {
        repaired += char;
        escaped = true;
      } else {
        repaired += "\\\\";
      }
      continue;
    }

    if (char === "\n") {
      repaired += "\\n";
      continue;
    }

    if (char === "\r") {
      repaired += "\\r";
      continue;
    }

    if (char === "\t") {
      repaired += "\\t";
      continue;
    }

    if (char === '"') {
      if (isStringClosingQuote(value, index, stringRole, containers.at(-1))) {
        repaired += char;
        inString = false;
        lastSignificant = '"';
      } else {
        repaired += '\\"';
      }
      continue;
    }

    repaired += char;
  }

  return repaired;
}

function isValidJsonEscapeStart(value: string | undefined) {
  return value !== undefined && /["\\\/bfnrtu]/.test(value);
}

function inferStringRole(container: "object" | "array" | undefined, lastSignificant: string) {
  if (container === "object" && (lastSignificant === "{" || lastSignificant === ",")) return "object-key";
  if (container === "object" && lastSignificant === ":") return "object-value";
  if (container === "array") return "array-value";
  return "unknown";
}

function isStringClosingQuote(
  value: string,
  quoteIndex: number,
  stringRole: "object-key" | "object-value" | "array-value" | "unknown",
  container: "object" | "array" | undefined,
) {
  const cursor = nextSignificantIndex(value, quoteIndex + 1);
  const next = cursor === -1 ? undefined : value[cursor];

  if (stringRole === "object-key") return next === ":";
  if (next === undefined || next === "}" || next === "]") return true;
  if (next !== ",") return false;
  if (container === "array" || stringRole === "array-value") return true;

  const afterComma = nextSignificantIndex(value, cursor + 1);
  if (afterComma === -1) return true;
  if (value[afterComma] !== '"') return false;
  return quotedTokenIsFollowedByColon(value, afterComma);
}

function nextSignificantIndex(value: string, startIndex: number) {
  let cursor = startIndex;
  while (cursor < value.length) {
    if (!/\s/.test(value[cursor])) return cursor;
    cursor += 1;
  }

  return -1;
}

function quotedTokenIsFollowedByColon(value: string, quoteIndex: number) {
  let escaped = false;
  for (let cursor = quoteIndex + 1; cursor < value.length; cursor += 1) {
    const char = value[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      const next = nextSignificantIndex(value, cursor + 1);
      return next !== -1 && value[next] === ":";
    }
  }

  return false;
}

function formatJsonParseError(message: string, candidate: string) {
  const positionMatch = message.match(/position\s+(\d+)/i);
  if (!positionMatch) return `${message}. Paste one complete JSON object from the opening { to the final }.`;
  const position = Number(positionMatch[1]);
  if (!Number.isFinite(position)) return `${message}. Paste one complete JSON object from the opening { to the final }.`;
  const start = Math.max(0, position - 80);
  const end = Math.min(candidate.length, position + 80);
  const snippet = candidate.slice(start, end).replace(/\s+/g, " ").trim();
  return `${message}. Check the JSON near: ${snippet}`;
}

function formatZodIssues(error: z.ZodError) {
  const issues = error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  const remaining = error.issues.length - issues.length;
  return remaining > 0 ? `${issues.join("; ")}; and ${remaining} more issue(s).` : issues.join("; ");
}
