import { DEFAULT_SCREENSHOT_POLICY, type ScreenshotPolicy } from "@/modules/test-execution/screenshot-policy";
import type { ConnectionInput, ConnectionView, StepPhase } from "@/modules/test-execution/execution-connections.shared";

/* --------------------------------------------------------------------------
 * Client-side draft model for the Test Execution workbench. Runs stay
 * immutable server-side; everything the user authors lives here until
 * "Approve & Execute" turns the draft into a run-creation payload.
 * ------------------------------------------------------------------------ */

export type CaseSource = "plan-suite" | "user-story" | "manual";

export type DraftStep = {
  localId: string;
  action: string;
  expectedResult: string;
  phase?: StepPhase;
};

export type DraftConnection = ConnectionInput & { localId: string };

export type DraftCase = {
  localId: string;
  source: CaseSource;
  azureTestCaseId?: number;
  azureTestPointId?: number;
  azurePlanId?: number;
  azureSuiteId?: number;
  title: string;
  steps: DraftStep[];
};

/** Where a masked secret's saved value lives; the browser never holds the value. */
export type SavedValueRef = { kind: "run" | "profile"; id: string; title: string };

export type TestDataDraftEntry = {
  localId: string;
  title: string;
  isSecret: boolean;
  /** Empty string for an untouched saved secret (masked in the UI). */
  value: string;
  savedRef?: SavedValueRef;
};

export type DraftSetup = {
  profileId: string | null;
  browserEnabled: boolean;
  connections: DraftConnection[];
  /** Optional per-run identity shown in history next to the date. */
  runName: string;
  baseUrl: string;
  executionNotes: string;
  screenshotPolicy: ScreenshotPolicy;
  /** Browser window mode; headless is the default for unattended runs. */
  headless: boolean;
  /** Kept as strings so empty inputs and localStorage round-trips stay lossless. */
  viewportWidth: string;
  viewportHeight: string;
  testData: TestDataDraftEntry[];
};

export type ExecutionDraft = {
  setup: DraftSetup;
  cases: DraftCase[];
  /** Last plan/suite import, recorded on the run for history display only. */
  provenance: { planId?: number; suiteId?: number };
};

let localIdCounter = 0;

export function newLocalId(prefix: string): string {
  localIdCounter += 1;
  return `${prefix}-${localIdCounter}`;
}

export function createEmptyDraft(): ExecutionDraft {
  return {
    setup: {
      profileId: null,
      browserEnabled: true,
      connections: [],
      runName: "",
      baseUrl: "",
      executionNotes: "",
      screenshotPolicy: DEFAULT_SCREENSHOT_POLICY,
      headless: true,
      viewportWidth: String(DEFAULT_VIEWPORT_WIDTH),
      viewportHeight: String(DEFAULT_VIEWPORT_HEIGHT),
      testData: [],
    },
    cases: [],
    provenance: {},
  };
}

export function newDraftStep(step?: { action?: string; expectedResult?: string | null; phase?: StepPhase }): DraftStep {
  return { localId: newLocalId("step"), action: step?.action ?? "", expectedResult: step?.expectedResult ?? "", phase: step?.phase ?? "scenario" };
}

export function newDraftConnection(kind: "api" | "database"): DraftConnection {
  const common = { localId: newLocalId("connection"), alias: "", allowWrites: false, credentials: {} };
  return kind === "api"
    ? { ...common, kind, baseUrl: "", auth: { type: "none" } }
    : { ...common, kind, engine: "postgres", host: "", database: "", username: "" };
}

function savedConnections(connections: readonly ConnectionView[] | undefined, source: "run" | "profile", id: string): DraftConnection[] {
  return (connections ?? []).map((connection) => {
    const credentials = Object.fromEntries(Object.entries(connection.savedCredentials ?? {})
      .filter(([, saved]) => saved)
      .map(([field]) => [field, source === "run"
        ? { fromRunId: id, sourceAlias: connection.alias, sourceField: field }
        : { fromProfileId: id, sourceAlias: connection.alias, sourceField: field }]));
    const { savedCredentials: _, ...settings } = connection;
    return { ...settings, localId: newLocalId("connection"), credentials } as DraftConnection;
  });
}

export function newManualCase(existingCount: number): DraftCase {
  return {
    localId: newLocalId("case"),
    source: "manual",
    title: `Manual case ${existingCount + 1}`,
    steps: [newDraftStep()],
  };
}

