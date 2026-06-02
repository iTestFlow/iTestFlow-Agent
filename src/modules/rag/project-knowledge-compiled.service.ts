import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { createId, getDatabase, nowIso } from "@/modules/shared/infrastructure/database/db";
import type { ProjectKnowledgeBase } from "./project-knowledge.schema";

type FsModule = typeof import("fs");
type PathModule = typeof import("path");
type CryptoModule = typeof import("crypto");

export type ProjectKnowledgeCompilationMode = "incremental" | "full" | "manual" | "promoted";
export type ProjectKnowledgeLogSeverity = "info" | "warning" | "error";

export type ProjectKnowledgeLogItem = {
  id: string;
  eventType: string;
  severity: ProjectKnowledgeLogSeverity;
  title: string;
  message: string;
  sourceIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ProjectKnowledgeLintIssue = {
  id: string;
  issueType: string;
  severity: ProjectKnowledgeLogSeverity;
  title: string;
  message: string;
  category?: string | null;
  entryKey?: string | null;
  sourceWorkItemIds: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
};

type KnowledgeEntry = {
  category: string;
  entryKey: string;
  title: string;
  content: string;
  sourceWorkItemIds: string[];
  evidence: string;
  metadata: Record<string, unknown>;
};

type SourceWorkItemRow = {
  azure_work_item_id: string;
  title: string;
  sync_status: string | null;
};

type KnowledgeSnapshotRow = {
  id: string;
  provider: string | null;
  model_name: string | null;
  source_work_item_count: number;
  raw_output: string | null;
  validated_output: string;
};

type KnowledgeLogRow = {
  id: string;
  event_type: string;
  severity: ProjectKnowledgeLogSeverity;
  title: string;
  message: string;
  source_ids: string;
  metadata_json: string | null;
  created_at: string;
};

type KnowledgeLintRow = {
  id: string;
  issue_type: string;
  severity: ProjectKnowledgeLogSeverity;
  title: string;
  message: string;
  category: string | null;
  entry_key: string | null;
  source_work_item_ids: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export function recordProjectKnowledgeRevision(input: {
  scope: ProjectScope;
  knowledgeBaseId: string;
  knowledgeBase: ProjectKnowledgeBase;
  provider?: string | null;
  model?: string | null;
  rawOutput?: string | null;
  sourceWorkItemCount: number;
  mode: ProjectKnowledgeCompilationMode;
  sourceChangeSummary?: Record<string, unknown>;
}) {
  const scope = assertProjectScope(input.scope);
  const db = getDatabase();
  const now = nowIso();
  const revisionId = createId("pkr");
  const revisionNumber = nextRevisionNumber(scope);
  const validatedOutput = JSON.stringify(input.knowledgeBase);
  const entries = flattenProjectKnowledge(input.knowledgeBase);

  const previousActive = db
    .prepare(
      `
      SELECT id, category, entry_key, content_hash
      FROM project_knowledge_entry_versions
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND status = 'active'
    `,
    )
    .all({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    }) as Array<{ id: string; category: string; entry_key: string; content_hash: string }>;
  const previousByKey = new Map(previousActive.map((entry) => [knowledgeVersionKey(entry.category, entry.entry_key), entry]));
  const nextKeys = new Set(entries.map((entry) => knowledgeVersionKey(entry.category, entry.entryKey)));

  db.prepare(
    `
    INSERT INTO project_knowledge_revisions (
      id, project_id, azure_project_id, azure_project_name, azure_organization_url,
      knowledge_base_id, revision_number, mode, provider, model_name,
      source_work_item_count, source_change_summary_json, raw_output, validated_output, created_at
    ) VALUES (
      @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
      @knowledgeBaseId, @revisionNumber, @mode, @provider, @model,
      @sourceWorkItemCount, @sourceChangeSummaryJson, @rawOutput, @validatedOutput, @createdAt
    )
  `,
  ).run({
    id: revisionId,
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    knowledgeBaseId: input.knowledgeBaseId,
    revisionNumber,
    mode: input.mode,
    provider: input.provider ?? null,
    model: input.model ?? null,
    sourceWorkItemCount: input.sourceWorkItemCount,
    sourceChangeSummaryJson: JSON.stringify(input.sourceChangeSummary ?? {}),
    rawOutput: input.rawOutput ?? null,
    validatedOutput,
    createdAt: now,
  });

  const insertVersion = db.prepare(
    `
    INSERT INTO project_knowledge_entry_versions (
      id, project_id, azure_project_id, azure_project_name, azure_organization_url,
      knowledge_base_id, revision_id, category, entry_key, title, content, status,
      source_work_item_ids, evidence, metadata_json, content_hash,
      superseded_by_entry_version_id, created_at, updated_at
    ) VALUES (
      @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
      @knowledgeBaseId, @revisionId, @category, @entryKey, @title, @content, 'active',
      @sourceWorkItemIds, @evidence, @metadataJson, @contentHash,
      NULL, @createdAt, @updatedAt
    )
  `,
  );
  const supersedePrevious = db.prepare(
    `
    UPDATE project_knowledge_entry_versions
    SET status = @status,
        superseded_by_entry_version_id = @supersededBy,
        updated_at = @updatedAt
    WHERE id = @id
  `,
  );

  let createdCount = 0;
  let updatedCount = 0;
  let confirmedCount = 0;

  entries.forEach((entry) => {
    const id = createId("pkev");
    const contentHash = stableHash([entry.category, entry.entryKey, entry.title, entry.content, entry.evidence, entry.sourceWorkItemIds].join("\n"));
    const previous = previousByKey.get(knowledgeVersionKey(entry.category, entry.entryKey));

    insertVersion.run({
      id,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      knowledgeBaseId: input.knowledgeBaseId,
      revisionId,
      category: entry.category,
      entryKey: entry.entryKey,
      title: entry.title,
      content: entry.content,
      sourceWorkItemIds: JSON.stringify(entry.sourceWorkItemIds),
      evidence: entry.evidence,
      metadataJson: JSON.stringify(entry.metadata),
      contentHash,
      createdAt: now,
      updatedAt: now,
    });

    if (!previous) {
      createdCount += 1;
      return;
    }

    if (previous.content_hash === contentHash) {
      confirmedCount += 1;
    } else {
      updatedCount += 1;
    }

    supersedePrevious.run({
      id: previous.id,
      status: previous.content_hash === contentHash ? "confirmed" : "superseded",
      supersededBy: id,
      updatedAt: now,
    });
  });

  let retiredCount = 0;
  previousActive.forEach((entry) => {
    if (nextKeys.has(knowledgeVersionKey(entry.category, entry.entry_key))) return;
    retiredCount += 1;
    supersedePrevious.run({
      id: entry.id,
      status: "retired",
      supersededBy: null,
      updatedAt: now,
    });
  });

  recordProjectKnowledgeLog({
    scope,
    eventType: "knowledge.revision_saved",
    severity: "info",
    title: `Saved knowledge revision ${revisionNumber}`,
    message: `Compiled ${entries.length} active knowledge entries from ${input.sourceWorkItemCount} source work items.`,
    metadata: {
      revisionId,
      revisionNumber,
      mode: input.mode,
      createdCount,
      updatedCount,
      confirmedCount,
      retiredCount,
    },
  });

  return {
    revisionId,
    revisionNumber,
    entryCount: entries.length,
    createdCount,
    updatedCount,
    confirmedCount,
    retiredCount,
  };
}

export function recordProjectKnowledgeLog(input: {
  scope: ProjectScope;
  eventType: string;
  severity?: ProjectKnowledgeLogSeverity;
  title: string;
  message: string;
  sourceIds?: string[];
  metadata?: Record<string, unknown>;
}) {
  const scope = assertProjectScope(input.scope);
  const db = getDatabase();
  const now = nowIso();
  const id = createId("pkl");

  db.prepare(
    `
    INSERT INTO project_knowledge_log (
      id, project_id, azure_project_id, azure_project_name, azure_organization_url,
      event_type, severity, title, message, source_ids, metadata_json, created_at
    ) VALUES (
      @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
      @eventType, @severity, @title, @message, @sourceIds, @metadataJson, @createdAt
    )
  `,
  ).run({
    id,
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    eventType: input.eventType,
    severity: input.severity ?? "info",
    title: input.title,
    message: input.message,
    sourceIds: JSON.stringify(input.sourceIds ?? []),
    metadataJson: JSON.stringify(input.metadata ?? {}),
    createdAt: now,
  });

  return id;
}

export function getProjectKnowledgeLog(input: { scope: ProjectScope; limit?: number }): ProjectKnowledgeLogItem[] {
  const scope = assertProjectScope(input.scope);
  const db = getDatabase();
  const rows = db
    .prepare(
      `
      SELECT id, event_type, severity, title, message, source_ids, metadata_json, created_at
      FROM project_knowledge_log
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      ORDER BY created_at DESC
      LIMIT @limit
    `,
    )
    .all({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      limit: Math.min(100, Math.max(1, input.limit ?? 30)),
    }) as KnowledgeLogRow[];

  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    sourceIds: parseJsonArray(row.source_ids),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  }));
}

