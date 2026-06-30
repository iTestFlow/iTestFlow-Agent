import { vi } from "vitest";

import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type {
  Requirement,
  TestCase,
} from "@/modules/integrations/azure-devops/azure-devops-types";
import type { LLMProvider, LLMProviderName } from "@/modules/llm/llm-types";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";

export function projectScope(overrides: Partial<ProjectScope> = {}): ProjectScope {
  return {
    projectId: "project-1",
    azureProjectId: "azure-project-1",
    azureProjectName: "Demo Project",
    azureOrganizationUrl: "https://dev.azure.com/demo",
    ...overrides,
  };
}

export function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: "101",
    azureProjectId: "azure-project-1",
    teamProject: "Demo Project",
    workItemType: "User Story",
    title: "Customer checks out",
    description: "Allow a customer to complete checkout.",
    acceptanceCriteria: "Given a cart, when checkout succeeds, then show confirmation.",
    state: "Active",
    tags: ["checkout"],
    ...overrides,
  };
}

export function testCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "201",
    title: "Successful checkout",
    priority: 2,
    steps: [
      { action: "Open checkout", expectedResult: "Checkout is displayed" },
      { action: "Submit valid payment", expectedResult: "Confirmation is displayed" },
    ],
    ...overrides,
  };
}

export function fakeAzureAdapter(
  overrides: Partial<AzureDevOpsAdapter> = {},
): AzureDevOpsAdapter {
  return new Proxy(overrides as AzureDevOpsAdapter, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (property === "then") return undefined;
      return vi.fn(async () => {
        throw new Error(`Unexpected Azure adapter call: ${String(property)}`);
      });
    },
  });
}

export function fakeLlmProvider(input: {
  provider?: LLMProviderName;
  model?: string;
  structuredOutput?: unknown;
  text?: string;
} = {}): LLMProvider {
  const provider = input.provider ?? "openai";
  const model = input.model ?? "test-model";
  return {
    name: provider,
    model,
    testConnection: vi.fn(async () => true),
    getTokenUsage: vi.fn(() => ({ input: 10, output: 20, total: 30 })),
    generateText: vi.fn(async () => ({
      provider,
      model,
      rawOutput: input.text ?? "answer",
      text: input.text ?? "answer",
    })),
    generateStructuredOutput: vi.fn(async () => ({
      provider,
      model,
      rawOutput: JSON.stringify(input.structuredOutput ?? {}),
      validatedOutput: input.structuredOutput ?? {},
    })),
  };
}

export function jsonRequest(
  path: string,
  body: unknown,
  init: Omit<RequestInit, "body"> = {},
) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
    body: JSON.stringify(body),
  });
}

export function mockDatabase() {
  return {
    sqlAll: vi.fn(async () => []),
    sqlGet: vi.fn(async () => undefined),
    sqlRun: vi.fn(async () => 0),
    withTransaction: vi.fn(async (callback: (client: unknown) => unknown) =>
      callback({ query: vi.fn() }),
    ),
  };
}
