import "server-only";
import type { FinalApprovedTestCase, TestRun } from "../core/integration-types";

export type ZephyrRegion = "us" | "eu" | "au" | "de";
export type ZephyrScaleSettings = {
  apiToken: string; region: ZephyrRegion; jiraProjectKey: string; localIdFieldName: string;
  assertJiraIssueInProject: (jiraIssueId: number) => Promise<void>;
};

type Page<T> = { values?: T[]; nextStartAtId?: number; nextStartId?: number; next?: string; isLast?: boolean };
type Entity = { id?: number; key?: string; name?: string; customFields?: Record<string, unknown>; project?: { key?: string } };
type Execution = Entity & { status?: { name?: string }; testCase?: { key?: string }; testCycle?: { key?: string } };

const BASE_URLS: Record<ZephyrRegion, string> = {
  us: "https://api.zephyrscale.smartbear.com/v2",
  eu: "https://eu.api.zephyrscale.smartbear.com/v2",
  au: "https://au.api.zephyrscale.smartbear.com/v2",
  de: "https://de.api.zephyrscale.smartbear.com/v2",
};
const MAX_PAGE = 1000;
const MAX_RESULTS = 5000;
const REQUEST_TIMEOUT_MS = 30_000;

export class ZephyrScaleBackend {
  private readonly baseUrl: string;
  constructor(private readonly settings: ZephyrScaleSettings) {
    if (!settings.apiToken.trim()) throw new Error("Zephyr Scale API token is required.");
    if (!/^[A-Z][A-Z_0-9]+$/.test(settings.jiraProjectKey)) throw new Error("Zephyr Scale Jira project key is invalid.");
    if (!settings.localIdFieldName.trim() || settings.localIdFieldName.length > 255) throw new Error("Zephyr Scale local identity field is invalid.");
    this.baseUrl = BASE_URLS[settings.region];
    if (!this.baseUrl) throw new Error("Zephyr Scale region is invalid.");
  }

  async listTestCases(limit = 200): Promise<Array<{ id: string; name: string; raw: Entity }>> {
    const values = await this.paginate<Entity>("/testcases", limit);
    return values.map((item) => ({ id: this.assertEntityKey(item, "T"), name: item.name?.trim() || `Zephyr Test Case ${item.key}`, raw: item }));
  }

  async listTestCycles(limit = 200): Promise<Array<{ id: string; name: string; raw: Entity }>> {
    const values = await this.paginate<Entity>("/testcycles", limit);
    return values.map((item) => ({ id: this.assertEntityKey(item, "R"), name: item.name?.trim() || `Zephyr Test Cycle ${item.key}`, raw: item }));
  }

  async listTestExecutions(limit = 200): Promise<TestRun[]> {
    const values = await this.paginate<Execution>("/testexecutions", limit);
    return values.map((item) => ({ id: this.assertEntityKey(item, "E"), name: `Zephyr Test Execution ${item.key}`, state: item.status?.name, raw: item }));
  }

  async createTestCase(input: { projectId: string; testCase: FinalApprovedTestCase }): Promise<{ success: boolean; azureTestCaseId?: string }> {
    this.assertProject(input.projectId);
    if (input.testCase.steps.length > 100) throw new Error("Zephyr Scale supports at most 100 Test Case steps per publish.");
    const found = await this.findByLocalId("/testcases", input.testCase.localId, "T");
    let key = found;
    if (!key) {
      const created = await this.request<Entity>("/testcases", { method: "POST", body: JSON.stringify({
        projectKey: this.settings.jiraProjectKey, name: requiredText(input.testCase.title, "Test Case title is required."),
        objective: input.testCase.description, precondition: input.testCase.preconditions,
        labels: [...new Set([...(input.testCase.tags ?? []), "itestflow"])],
        customFields: { [this.settings.localIdFieldName]: requiredText(input.testCase.localId, "Test Case local ID is required.") },
      }) });
      key = this.assertEntityKey(created, "T");
    }
    await this.request(`/testcases/${encodeURIComponent(key)}/teststeps`, { method: "POST", body: JSON.stringify({
      mode: "OVERWRITE", items: input.testCase.steps.map((step) => ({ inline: { description: step.action, testData: "", expectedResult: step.expectedResult } })),
    }) });
    return { success: true, azureTestCaseId: key };
  }

  async createTestCycle(input: { projectId: string; localId: string; name: string }): Promise<string> {
    this.assertProject(input.projectId);
    const found = await this.findByLocalId("/testcycles", input.localId, "R");
    if (found) return found;
    const created = await this.request<Entity>("/testcycles", { method: "POST", body: JSON.stringify({
      projectKey: this.settings.jiraProjectKey, name: requiredText(input.name, "Test Cycle name is required."),
      customFields: { [this.settings.localIdFieldName]: requiredText(input.localId, "Test Cycle local ID is required.") },
    }) });
    return this.assertEntityKey(created, "R");
  }

