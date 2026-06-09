import "server-only";

import { z } from "zod";
import { extractJsonCandidate, parseJsonWithRepair } from "./json-extraction";

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
  if (!extractJsonCandidate(rawOutput)) {
    throw new Error("Paste the external LLM JSON response before continuing.");
  }

  try {
    return parseJsonWithRepair(rawOutput);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON parse error.";
    throw new Error(`External LLM output was not valid JSON: ${message}`);
  }
}

function formatZodIssues(error: z.ZodError) {
  const issues = error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  const remaining = error.issues.length - issues.length;
  return remaining > 0 ? `${issues.join("; ")}; and ${remaining} more issue(s).` : issues.join("; ");
}
