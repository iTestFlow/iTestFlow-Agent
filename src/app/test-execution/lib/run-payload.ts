import type { ActiveProjectScope } from "@/shared/lib/active-project";
import type { DraftCase, ExecutionDraft, TestDataDraftEntry } from "./execution-draft";

/* --------------------------------------------------------------------------
 * Draft → API payload mapping. Secret rows the user left untouched are sent
 * as references to the saved value's source (run or profile); the browser
 * never resends secret material it does not have.
 * ------------------------------------------------------------------------ */

export type TestDataPayloadEntry = {
  title: string;
  isSecret: boolean;
  value?: string;
  fromRunId?: string;
  fromProfileId?: string;
  sourceTitle?: string;
};

export function testDataToPayload(entries: readonly TestDataDraftEntry[]): TestDataPayloadEntry[] {
  const payload: TestDataPayloadEntry[] = [];
  for (const entry of entries) {
    const title = entry.title.trim();
    if (!title && !entry.value && !entry.savedRef) continue; // ignore fully blank rows
    if (!entry.isSecret) {
      payload.push({ title, isSecret: false, value: entry.value });
      continue;
    }
    if (entry.value) {
      payload.push({ title, isSecret: true, value: entry.value });
      continue;
    }
    if (entry.savedRef) {
      payload.push({
        title,
        isSecret: true,
        ...(entry.savedRef.kind === "run" ? { fromRunId: entry.savedRef.id } : { fromProfileId: entry.savedRef.id }),
        ...(entry.savedRef.title !== title ? { sourceTitle: entry.savedRef.title } : {}),
      });
      continue;
    }
    payload.push({ title, isSecret: true });
  }
  return payload;
}

function caseToPayload(testCase: DraftCase) {
  return {
    azureTestCaseId: testCase.azureTestCaseId ?? null,
    azureTestPointId: testCase.azureTestPointId ?? null,
    azurePlanId: testCase.azurePlanId ?? null,
    azureSuiteId: testCase.azureSuiteId ?? null,
    title: testCase.title.trim(),
    steps: testCase.steps
      .filter((step) => step.action.trim())
      .map((step) => ({
        action: step.action.trim(),
        phase: step.phase ?? "scenario",
        ...(step.expectedResult.trim() ? { expectedResult: step.expectedResult.trim() } : {}),
      })),
  };
}

function connectionsToPayload(connections: ExecutionDraft["setup"]["connections"]) {
  return connections.map(({ localId: _, ...connection }) => {
    if (connection.kind === "api") return {
      ...connection, alias: connection.alias.trim(), baseUrl: connection.baseUrl.trim(),
      openApiUrl: connection.openApiUrl?.trim() || null,
    };
    return {
      kind: connection.kind, alias: connection.alias.trim(), engine: connection.engine,
      allowWrites: connection.allowWrites, credentials: connection.credentials,
      ...(connection.host?.trim() ? { host: connection.host.trim() } : {}),
      ...(connection.port ? { port: connection.port } : {}),
      ...(connection.database?.trim() ? { database: connection.database.trim() } : {}),
      ...(connection.username?.trim() ? { username: connection.username.trim() } : {}),
      ...(connection.ssl !== undefined ? { ssl: connection.ssl } : {}),
      ...(connection.tlsMode ? { tlsMode: connection.tlsMode } : {}),
    };
  });
}

export function draftToRunRequest(draft: ExecutionDraft, scope: ActiveProjectScope) {
  return {
    scope,
    ...(draft.setup.runName.trim() ? { name: draft.setup.runName.trim() } : {}),
    baseUrl: draft.setup.baseUrl.trim(),
    browserEnabled: draft.setup.browserEnabled,
    connections: connectionsToPayload(draft.setup.connections),
    ...(draft.setup.executionNotes.trim() ? { executionNotes: draft.setup.executionNotes.trim() } : {}),
    screenshotPolicy: draft.setup.screenshotPolicy,
    headless: draft.setup.headless,
    viewportWidth: Number(draft.setup.viewportWidth),
    viewportHeight: Number(draft.setup.viewportHeight),
    testData: testDataToPayload(draft.setup.testData),
    ...(draft.provenance.planId ? { planId: draft.provenance.planId } : {}),
    ...(draft.provenance.suiteId ? { suiteId: draft.provenance.suiteId } : {}),
    cases: draft.cases.map(caseToPayload),
  };
}

export function setupToProfileRequest(input: {
  scope: ActiveProjectScope;
  name: string;
  setup: ExecutionDraft["setup"];
}) {
  return {
    scope: input.scope,
    name: input.name.trim(),
    baseUrl: input.setup.baseUrl.trim() || null,
    browserEnabled: input.setup.browserEnabled,
    connections: connectionsToPayload(input.setup.connections),
    executionNotes: input.setup.executionNotes.trim() || null,
    screenshotPolicy: input.setup.screenshotPolicy,
    headless: input.setup.headless,
    viewportWidth: Number(input.setup.viewportWidth),
    viewportHeight: Number(input.setup.viewportHeight),
    testData: testDataToPayload(input.setup.testData),
  };
}