export function newTestDataEntry(): TestDataDraftEntry {
  return { localId: newLocalId("data"), title: "", isSecret: false, value: "" };
}

/** Shape returned by both import sources once normalized by the client. */
export type ImportedCase = {
  azureTestCaseId?: number;
  azureTestPointId?: number;
  azurePlanId?: number;
  azureSuiteId?: number;
  title: string;
  steps: Array<{ action: string; expectedResult?: string | null }>;
  source: CaseSource;
};

function importedCaseKey(input: { azureTestCaseId?: number; azureTestPointId?: number }): string | null {
  if (!input.azureTestCaseId) return null;
  return `${input.azureTestCaseId}:${input.azureTestPointId ?? ""}`;
}

export function isCaseAlreadyImported(cases: readonly DraftCase[], candidate: { azureTestCaseId?: number; azureTestPointId?: number }): boolean {
  const key = importedCaseKey(candidate);
  if (!key) return false;
  return cases.some((existing) => importedCaseKey(existing) === key);
}

/** Appends imported cases, skipping ones already in the working set. */
export function mergeImportedCases(cases: readonly DraftCase[], imported: readonly ImportedCase[]): DraftCase[] {
  const merged = [...cases];
  for (const candidate of imported) {
    if (isCaseAlreadyImported(merged, candidate)) continue;
    merged.push({
      localId: newLocalId("case"),
      source: candidate.source,
      azureTestCaseId: candidate.azureTestCaseId,
      azureTestPointId: candidate.azureTestPointId,
      azurePlanId: candidate.azurePlanId,
      azureSuiteId: candidate.azureSuiteId,
      title: candidate.title,
      steps: candidate.steps.length ? candidate.steps.map(newDraftStep) : [newDraftStep()],
    });
  }
  return merged;
}

/** Structural subset of the run-detail response the rerun flow consumes. */
export type RunDetailForDraft = {
  id: string;
  name?: string | null;
  baseUrl: string | null;
  browserEnabled?: boolean;
  connections?: ConnectionView[];
  executionNotes: string | null;
  screenshotPolicy: ScreenshotPolicy;
  headless?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  azurePlanId: number | null;
  azureSuiteId: number | null;
  testData?: Array<{ title: string; isSecret: boolean; value: string | null }>;
  cases: Array<{
    azureTestCaseId: number | null;
    azureTestPointId: number | null;
    azurePlanId?: number | null;
    azureSuiteId?: number | null;
    title: string;
    steps: Array<{ action: string; expectedResult: string | null; phase?: StepPhase }>;
  }>;
};

/**
 * Rebuilds an editable draft from a finished run: settings and non-secret
 * values prefill directly; secrets become masked rows referencing the source
 * run; cases come back with statuses stripped and publish identity carried.
 */
export function draftFromRunDetail(detail: RunDetailForDraft): ExecutionDraft {
  return {
    setup: {
      profileId: null,
      browserEnabled: detail.browserEnabled ?? true,
      connections: savedConnections(detail.connections, "run", detail.id),
      runName: detail.name ?? "",
      baseUrl: detail.baseUrl ?? "",
      executionNotes: detail.executionNotes ?? "",
      screenshotPolicy: detail.screenshotPolicy,
      headless: detail.headless ?? true,
      viewportWidth: String(detail.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH),
      viewportHeight: String(detail.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT),
      testData: (detail.testData ?? []).map((entry) => ({
        localId: newLocalId("data"),
        title: entry.title,
        isSecret: entry.isSecret,
        value: entry.isSecret ? "" : entry.value ?? "",
        savedRef: entry.isSecret ? { kind: "run", id: detail.id, title: entry.title } : undefined,
      })),
    },
    cases: detail.cases.map((testCase) => ({
      localId: newLocalId("case"),
      source: testCase.azureTestPointId ? "plan-suite" : testCase.azureTestCaseId ? "user-story" : "manual",
      azureTestCaseId: testCase.azureTestCaseId ?? undefined,
      azureTestPointId: testCase.azureTestPointId ?? undefined,
      // Cases persisted before the per-case plan/suite columns fall back to the
      // run-level ids so legacy runs stay rerunnable and publishable.
      azurePlanId: testCase.azurePlanId ?? (testCase.azureTestPointId ? detail.azurePlanId ?? undefined : undefined),
      azureSuiteId: testCase.azureSuiteId ?? (testCase.azureTestPointId ? detail.azureSuiteId ?? undefined : undefined),
      title: testCase.title,
      steps: testCase.steps.length ? testCase.steps.map(newDraftStep) : [newDraftStep()],
    })),
    provenance: { planId: detail.azurePlanId ?? undefined, suiteId: detail.azureSuiteId ?? undefined },
  };
}

