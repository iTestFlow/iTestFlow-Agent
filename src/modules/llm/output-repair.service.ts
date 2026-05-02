import "server-only";

import { z } from "zod";
import type { LLMProvider } from "./llm-types";

export async function validateOrRepairOutput<TSchema extends z.ZodTypeAny>(input: {
  provider: LLMProvider;
  schema: TSchema;
  schemaName: string;
  rawOutput: string;
}) {
  try {
    return input.schema.parse(JSON.parse(input.rawOutput));
  } catch {
    const result = await input.provider.generateStructuredOutput({
      schema: input.schema,
      schemaName: input.schemaName,
      system: "You repair malformed JSON output. Preserve meaning. Do not add new facts.",
      user: `Repair this output into valid JSON:\n${input.rawOutput}`,
    });
    return result.validatedOutput;
  }
}
