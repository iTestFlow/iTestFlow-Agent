import "server-only";

import { z } from "zod";
import type { GenerateStructuredOutputInput, LLMProvider, LLMProviderConfig, LLMProviderName, LLMResult } from "../llm-types";

export abstract class BaseJsonProvider implements LLMProvider {
  readonly name: LLMProviderName;
  readonly model: string;
  protected readonly config: LLMProviderConfig;

  constructor(config: LLMProviderConfig) {
    this.name = config.provider;
    this.model = config.model;
    this.config = config;
  }

  abstract testConnection(): Promise<boolean>;

  async generateStructuredOutput<TSchema extends z.ZodTypeAny>(
    input: GenerateStructuredOutputInput<TSchema>,
  ): Promise<LLMResult<z.infer<TSchema>>> {
    const rawOutput = await this.callModel(input);
    const validatedOutput = await this.parseValidateOrRepair(input, rawOutput);

    return {
      provider: this.name,
      model: this.model,
      rawOutput,
      validatedOutput,
    };
  }

  protected abstract callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<string>;

  private async parseValidateOrRepair<TSchema extends z.ZodTypeAny>(
    input: GenerateStructuredOutputInput<TSchema>,
    rawOutput: string,
  ): Promise<z.infer<TSchema>> {
    try {
      return input.schema.parse(this.parseJson(rawOutput));
    } catch (error) {
      if (input.repairOnInvalidOutput === false) {
        throw error;
      }
      const repairedRawOutput = await this.callModel({
        ...input,
        system: [
          "Repair malformed JSON so it validates against the requested schema.",
          "Preserve the original meaning and do not add unsupported facts.",
          "Return compact JSON only, without markdown fences or commentary.",
        ].join("\n"),
        user: JSON.stringify({
          schemaName: input.schemaName,
          requiredJsonShape: schemaShapeHint(input.schemaName),
          error: error instanceof Error ? error.message : "JSON validation failed.",
          malformedOutput: rawOutput,
        }),
        temperature: 0,
        maxTokens: Math.max(input.maxTokens ?? this.config.maxTokens ?? 4000, 8192),
      });
      return input.schema.parse(this.parseJson(repairedRawOutput));
    }
  }

  protected parseJson(rawOutput: string) {
    const trimmed = rawOutput.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    return JSON.parse(fenced ?? trimmed);
  }

  protected headers() {
    return {
      "Content-Type": "application/json",
    };
  }
}

function schemaShapeHint(schemaName: string) {
  if (schemaName === "ContextSuggestionOutput") {
    return {
      suggestedItems: [
        {
          workItemId: "string",
          title: "string",
          workItemType: "string",
          relationshipType: "string optional",
          relevanceScore: "number from 0 to 1",
          reason: "string",
        },
      ],
    };
  }
  if (schemaName === "RequirementAnalysisOutput") {
    return {
      executiveSummary: "string",
      scores: {
        clarity: "number 0-100",
        testability: "number 0-100",
        completeness: "number 0-100",
        ambiguityRisk: "number 0-100",
        integrationRisk: "number 0-100",
        businessRuleCoverage: "number 0-100",
        acceptanceCriteriaQuality: "number 0-100",
        overallReadiness: "number 0-100",
      },
      findings: [
        {
          id: "string",
          severity: "High | Medium | Low",
          category: "string",
          title: "string",
          explanation: "string",
          suggestedImprovement: "string",
          azureDevOpsCommentSnippet: "string",
          scoreImpact: "number",
          sourceContextIds: ["string"],
        },
      ],
      assumptions: ["string"],
      questionsForProductOwner: ["string"],
    };
  }
  return "Return a JSON object that matches the requested schema name.";
}
