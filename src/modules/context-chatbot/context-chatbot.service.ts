import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  CONTEXT_CHATBOT_HISTORY_CONTENT_LIMIT,
  CONTEXT_CHATBOT_PROMPT_HISTORY_LIMIT,
  type ContextChatbotHistoryMessage,
} from "@/modules/context-chatbot/context-chatbot-history";
import {
  retrieveContextChatbotEvidence,
  type ContextChatbotContextEvidence,
  type ContextChatbotKnowledgeEvidence,
} from "@/modules/rag/context-chatbot-retrieval.service";
import { recordProjectKnowledgeBenchmarkQuestion } from "@/modules/rag/project-knowledge-benchmark.service";

export type ContextChatbotCitation = {
  sourceType: "project_context" | "project_knowledge";
  sourceId: string;
  title: string;
  workItemId?: string;
  workItemType?: string;
  category?: string;
  sourceWorkItemIds?: string[];
};

export async function answerContextChatbot(input: {
  scope: ProjectScope;
  actor: string;
  provider: LLMProvider;
  message: string;
  history?: ContextChatbotHistoryMessage[];
  selectedWorkItemIds?: string[];
}) {
  const scope = assertProjectScope(input.scope);
  const question = input.message.trim();
  if (!question) throw new Error("Enter a question before sending a chat message.");
  recordProjectKnowledgeBenchmarkQuestion({
    scope,
    sourceType: "business_owner_assistant",
    question,
  });

  const evidence = await retrieveContextChatbotEvidence({
    scope,
    query: question,
    contextLimit: 10,
    knowledgeLimit: 10,
    maxContextChunksPerWorkItem: 2,
    selectedWorkItemIds: input.selectedWorkItemIds,
  });
  const { citations, contextCitationCount, linkedWorkItemCount } = buildCitations(evidence.context, evidence.knowledge);

  if (!citations.length) {
    const answer = [
      "I could not find enough information in this project's indexed context or saved knowledge hub to answer that.",
      "Try indexing more project context or extracting the knowledge base again, then ask with a more specific term, work item ID, module, rule, or workflow name.",
    ].join("\n\n");
    return {
      answer,
      citations,
      retrievedContextCount: 0,
      retrievedKnowledgeCount: 0,
      linkedWorkItemCount: 0,
      provider: input.provider.name,
      model: input.provider.model,
    };
  }

  const result = await input.provider.generateText({
    system: buildSystemPrompt(),
    user: buildUserPrompt({
      scope,
      question,
      history: input.history ?? [],
      context: evidence.context,
      knowledge: evidence.knowledge,
    }),
    maxTokens: 2500,
    metadata: {
      action: "context_chatbot.answer",
      promptName: "context-chatbot-source-restricted",
      promptVersion: "1.0.0",
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
    },
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "context_chatbot.answer",
    status: "Success",
    message: "Answered context chatbot question using local project context and knowledge.",
    details: {
      provider: result.provider,
      model: result.model,
      retrievedContextCount: contextCitationCount,
      retrievedKnowledgeCount: evidence.knowledge.length,
      linkedWorkItemCount,
      citationCount: citations.length,
      knowledgeRetrievalMode: evidence.retrievalMode ?? "raw_wins",
    },
  });

  return {
    answer: result.text,
    citations,
    retrievedContextCount: contextCitationCount,
    retrievedKnowledgeCount: evidence.knowledge.length,
    linkedWorkItemCount,
    provider: result.provider,
    model: result.model,
  };
}

function buildSystemPrompt() {
  return [
    "You are iTestFlow Context Chatbot, a source-restricted assistant for one Azure DevOps project.",
    "Use ONLY the local evidence supplied in the current prompt: Indexed Project Context and Saved Project Knowledge.",
    "Do not use internet search, live Azure DevOps data, pre-training facts, general product assumptions, or external sources.",
    "If the evidence does not support the answer, say that the indexed context and knowledge hub do not contain enough information.",
    "Never invent business rules, states, roles, modules, integrations, requirements, risks, or implementation details.",
    "When making a claim, cite the local source ID in square brackets, such as [WI:12345] or [KB:business_rule:BR-001].",
    "Be concise, practical, and explicit about uncertainty.",
  ].join("\n");
}

