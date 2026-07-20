import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  createId: vi.fn(),
  nowIso: vi.fn(),
  sqlAll: vi.fn(),
  sqlRun: vi.fn(),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => database);

import { projectScope } from "@/test/factories";
import {
  backfillProjectKnowledgeCompilerFoundation,
  matchLegacyEvidenceFragmentUniquely,
  parseLegacyProjectKnowledgeEntryForMigration,
} from "./project-knowledge-migration.service";

beforeEach(() => {
  vi.clearAllMocks();
  database.createId.mockReturnValue("migration-issue-1");
  database.nowIso.mockReturnValue("2026-07-13T00:00:00.000Z");
  database.sqlAll.mockResolvedValue([]);
  database.sqlRun.mockResolvedValue(0);
});

function legacy(overrides: Record<string, unknown> = {}) {
  return {
    category: "module",
    entry_key: "Checkout",
    title: "Checkout",
    content: "Flattened fallback description",
    metadata_json: null,
    ...overrides,
  };
}

describe("legacy project knowledge hash backfill parsing", () => {
  it("limits provenance aggregation to resolving legacy refs without overwriting v2 knowledge", async () => {
    await backfillProjectKnowledgeCompilerFoundation(projectScope());

    const activeVersionQuery = database.sqlAll.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("COUNT(refs.id) FILTER"));
    expect(activeVersionQuery).toContain("refs.verification IN ('exact', 'normalized', 'auto_reanchored')");
    expect(activeVersionQuery).toContain("versions.provenance_hash_version = @legacyProvenanceHashVersion");

    const knowledgeUpdate = database.sqlRun.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("UPDATE project_knowledge_base knowledge"));
    expect(knowledgeUpdate).toContain("entries.provenance_status <> 'legacy_unknown'");
    expect(knowledgeUpdate).toContain("knowledge.provenance_hash_version IS DISTINCT FROM @currentProvenanceHashVersion");
  });

  it("uses valid typed metadata before flattened content", () => {
    const parsed = parseLegacyProjectKnowledgeEntryForMigration(legacy({
      metadata_json: JSON.stringify({
        id: "Checkout",
        name: "Checkout",
        description: "Typed metadata description",
        sourceWorkItemIds: ["42"],
        evidence: "Evidence",
      }),
    }));
    expect(parsed?.semanticProjection).toMatchObject({
      category: "module",
      canonicalKey: "checkout",
      description: "Typed metadata description",
    });
  });

  it("falls back by category and canonicalizes legacy source fields only in the projection", () => {
    const parsed = parseLegacyProjectKnowledgeEntryForMigration(legacy({
      category: "business_rule",
      entry_key: "BR-1",
      title: "Payment is required",
      content: "Payment is required\nModule: Checkout\nSource field: Acceptance Criteria\nEvidence: ignored",
      metadata_json: "{invalid",
    }));
    expect(parsed?.semanticProjection).toEqual({
      category: "business_rule",
      canonicalKey: "br-1",
      rule: "Payment is required",
      sourceField: "acceptanceCriteria",
      moduleName: "Checkout",
    });
  });

  it("returns null instead of guessing an invalid category shape", () => {
    expect(parseLegacyProjectKnowledgeEntryForMigration(legacy({
      category: "dependency",
      title: "No endpoint delimiter",
      content: "Type: API",
    }))).toBeNull();
  });

  it("preserves multiline business rules and rejects ambiguous control fields", () => {
    const parsed = parseLegacyProjectKnowledgeEntryForMigration(legacy({
      category: "business_rule",
      entry_key: "BR-MULTI",
      title: "Approval policy",
      content: [
        "Orders above the threshold require approval.",
        "The approver must be outside the requesting team.",
        "Module: Checkout",
        "Source field: description",
        "Evidence: legacy evidence remains outside the semantic rule",
      ].join("\n"),
    }));

    expect(parsed?.semanticProjection).toMatchObject({
      rule: "Orders above the threshold require approval.\nThe approver must be outside the requesting team.",
      moduleName: "Checkout",
      sourceField: "description",
    });
    expect(parseLegacyProjectKnowledgeEntryForMigration(legacy({
      category: "business_rule",
      entry_key: "BR-AMBIGUOUS",
      content: "Rule text\nModule: Checkout\nModule: Payments",
    }))).toBeNull();
  });

  it("grounds a legacy fragment only when one snapshot field matches", () => {
    const snapshots = [{
      id: "snapshot-1",
      azure_work_item_id: "42",
      fields_json: { description: "Payment must be authorized." },
    }, {
      id: "snapshot-2",
      azure_work_item_id: "43",
      fields_json: { description: "Different evidence." },
    }];
    expect(matchLegacyEvidenceFragmentUniquely(snapshots, "Payment must be authorized."))
      .toMatchObject({ snapshotId: "snapshot-1", sourceField: "description", verification: "exact" });
    expect(matchLegacyEvidenceFragmentUniquely([
      ...snapshots,
      { id: "snapshot-3", azure_work_item_id: "44", fields_json: { title: "Payment must be authorized." } },
    ], "Payment must be authorized.")).toBeNull();
  });
});