export function runProjectKnowledgeLint(input: { scope: ProjectScope }) {
  const scope = assertProjectScope(input.scope);
  const db = getDatabase();
  const now = nowIso();
  const snapshot = getActiveKnowledgeSnapshot(scope);
  const issues: Array<Omit<ProjectKnowledgeLintIssue, "id" | "createdAt" | "updatedAt" | "status">> = [];

  if (!snapshot) {
    issues.push({
      issueType: "missing_knowledge_base",
      severity: "warning",
      title: "No compiled knowledge base",
      message: "Index project context and extract the knowledge base before relying on RAG-assisted workflows.",
      sourceWorkItemIds: [],
    });
  } else {
    const knowledgeBase = JSON.parse(snapshot.validated_output) as ProjectKnowledgeBase;
    const entries = flattenProjectKnowledge(knowledgeBase);
    const sourceRows = loadSourceWorkItems(scope);
    const sourceById = new Map(sourceRows.map((source) => [source.azure_work_item_id, source]));
    const activeSourceIds = new Set(sourceRows.filter((source) => source.sync_status !== "inactive").map((source) => source.azure_work_item_id));
    const modules = new Set(knowledgeBase.modules.map((module) => normalizeKey(module.name)));
    const dependencyEndpoints = new Set([
      ...Array.from(modules),
      ...knowledgeBase.glossary.map((term) => normalizeKey(term.term)),
    ]);

    addDuplicateEntryKeyIssues(entries, issues);

    entries.forEach((entry) => {
      const missingSourceIds = entry.sourceWorkItemIds.filter((id) => !sourceById.has(id));
      const inactiveSourceIds = entry.sourceWorkItemIds.filter((id) => sourceById.get(id)?.sync_status === "inactive");

      if (missingSourceIds.length) {
        issues.push({
          issueType: "missing_source",
          severity: "error",
          title: `Missing source for ${entry.title}`,
          message: `The entry cites source work item IDs that are not present in local indexed context: ${missingSourceIds.join(", ")}.`,
          category: entry.category,
          entryKey: entry.entryKey,
          sourceWorkItemIds: missingSourceIds,
        });
      }

      if (inactiveSourceIds.length) {
        issues.push({
          issueType: "stale_source",
          severity: "warning",
          title: `Stale source for ${entry.title}`,
          message: `The entry cites work items no longer returned by the latest context sync: ${inactiveSourceIds.join(", ")}.`,
          category: entry.category,
          entryKey: entry.entryKey,
          sourceWorkItemIds: inactiveSourceIds,
        });
      }

      if (!entry.evidence.trim()) {
        issues.push({
          issueType: "missing_evidence",
          severity: "error",
          title: `Missing evidence for ${entry.title}`,
          message: "Every compiled knowledge entry must include source-backed evidence.",
          category: entry.category,
          entryKey: entry.entryKey,
          sourceWorkItemIds: entry.sourceWorkItemIds,
        });
      }

      if (!entry.sourceWorkItemIds.some((id) => activeSourceIds.has(id))) {
        issues.push({
          issueType: "no_active_source",
          severity: "warning",
          title: `No active source for ${entry.title}`,
          message: "This entry has no active source work item after the latest sync.",
          category: entry.category,
          entryKey: entry.entryKey,
          sourceWorkItemIds: entry.sourceWorkItemIds,
        });
      }
    });

    knowledgeBase.businessRules.forEach((rule) => {
      if (!rule.moduleName || modules.has(normalizeKey(rule.moduleName))) return;
      issues.push({
        issueType: "unknown_module_reference",
        severity: "warning",
        title: `Unknown module reference for ${rule.id}`,
        message: `Business rule references module "${rule.moduleName}", but no compiled module with that name exists.`,
        category: "business_rule",
        entryKey: rule.id,
        sourceWorkItemIds: rule.sourceWorkItemIds,
      });
    });

    knowledgeBase.crossDependencies.forEach((dependency) => {
      const missingEndpoints = [
        dependencyEndpoints.has(normalizeKey(dependency.sourceModule)) ? "" : dependency.sourceModule,
        dependencyEndpoints.has(normalizeKey(dependency.targetModule)) || isExternalDependencyEndpoint(dependency.targetModule, dependency.dependencyType)
          ? ""
          : dependency.targetModule,
      ].filter(Boolean);
      if (!missingEndpoints.length) return;
      issues.push({
        issueType: "unknown_dependency_endpoint",
        severity: "warning",
        title: `Unknown dependency endpoint for ${dependency.id}`,
        message: `Dependency references endpoints not present as compiled modules or glossary terms: ${missingEndpoints.join(", ")}.`,
        category: "dependency",
        entryKey: dependency.id,
        sourceWorkItemIds: dependency.sourceWorkItemIds,
      });
    });
  }

  db.prepare(
    `
    DELETE FROM project_knowledge_lint_issues
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `,
  ).run({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
  });

  const insertIssue = db.prepare(
    `
    INSERT INTO project_knowledge_lint_issues (
      id, project_id, azure_project_id, azure_project_name, azure_organization_url,
      issue_type, severity, title, message, category, entry_key,
      source_work_item_ids, status, created_at, updated_at
    ) VALUES (
      @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
      @issueType, @severity, @title, @message, @category, @entryKey,
      @sourceWorkItemIds, 'open', @createdAt, @updatedAt
    )
  `,
  );

  issues.forEach((issue) => {
    insertIssue.run({
      id: createId("pkli"),
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      issueType: issue.issueType,
      severity: issue.severity,
      title: issue.title,
      message: issue.message,
      category: issue.category ?? null,
      entryKey: issue.entryKey ?? null,
      sourceWorkItemIds: JSON.stringify(issue.sourceWorkItemIds),
      createdAt: now,
      updatedAt: now,
    });
  });

  recordProjectKnowledgeLog({
    scope,
    eventType: "knowledge.lint_completed",
    severity: issues.some((issue) => issue.severity === "error") ? "warning" : "info",
    title: "Knowledge lint completed",
    message: `Found ${issues.length} knowledge health issue${issues.length === 1 ? "" : "s"}.`,
    metadata: {
      issueCount: issues.length,
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
    },
  });

  return {
    issues: getProjectKnowledgeLintIssues({ scope }),
    summary: summarizeIssues(issues),
  };
}