export type ProfileForDraft = {
  id: string;
  browserEnabled?: boolean;
  connections?: ConnectionView[];
  baseUrl: string | null;
  executionNotes: string | null;
  screenshotPolicy: ScreenshotPolicy;
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
  testData: Array<{ title: string; isSecret: boolean; value: string | null }>;
};

/**
 * Replaces the setup with a profile's saved values; the case list and the
 * per-run identity (run name) are untouched — profiles describe environments,
 * not individual runs.
 */
export function applyProfileToDraft(draft: ExecutionDraft, profile: ProfileForDraft): ExecutionDraft {
  return {
    ...draft,
    setup: {
      profileId: profile.id,
      browserEnabled: profile.browserEnabled ?? true,
      connections: savedConnections(profile.connections, "profile", profile.id),
      runName: draft.setup.runName,
      baseUrl: profile.baseUrl ?? "",
      executionNotes: profile.executionNotes ?? "",
      screenshotPolicy: profile.screenshotPolicy,
      headless: profile.headless,
      viewportWidth: String(profile.viewportWidth),
      viewportHeight: String(profile.viewportHeight),
      testData: profile.testData.map((entry) => ({
        localId: newLocalId("data"),
        title: entry.title,
        isSecret: entry.isSecret,
        value: entry.isSecret ? "" : entry.value ?? "",
        savedRef: entry.isSecret ? { kind: "profile", id: profile.id, title: entry.title } : undefined,
      })),
    },
  };
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Mirrors the run-creation API caps so the review step blocks before a 400. */
export const RUN_CASE_LIMIT = 200;
export const CASE_STEP_LIMIT = 100;
export const STEP_TEXT_LIMIT = 4000;
export const CASE_TITLE_LIMIT = 400;
export const RUN_NAME_LIMIT = 200;
export const VIEWPORT_WIDTH_MIN = 320;
export const VIEWPORT_WIDTH_MAX = 3840;
export const VIEWPORT_HEIGHT_MIN = 240;
export const VIEWPORT_HEIGHT_MAX = 2160;
export const DEFAULT_VIEWPORT_WIDTH = 1920;
export const DEFAULT_VIEWPORT_HEIGHT = 1080;

export function caseIsReady(testCase: DraftCase): boolean {
  return Boolean(testCase.title.trim()) && testCase.steps.length > 0 && testCase.steps.every((step) => Boolean(step.action.trim()));
}

/** True when losing this draft would cost the user authored work. */
export function draftHasContent(draft: ExecutionDraft): boolean {
  return draft.cases.length > 0
    || draft.setup.connections.length > 0
    || Boolean(draft.setup.baseUrl.trim())
    || Boolean(draft.setup.executionNotes.trim())
    || draft.setup.testData.some((entry) => entry.title.trim() || entry.value || entry.savedRef);
}

/** Blocking problems in the test-data rows alone (shared by run + profile saves). */
export function testDataIssues(entries: readonly TestDataDraftEntry[]): string[] {
  const issues: string[] = [];
  const seenTitles = new Set<string>();
  for (const entry of entries) {
    const hasContent = entry.title.trim() || entry.value || entry.savedRef;
    if (!hasContent) continue; // fully blank rows are pruned at submit
    if (!entry.title.trim()) { issues.push("Every test data entry needs a title."); continue; }
    const key = entry.title.trim().toLowerCase();
    if (seenTitles.has(key)) issues.push(`Test data titles must be unique — "${entry.title.trim()}" is used more than once.`);
    seenTitles.add(key);
    if (!entry.value && !(entry.isSecret && entry.savedRef)) {
      issues.push(`Enter a value for "${entry.title.trim()}" or remove it.`);
    }
  }
  return issues;
}

/**
 * Non-integer or out-of-range viewport dimensions → authored issue messages.
 * Shared by run gating, profile saves, and the setup step's inline feedback.
 */
export function viewportIssues(setup: Pick<DraftSetup, "viewportWidth" | "viewportHeight">): string[] {
  const issues: string[] = [];
  const width = Number(setup.viewportWidth.trim());
  if (!Number.isInteger(width) || width < VIEWPORT_WIDTH_MIN || width > VIEWPORT_WIDTH_MAX) {
    issues.push(`Viewport width must be between ${VIEWPORT_WIDTH_MIN} and ${VIEWPORT_WIDTH_MAX} pixels.`);
  }
  const height = Number(setup.viewportHeight.trim());
  if (!Number.isInteger(height) || height < VIEWPORT_HEIGHT_MIN || height > VIEWPORT_HEIGHT_MAX) {
    issues.push(`Viewport height must be between ${VIEWPORT_HEIGHT_MIN} and ${VIEWPORT_HEIGHT_MAX} pixels.`);
  }
  return issues;
}

/** Blocking problems, phrased for the review step's "cannot run yet" callout. */
export function draftIssues(draft: ExecutionDraft): string[] {
  const issues: string[] = [];
  if (!draft.setup.browserEnabled && !draft.setup.connections.length) issues.push("Enable the browser or add an API or database connection.");
  if (draft.setup.browserEnabled && !draft.setup.baseUrl.trim()) issues.push("Enter the Base URL the tests should start from.");
  else if (draft.setup.baseUrl.trim() && !isValidHttpUrl(draft.setup.baseUrl)) issues.push("The Base URL must start with http:// or https://.");
  if (draft.setup.runName.trim().length > RUN_NAME_LIMIT) issues.push(`Run names are limited to ${RUN_NAME_LIMIT} characters.`);
  if (draft.setup.browserEnabled) issues.push(...viewportIssues(draft.setup));
  const aliases = new Set<string>();
  if (draft.setup.connections.length > 20) issues.push("Use at most 20 connections.");
  for (const connection of draft.setup.connections) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(connection.alias)) issues.push(`Connection alias "${connection.alias}" must start with a lowercase letter and contain only lowercase letters, digits, or hyphens.`);
    if (aliases.has(connection.alias)) issues.push(`Connection alias "${connection.alias}" is used more than once.`);
    aliases.add(connection.alias);
    if (connection.kind === "api" && !isValidHttpUrl(connection.baseUrl)) issues.push(`API connection "${connection.alias}" needs a valid base URL.`);
    if (connection.kind === "api" && connection.openApiUrl && !isValidHttpUrl(connection.openApiUrl)) issues.push(`API connection "${connection.alias}" needs a valid OpenAPI URL.`);
    if (connection.kind === "api" && connection.auth.type === "oauth2ClientCredentials" && !isValidHttpUrl(connection.auth.tokenUrl)) issues.push(`API connection "${connection.alias}" needs a valid OAuth token URL.`);
    if (connection.kind === "database" && !connection.credentials?.url?.value && !connection.credentials?.url?.fromProfileId && !connection.credentials?.url?.fromRunId && (!connection.host || !connection.database)) issues.push(`Database connection "${connection.alias}" needs a URL or host and database.`);
  }
  if (!draft.cases.length) issues.push("Add at least one test case.");
  if (draft.cases.length > RUN_CASE_LIMIT) {
    issues.push(`Runs are limited to ${RUN_CASE_LIMIT} test cases — remove ${draft.cases.length - RUN_CASE_LIMIT} to continue.`);
  }
  const notReady = draft.cases.filter((testCase) => !caseIsReady(testCase)).length;
  if (notReady) issues.push(`${notReady} test case${notReady === 1 ? " needs" : "s need"} a title and at least one step with an instruction.`);
  const overStepLimit = draft.cases.filter((testCase) => testCase.steps.length > CASE_STEP_LIMIT);
  for (const testCase of overStepLimit) {
    issues.push(`"${testCase.title.trim() || "Untitled test case"}" has ${testCase.steps.length} steps — the limit is ${CASE_STEP_LIMIT} per case.`);
  }
  const overTitle = draft.cases.filter((testCase) => testCase.title.trim().length > CASE_TITLE_LIMIT).length;
  if (overTitle) issues.push(`${overTitle} test case title${overTitle === 1 ? " is" : "s are"} longer than ${CASE_TITLE_LIMIT} characters.`);
  const overText = draft.cases.filter((testCase) =>
    testCase.steps.some((step) => step.action.length > STEP_TEXT_LIMIT || step.expectedResult.length > STEP_TEXT_LIMIT)).length;
  if (overText) issues.push(`${overText} test case${overText === 1 ? " has" : "s have"} a step longer than ${STEP_TEXT_LIMIT} characters — shorten it before running.`);
  issues.push(...testDataIssues(draft.setup.testData));
  return issues;
}
