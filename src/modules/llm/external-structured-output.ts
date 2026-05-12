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
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    throw new Error("Paste the external LLM JSON response before continuing.");
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    try {
      return JSON.parse(escapeLikelyUnescapedStringQuotes(candidate));
    } catch {
      const message = error instanceof Error ? error.message : "Unknown JSON parse error.";
      throw new Error(`External LLM output was not valid JSON: ${message}`);
    }
  }
}

function escapeLikelyUnescapedStringQuotes(value: string) {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (!inString) {
      repaired += char;
      if (char === '"') inString = true;
      continue;
    }

    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      repaired += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      if (isStringClosingQuote(value, index)) {
        repaired += char;
        inString = false;
      } else {
        repaired += '\\"';
      }
      continue;
    }

    repaired += char;
  }

  return repaired;
}

function isStringClosingQuote(value: string, quoteIndex: number) {
  let cursor = quoteIndex + 1;
  while (cursor < value.length && /\s/.test(value[cursor])) cursor += 1;
  const next = value[cursor];
  return next === ":" || next === "," || next === "}" || next === "]" || next === undefined;
}

function formatZodIssues(error: z.ZodError) {
  const issues = error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  const remaining = error.issues.length - issues.length;
  return remaining > 0 ? `${issues.join("; ")}; and ${remaining} more issue(s).` : issues.join("; ");
}