export function getProjectKnowledgeLintIssues(input: { scope: ProjectScope }): ProjectKnowledgeLintIssue[] {
  const scope = assertProjectScope(input.scope);
  const db = getDatabase();
  const rows = db
    .prepare(
      `
      SELECT id, issue_type, severity, title, message, category, entry_key,
             source_work_item_ids, status, created_at, updated_at
      FROM project_knowledge_lint_issues
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      ORDER BY
        CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        created_at DESC
    `,
    )
    .all({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    }) as KnowledgeLintRow[];

  return rows.map((row) => ({
    id: row.id,
    issueType: row.issue_type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    category: row.category,
    entryKey: row.entry_key,
    sourceWorkItemIds: parseJsonArray(row.source_work_item_ids),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function exportProjectKnowledgeWiki(input: { scope: ProjectScope }) {
  const scope = assertProjectScope(input.scope);
  const snapshot = getActiveKnowledgeSnapshot(scope);
  if (!snapshot) {
    throw new Error("Extract the project knowledge base before exporting the knowledge wiki.");
  }

  const knowledgeBase = JSON.parse(snapshot.validated_output) as ProjectKnowledgeBase;
  const logs = getProjectKnowledgeLog({ scope, limit: 100 });
  const fs = getFs();
  const path = getPath();
  const exportRoot = path.join(
    process.cwd(),
    "data",
    "knowledge-wiki",
    safePathSegment(scope.azureProjectName || scope.azureProjectId),
  );

  fs.mkdirSync(exportRoot, { recursive: true });
  for (const folder of ["modules", "business-rules", "state-transitions", "glossary", "dependencies"]) {
    fs.mkdirSync(path.join(exportRoot, folder), { recursive: true });
  }

  fs.writeFileSync(path.join(exportRoot, "index.md"), renderWikiIndex(scope, knowledgeBase, snapshot), "utf8");
  fs.writeFileSync(path.join(exportRoot, "log.md"), renderWikiLog(logs), "utf8");

  knowledgeBase.modules.forEach((item) => {
    writeWikiPage(exportRoot, "modules", item.id, renderWikiPage({
      title: item.name,
      category: "module",
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      body: [item.description].filter(Boolean).join("\n\n"),
    }));
  });
  knowledgeBase.businessRules.forEach((item) => {
    writeWikiPage(exportRoot, "business-rules", item.id, renderWikiPage({
      title: item.rule,
      category: "business_rule",
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      body: [
        item.moduleName ? `Module: ${item.moduleName}` : "",
        `Source field: ${item.sourceField}`,
      ].filter(Boolean).join("\n\n"),
    }));
  });
  knowledgeBase.stateTransitions.forEach((item) => {
    writeWikiPage(exportRoot, "state-transitions", item.id, renderWikiPage({
      title: item.workflowName,
      category: "state_transition",
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      body: [
        item.fromState || item.toState ? `Transition: ${item.fromState ?? "unspecified"} -> ${item.toState ?? "unspecified"}` : "",
        `Trigger or condition: ${item.triggerOrCondition}`,
        item.actor ? `Actor: ${item.actor}` : "",
        item.moduleName ? `Module: ${item.moduleName}` : "",
      ].filter(Boolean).join("\n\n"),
    }));
  });
  knowledgeBase.glossary.forEach((item) => {
    writeWikiPage(exportRoot, "glossary", item.term, renderWikiPage({
      title: item.term,
      category: "glossary",
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      body: [`Type: ${item.type}`, item.definition].join("\n\n"),
    }));
  });
  knowledgeBase.crossDependencies.forEach((item) => {
    writeWikiPage(exportRoot, "dependencies", item.id, renderWikiPage({
      title: `${item.sourceModule} -> ${item.targetModule}`,
      category: "dependency",
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      body: [`Type: ${item.dependencyType}`, item.description].join("\n\n"),
    }));
  });

  recordProjectKnowledgeLog({
    scope,
    eventType: "knowledge.exported",
    severity: "info",
    title: "Exported knowledge wiki",
    message: `Exported the compiled project knowledge wiki to ${exportRoot}.`,
    metadata: { exportRoot },
  });

  return {
    exportRoot,
    fileCount:
      2 +
      knowledgeBase.modules.length +
      knowledgeBase.businessRules.length +
      knowledgeBase.stateTransitions.length +
      knowledgeBase.glossary.length +
      knowledgeBase.crossDependencies.length,
  };
}

export function promoteContextChatbotAnswer(input: {
  scope: ProjectScope;
  answer: string;
  citations: Array<{
    sourceId: string;
    sourceType: "project_context" | "project_knowledge";
    workItemId?: string;
    sourceWorkItemIds?: string[];
  }>;
}) {
  const scope = assertProjectScope(input.scope);
  const answer = input.answer.trim();
  if (!answer) throw new Error("Cannot promote an empty chatbot answer.");
  if (!input.citations.length) throw new Error("Promoted knowledge must be backed by at least one local citation.");

  const sourceIds = Array.from(
    new Set(
      input.citations.flatMap((citation) => [
        citation.workItemId,
        ...(citation.sourceWorkItemIds ?? []),
        citation.sourceId.startsWith("WI:") ? citation.sourceId.slice(3) : undefined,
      ]).filter((value): value is string => Boolean(value)),
    ),
  );
  if (!sourceIds.length) throw new Error("Promoted knowledge must cite at least one source work item.");

  const db = getDatabase();
  const now = nowIso();
  const snapshot = getActiveKnowledgeSnapshot(scope);
  const revisionId = snapshot ? latestRevisionId(scope) : createId("pkr_promoted");
  const id = createId("pkev");
  const entryKey = `chat-insight-${stableHash(answer).slice(0, 12)}`;

  db.prepare(
    `
    INSERT INTO project_knowledge_entry_versions (
      id, project_id, azure_project_id, azure_project_name, azure_organization_url,
      knowledge_base_id, revision_id, category, entry_key, title, content, status,
      source_work_item_ids, evidence, metadata_json, content_hash,
      superseded_by_entry_version_id, created_at, updated_at
    ) VALUES (
      @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
      @knowledgeBaseId, @revisionId, 'chat_insight', @entryKey, @title, @content, 'candidate',
      @sourceWorkItemIds, @evidence, @metadataJson, @contentHash,
      NULL, @createdAt, @updatedAt
    )
  `,
  ).run({
    id,
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    knowledgeBaseId: snapshot?.id ?? "pending",
    revisionId,
    entryKey,
    title: answer.split(/\s+/).slice(0, 12).join(" "),
    content: answer,
    sourceWorkItemIds: JSON.stringify(sourceIds),
    evidence: input.citations.map((citation) => citation.sourceId).join(", "),
    metadataJson: JSON.stringify({ citations: input.citations }),
    contentHash: stableHash(answer),
    createdAt: now,
    updatedAt: now,
  });

  recordProjectKnowledgeLog({
    scope,
    eventType: "knowledge.chat_insight_promoted",
    severity: "info",
    title: "Saved chatbot answer as candidate knowledge",
    message: "A cited Context Chatbot answer was saved to the knowledge log for review.",
    sourceIds,
    metadata: { entryVersionId: id, entryKey },
  });

  return { entryVersionId: id, entryKey, sourceIds };
}

function nextRevisionNumber(scope: ProjectScope) {
  const row = getDatabase()
    .prepare(
      `
      SELECT MAX(revision_number) AS revision_number
      FROM project_knowledge_revisions
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
    `,
    )
    .get({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    }) as { revision_number: number | null };
  return (row.revision_number ?? 0) + 1;
}

function latestRevisionId(scope: ProjectScope) {
  const row = getDatabase()
    .prepare(
      `
      SELECT id
      FROM project_knowledge_revisions
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      ORDER BY revision_number DESC
      LIMIT 1
    `,
    )
    .get({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    }) as { id: string } | undefined;
  return row?.id ?? "pending";
}

function getActiveKnowledgeSnapshot(scope: ProjectScope) {
  return getDatabase()
    .prepare(
      `
      SELECT id, provider, model_name, source_work_item_count, raw_output, validated_output
      FROM project_knowledge_base
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      LIMIT 1
    `,
    )
    .get({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    }) as KnowledgeSnapshotRow | undefined;
}

function loadSourceWorkItems(scope: ProjectScope) {
  return getDatabase()
    .prepare(
      `
      SELECT azure_work_item_id, title, COALESCE(sync_status, 'active') AS sync_status
      FROM azure_devops_work_items
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
    `,
    )
    .all({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    }) as SourceWorkItemRow[];
}

function addDuplicateEntryKeyIssues(
  entries: KnowledgeEntry[],
  issues: Array<Omit<ProjectKnowledgeLintIssue, "id" | "createdAt" | "updatedAt" | "status">>,
) {
  const grouped = new Map<string, KnowledgeEntry[]>();
  entries.forEach((entry) => {
    const key = knowledgeVersionKey(entry.category, entry.entryKey);
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  });

  grouped.forEach((items, key) => {
    if (items.length < 2) return;
    issues.push({
      issueType: "duplicate_entry",
      severity: "warning",
      title: `Duplicate knowledge entry ${key}`,
      message: "Multiple compiled entries share the same category and key.",
      category: items[0].category,
      entryKey: items[0].entryKey,
      sourceWorkItemIds: Array.from(new Set(items.flatMap((item) => item.sourceWorkItemIds))),
    });
  });
}

function flattenProjectKnowledge(knowledgeBase: ProjectKnowledgeBase): KnowledgeEntry[] {
  return [
    ...knowledgeBase.modules.map((item) => ({
      category: "module",
      entryKey: item.id,
      title: item.name,
      content: [item.description, `Evidence: ${item.evidence}`].filter(Boolean).join("\n"),
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      metadata: item,
    })),
    ...knowledgeBase.businessRules.map((item) => ({
      category: "business_rule",
      entryKey: item.id,
      title: item.rule,
      content: [item.rule, item.moduleName ? `Module: ${item.moduleName}` : "", `Source field: ${item.sourceField}`, `Evidence: ${item.evidence}`].filter(Boolean).join("\n"),
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      metadata: item,
    })),
    ...knowledgeBase.stateTransitions.map((item) => ({
      category: "state_transition",
      entryKey: item.id,
      title: item.workflowName,
      content: [
        item.fromState || item.toState ? `Transition: ${item.fromState ?? "unspecified"} -> ${item.toState ?? "unspecified"}` : "",
        item.triggerOrCondition,
        item.actor ? `Actor: ${item.actor}` : "",
        item.moduleName ? `Module: ${item.moduleName}` : "",
        `Evidence: ${item.evidence}`,
      ].filter(Boolean).join("\n"),
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      metadata: item,
    })),
    ...knowledgeBase.glossary.map((item) => ({
      category: "glossary",
      entryKey: item.term,
      title: item.term,
      content: [`Type: ${item.type}`, item.definition, `Evidence: ${item.evidence}`].join("\n"),
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      metadata: item,
    })),
    ...knowledgeBase.crossDependencies.map((item) => ({
      category: "dependency",
      entryKey: item.id,
      title: `${item.sourceModule} -> ${item.targetModule}`,
      content: [`Type: ${item.dependencyType}`, item.description, `Evidence: ${item.evidence}`].join("\n"),
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      metadata: item,
    })),
  ];
}

function summarizeIssues(issues: Array<{ severity: ProjectKnowledgeLogSeverity }>) {
  return {
    total: issues.length,
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    info: issues.filter((issue) => issue.severity === "info").length,
  };
}

function writeWikiPage(exportRoot: string, folder: string, slug: string, content: string) {
  getFs().writeFileSync(getPath().join(exportRoot, folder, `${safePathSegment(slug)}.md`), content, "utf8");
}

function renderWikiIndex(scope: ProjectScope, knowledgeBase: ProjectKnowledgeBase, snapshot: KnowledgeSnapshotRow) {
  return [
    "---",
    `project: ${yamlString(scope.azureProjectName)}`,
    `azureProjectId: ${yamlString(scope.azureProjectId)}`,
    `knowledgeBaseId: ${yamlString(snapshot.id)}`,
    `sourceWorkItemCount: ${snapshot.source_work_item_count}`,
    "---",
    "",
    `# ${scope.azureProjectName} Knowledge Wiki`,
    "",
    "## Categories",
    `- Modules: ${knowledgeBase.modules.length}`,
    `- Business rules: ${knowledgeBase.businessRules.length}`,
    `- State transitions: ${knowledgeBase.stateTransitions.length}`,
    `- Glossary: ${knowledgeBase.glossary.length}`,
    `- Dependencies: ${knowledgeBase.crossDependencies.length}`,
    "",
    "## Operating Principle",
    "Raw Azure DevOps work items remain the source of truth. These pages are compiled, source-cited knowledge for navigation, QA analysis, and review.",
  ].join("\n");
}

function renderWikiLog(logs: ProjectKnowledgeLogItem[]) {
  return [
    "# Knowledge Log",
    "",
    ...logs.map((log) => [
      `## ${log.createdAt} - ${log.title}`,
      "",
      `- Type: ${log.eventType}`,
      `- Severity: ${log.severity}`,
      log.sourceIds.length ? `- Sources: ${log.sourceIds.join(", ")}` : "",
      "",
      log.message,
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}

function renderWikiPage(input: {
  title: string;
  category: string;
  sourceWorkItemIds: string[];
  evidence: string;
  body: string;
}) {
  return [
    "---",
    `title: ${yamlString(input.title)}`,
    `category: ${yamlString(input.category)}`,
    "status: active",
    `sourceWorkItemIds: [${input.sourceWorkItemIds.map(yamlString).join(", ")}]`,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.body,
    "",
    "## Evidence",
    input.evidence,
  ].join("\n");
}

function safePathSegment(value: string) {
  const slug = value
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "knowledge";
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isExternalDependencyEndpoint(endpoint: string, dependencyType: string) {
  const value = `${endpoint} ${dependencyType}`.toLowerCase();
  return /\b(external|link|links|url|urls|website|web|app|download|social|blog|support|api|integration|provider|service|services)\b/.test(value);
}

function knowledgeVersionKey(category: string, entryKey: string) {
  return `${category}:${normalizeKey(entryKey)}`;
}

function stableHash(value: string) {
  return getCrypto().createHash("sha256").update(value).digest("hex");
}

function parseJsonArray(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function getFs() {
  return nativeRequire("fs") as FsModule;
}

function getPath() {
  return nativeRequire("path") as PathModule;
}

function getCrypto() {
  return nativeRequire("crypto") as CryptoModule;
}

function nativeRequire(specifier: string): unknown {
  const requireFunction = eval("require") as NodeRequire;
  return requireFunction(specifier);
}
