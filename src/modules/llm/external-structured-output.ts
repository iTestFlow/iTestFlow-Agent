import "server-only";

import { z } from "zod";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { extractJsonCandidate, JsonParseError, parseJsonWithRepair } from "./json-extraction";

export function parseExternalStructuredOutput<TSchema extends z.ZodTypeAny>(input: {
  schemaName: string;
  schema: TSchema;
  rawOutput: string;
  provider?: string;
  model?: string;
}): z.infer<TSchema> {
  const context = externalContext(input);
  const parsedJson = parseExternalJson(input.rawOutput, context);
  const result = input.schema.safeParse(parsedJson);

  if (!result.success) {
    throw new AppError({
      code: AppErrorCode.SchemaValidation,
      message: `External LLM output failed schema validation for ${input.schemaName}: ${formatZodIssues(result.error)}`,
      userMessage: "The external LLM response did not match the expected format. Check the pasted response and try again.",
      technicalContext: {
        ...context,
        rawOutputExcerpt: input.rawOutput,
      },
    });
  }

  return result.data;
}

export function parseExternalJson(rawOutput: string, context?: ExternalParseContext) {
  const resolvedContext = externalContext(context);
  if (!extractJsonCandidate(rawOutput)) {
    throw new AppError({
      code: AppErrorCode.InvalidJson,
      message: "Paste the external LLM JSON response before continuing.",
      userMessage: "Paste the external LLM JSON response before continuing.",
      technicalContext: {
        ...resolvedContext,
        rawOutputExcerpt: rawOutput,
      },
    });
  }

  try {
    return parseJsonWithRepair(rawOutput);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON parse error.";
    throw new AppError({
      code: AppErrorCode.InvalidJson,
      message: `External LLM output was not valid JSON: ${message}`,
      userMessage: "The external LLM response was not valid JSON. Check the pasted response and try again.",
      technicalContext: {
        ...resolvedContext,
        parsePosition: error instanceof JsonParseError ? error.position : undefined,
        jsonSnippet: error instanceof JsonParseError ? error.snippet : undefined,
        rawOutputExcerpt: rawOutput,
      },
    });
  }
}

type ExternalParseContext = {
  schemaName?: string;
  provider?: string;
  model?: string;
};

function externalContext(context?: ExternalParseContext) {
  return {
    provider: context?.provider ?? "external",
    model: context?.model ?? "manual-external",
    schemaName: context?.schemaName ?? "ExternalJson",
  };
}

function formatZodIssues(error: z.ZodError) {
  const issues = error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  const remaining = error.issues.length - issues.length;
  return remaining > 0 ? `${issues.join("; ")}; and ${remaining} more issue(s).` : issues.join("; ");
}
