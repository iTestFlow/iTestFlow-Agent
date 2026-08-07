import "server-only";

import { createHash } from "node:crypto";

import type { Requirement, TestCase } from "@/modules/integrations/core/integration-types";

/**
 * Immutable source snapshot payload builders. The content hash is computed
 * over a canonical (sorted-key) JSON encoding so identical sources always
 * hash identically regardless of property order.
 */

export type SourceSnapshotInput = {
  kind: "user_story" | "test_case";
  azureWorkItemId: string;
  azureRevision: number | null;
  payload: Record<string, unknown>;
  contentHash: string;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashSnapshotPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export function buildStorySnapshot(story: Requirement): SourceSnapshotInput {
  const payload: Record<string, unknown> = {
    id: story.id,
    title: story.title,
    workItemType: story.workItemType,
    state: story.state ?? null,
    description: story.description ?? null,
    acceptanceCriteria: story.acceptanceCriteria ?? null,
    revision: story.revision ?? null,
    tags: story.tags ?? [],
  };
  return {
    kind: "user_story",
    azureWorkItemId: story.id,
    azureRevision: story.revision ?? null,
    payload,
    contentHash: hashSnapshotPayload(payload),
  };
}

export function buildTestCaseSnapshot(testCase: TestCase): SourceSnapshotInput {
  const azureId = testCase.azureTestCaseId ?? testCase.id;
  const revision = extractRevision(testCase.raw);
  const payload: Record<string, unknown> = {
    id: azureId,
    title: testCase.title,
    description: testCase.description ?? null,
    preconditions: testCase.preconditions ?? null,
    steps: testCase.steps.map((step, index) => ({
      index,
      action: step.action,
      expectedResult: step.expectedResult,
    })),
    testData: testCase.testData ?? null,
    expectedResult: testCase.expectedResult ?? null,
    priority: testCase.priority ?? null,
    revision,
  };
  return {
    kind: "test_case",
    azureWorkItemId: azureId,
    azureRevision: revision,
    payload,
    contentHash: hashSnapshotPayload(payload),
  };
}

function extractRevision(raw: unknown): number | null {
  if (raw && typeof raw === "object" && "rev" in raw) {
    const rev = (raw as { rev?: unknown }).rev;
    if (typeof rev === "number" && Number.isFinite(rev)) return rev;
  }
  return null;
}