function buildUserPrompt(input: {
  scope: ProjectScope;
  question: string;
  history: ContextChatbotHistoryMessage[];
  context: ContextChatbotContextEvidence[];
  knowledge: ContextChatbotKnowledgeEvidence[];
}) {
  return [
    "# Current Project",
    `- Azure Project ID: ${input.scope.azureProjectId}`,
    `- Azure Project Name: ${input.scope.azureProjectName}`,
    "",
    "# Recent Chat History",
    renderHistory(input.history),
    "",
    "# User Question",
    input.question,
    "",
    "# Indexed Project Context",
    renderContext(input.context),
    "",
    "# Saved Project Knowledge",
    renderKnowledge(input.knowledge),
    "",
    "# Response Requirements",
    "- Answer in markdown.",
    "- Use only the evidence above.",
    "- Include source citations inline for supported claims.",
    "- If sources conflict, name the conflict and cite both sources.",
    "- If the answer is unsupported, say so and do not speculate.",
  ].join("\n");
}

function renderHistory(history: ContextChatbotHistoryMessage[]) {
  const recent = history
    .slice(-CONTEXT_CHATBOT_PROMPT_HISTORY_LIMIT)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, CONTEXT_CHATBOT_HISTORY_CONTENT_LIMIT),
    }))
    .filter((message) => message.content);

  if (!recent.length) return "No prior chat history in this session.";
  return recent.map((message) => `- ${message.role}: ${message.content}`).join("\n");
}

function renderContext(context: ContextChatbotContextEvidence[]) {
  if (!context.length) return "No indexed work item chunks matched this question.";
  return context
    .map((item) =>
      [
        `## ${item.sourceId} - ${item.title}`,
        `- Type: ${item.workItemType}`,
        `- Work Item ID: ${item.workItemId}`,
        item.metadata.areaPath ? `- Area Path: ${item.metadata.areaPath}` : "",
        item.metadata.iterationPath ? `- Iteration Path: ${item.metadata.iterationPath}` : "",
        item.metadata.updatedDate ? `- Updated: ${item.metadata.updatedDate}` : "",
        "",
        item.content,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function renderKnowledge(knowledge: ContextChatbotKnowledgeEvidence[]) {
  if (!knowledge.length) return "No saved knowledge entries matched this question.";
  return knowledge
    .map((item) =>
      [
        `## ${item.sourceId} - ${item.title}`,
        `- Category: ${item.category}`,
        `- Source Work Items: ${item.sourceWorkItemIds.join(", ")}`,
        "",
        item.content,
      ].join("\n"),
    )
    .join("\n\n");
}

// Counts are derived by direct construction here, never by comparing array lengths
// afterward: context can legitimately contain multiple chunks for the same work item
// (see maxContextChunksPerWorkItem), which this dedups to one citation card, so a
// naive `citations.length - context.length` subtraction can go negative.
function buildCitations(context: ContextChatbotContextEvidence[], knowledge: ContextChatbotKnowledgeEvidence[]) {
  const byId = new Map<string, ContextChatbotCitation>();

  context.forEach((item) => {
    byId.set(item.sourceId, {
      sourceType: "project_context",
      sourceId: item.sourceId,
      title: item.title,
      workItemId: item.workItemId,
      workItemType: item.workItemType,
    });
  });
  const contextCitationCount = byId.size;

  let linkedWorkItemCount = 0;
  knowledge.forEach((item) => {
    item.sourceWorkItemIds.forEach((sourceWorkItemId) => {
      const workItemId = normalizeWorkItemId(sourceWorkItemId);
      if (!workItemId) return;
      const sourceId = `WI:${workItemId}`;
      if (!byId.has(sourceId)) {
        byId.set(sourceId, {
          sourceType: "project_context",
          sourceId,
          title: `Source work item ${workItemId}`,
          workItemId,
          workItemType: "Work item",
        });
        linkedWorkItemCount += 1;
      }
    });

    byId.set(item.sourceId, {
      sourceType: "project_knowledge",
      sourceId: item.sourceId,
      title: item.title,
      category: item.category,
      sourceWorkItemIds: item.sourceWorkItemIds,
    });
  });

  return { citations: Array.from(byId.values()), contextCitationCount, linkedWorkItemCount };
}

function normalizeWorkItemId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^WI:/i, "").trim();
}