  async reconcileExecution(input: { projectId: string; testCaseKey: string; testCycleKey: string; statusName: string; stepResults?: Array<{ statusName: string; actualResult?: string }> }): Promise<string> {
    this.assertProject(input.projectId);
    await this.assertRemoteEntity("/testcases", input.testCaseKey, "T");
    await this.assertRemoteEntity("/testcycles", input.testCycleKey, "R");
    const query = new URLSearchParams({ projectKey: this.settings.jiraProjectKey, testCase: input.testCaseKey, testCycle: input.testCycleKey, limit: "2" });
    const page = await this.request<Page<Execution>>(`/testexecutions?${query}`);
    const values = page.values ?? [];
    if (values.length > 1) throw new Error("Multiple Zephyr Scale executions use the same Case-Cycle identity.");
    const body = { statusName: requiredText(input.statusName, "Execution status is required."), testScriptResults: input.stepResults ?? [] };
    if (values[0]) {
      const key = this.assertEntityKey(values[0], "E");
      await this.request(`/testexecutions/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ statusName: body.statusName }) });
      if (input.stepResults !== undefined) await this.request(`/testexecutions/${encodeURIComponent(key)}/teststeps`, { method: "PUT", body: JSON.stringify({ steps: body.testScriptResults }) });
      return key;
    }
    const created = await this.request<Entity>("/testexecutions", { method: "POST", body: JSON.stringify({
      projectKey: this.settings.jiraProjectKey, testCaseKey: input.testCaseKey, testCycleKey: input.testCycleKey, ...body,
    }) });
    if (!Number.isSafeInteger(created.id) || Number(created.id) <= 0) throw new Error("Zephyr Scale returned an invalid execution identity.");
    return this.assertEntityKey(await this.request<Entity>(`/testexecutions/${created.id}`), "E");
  }

  async linkTestCaseToJiraIssue(input: { projectId: string; testCaseKey: string; jiraIssueId: number }): Promise<void> {
    this.assertProject(input.projectId);
    await this.assertRemoteEntity("/testcases", input.testCaseKey, "T");
    if (!Number.isSafeInteger(input.jiraIssueId) || input.jiraIssueId <= 0) throw new Error("Jira issue ID is invalid.");
    await this.settings.assertJiraIssueInProject(input.jiraIssueId);
    const links = await this.request<{ issues?: Array<{ issueId?: number }> }>(`/testcases/${encodeURIComponent(input.testCaseKey)}/links`);
    if (links.issues?.some((link) => link.issueId === input.jiraIssueId)) return;
    await this.request(`/testcases/${encodeURIComponent(input.testCaseKey)}/links/issues`, { method: "POST", body: JSON.stringify({ issueId: input.jiraIssueId }) });
  }

  private assertProject(projectId: string) { if (projectId !== this.settings.jiraProjectKey) throw new Error("The selected Jira project does not match the Zephyr Scale target."); }
  private assertEntityKey(entity: Entity, type: "T" | "R" | "E"): string {
    const key = entity.key?.trim();
    if (!key || !new RegExp(`^${escapeRegex(this.settings.jiraProjectKey)}-${type}[0-9]+$`).test(key) || (entity.project?.key && entity.project.key !== this.settings.jiraProjectKey)) throw new Error("The Zephyr Scale entity is not in the selected Jira project.");
    return key;
  }
  private async assertRemoteEntity(path: string, key: string, type: "T" | "R"): Promise<void> {
    if (!new RegExp(`^${escapeRegex(this.settings.jiraProjectKey)}-${type}[0-9]+$`).test(key)) throw new Error("The Zephyr Scale entity is not in the selected Jira project.");
    this.assertEntityKey(await this.request<Entity>(`${path}/${encodeURIComponent(key)}`), type);
  }
  private async findByLocalId(path: string, localId: string, type: "T" | "R"): Promise<string | undefined> {
    const id = requiredText(localId, "Zephyr Scale local ID is required.");
    const values = await this.paginate<Entity>(path, MAX_RESULTS, true);
    const matches = values.filter((item) => item.customFields?.[this.settings.localIdFieldName] === id);
    if (matches.length > 1) throw new Error("Multiple Zephyr Scale artifacts use the same iTestFlow identity.");
    return matches[0] ? this.assertEntityKey(matches[0], type) : undefined;
  }
  private async paginate<T>(path: string, requested: number, requireComplete = false): Promise<T[]> {
    const limit = clampLimit(requested); const output: T[] = []; let startAtId: number | undefined;
    while (output.length < limit) {
      const query = new URLSearchParams({ projectKey: this.settings.jiraProjectKey, limit: String(Math.min(MAX_PAGE, limit - output.length)) });
      if (startAtId !== undefined) query.set("startAtId", String(startAtId));
      const page = await this.request<Page<T>>(`${path}?${query}`); const values = page.values ?? []; output.push(...values);
      const next = page.nextStartAtId ?? page.nextStartId;
      if (page.isLast === true || !values.length || next === undefined || next === startAtId) break;
      if (requireComplete && output.length >= limit) throw new Error("Zephyr Scale reached the safe identity search limit before completing the scan.");
      startAtId = next;
    }
    return output.slice(0, limit);
  }
  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try { response = await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal, cache: "no-store", headers: { Authorization: `Bearer ${this.settings.apiToken}`, Accept: "application/json", "Content-Type": "application/json" } }); }
    catch { clearTimeout(timeout); throw new Error("Zephyr Scale is unavailable."); }
    try {
      if (!response.ok) throw new Error("Zephyr Scale request failed.");
      if (response.status === 204) return undefined as T;
      try { return await response.json() as T; }
      catch { throw new Error(controller.signal.aborted ? "Zephyr Scale is unavailable." : "Zephyr Scale returned an invalid response."); }
    } finally { clearTimeout(timeout); }
  }
}
function clampLimit(value: number) { return Math.min(Math.max(Math.trunc(Number.isFinite(value) ? value : 0), 1), MAX_RESULTS); }
function requiredText(value: string, message: string) { if (!value.trim()) throw new Error(message); return value; }
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
