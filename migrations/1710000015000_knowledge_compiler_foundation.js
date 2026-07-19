/* eslint-disable camelcase */

/**
 * Foundation for the source-versioned knowledge compiler. The migration is
 * additive: legacy knowledge remains readable while drafts, immutable source
 * snapshots, provenance, and guarded publication are rolled out in code.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE azure_devops_work_items
      ADD COLUMN IF NOT EXISTS current_snapshot_id text;

    ALTER TABLE document_chunks
      ADD COLUMN IF NOT EXISTS source_snapshot_id text;

    ALTER TABLE llm_providers_config
      ADD COLUMN IF NOT EXISTS max_input_tokens integer;

    ALTER TABLE user_llm_settings
      ADD COLUMN IF NOT EXISTS max_input_tokens integer;

    ALTER TABLE project_knowledge_base
      ADD COLUMN IF NOT EXISTS active_revision_id text,
      ADD COLUMN IF NOT EXISTS source_manifest_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS source_fingerprint text,
      ADD COLUMN IF NOT EXISTS semantic_hash text,
      ADD COLUMN IF NOT EXISTS provenance_hash text,
      ADD COLUMN IF NOT EXISTS semantic_hash_version text,
      ADD COLUMN IF NOT EXISTS provenance_hash_version text,
      ADD COLUMN IF NOT EXISTS compiler_contract_version text NOT NULL DEFAULT 'legacy-v1',
      ADD COLUMN IF NOT EXISTS wording_version text,
      ADD COLUMN IF NOT EXISTS freshness_status text NOT NULL DEFAULT 'stale',
      ADD COLUMN IF NOT EXISTS provenance_status text NOT NULL DEFAULT 'legacy_unknown',
      ADD COLUMN IF NOT EXISTS compiler_compatibility text NOT NULL DEFAULT 'upgrade_recommended',
      ADD COLUMN IF NOT EXISTS stale_since text,
      ADD COLUMN IF NOT EXISTS stale_reason_json jsonb NOT NULL DEFAULT '[]'::jsonb;

    ALTER TABLE project_knowledge_revisions
      ADD COLUMN IF NOT EXISTS base_revision_id text,
      ADD COLUMN IF NOT EXISTS source_manifest_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS source_fingerprint text,
      ADD COLUMN IF NOT EXISTS semantic_hash text,
      ADD COLUMN IF NOT EXISTS provenance_hash text,
      ADD COLUMN IF NOT EXISTS semantic_hash_version text,
      ADD COLUMN IF NOT EXISTS provenance_hash_version text,
      ADD COLUMN IF NOT EXISTS compiler_contract_version text NOT NULL DEFAULT 'legacy-v1',
      ADD COLUMN IF NOT EXISTS wording_version text,
      ADD COLUMN IF NOT EXISTS metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE project_knowledge_entries
      ADD COLUMN IF NOT EXISTS entry_version_id text,
      ADD COLUMN IF NOT EXISTS entry_semantic_hash text,
      ADD COLUMN IF NOT EXISTS entry_provenance_hash text,
      ADD COLUMN IF NOT EXISTS provenance_status text NOT NULL DEFAULT 'legacy_unknown';

    ALTER TABLE project_knowledge_entry_versions
      ADD COLUMN IF NOT EXISTS entry_semantic_hash text,
      ADD COLUMN IF NOT EXISTS entry_provenance_hash text,
      ADD COLUMN IF NOT EXISTS semantic_hash_version text,
      ADD COLUMN IF NOT EXISTS provenance_hash_version text;

    ALTER TABLE project_knowledge_lint_issues
      ADD COLUMN IF NOT EXISTS issue_fingerprint text,
      ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'deterministic',
      ADD COLUMN IF NOT EXISTS first_seen_at text,
      ADD COLUMN IF NOT EXISTS last_seen_at text,
      ADD COLUMN IF NOT EXISTS resolved_at text,
      ADD COLUMN IF NOT EXISTS resolution_json jsonb,
      ADD COLUMN IF NOT EXISTS confirmed_by text,
      ADD COLUMN IF NOT EXISTS confirmed_at text;

    CREATE TABLE IF NOT EXISTS azure_devops_work_item_snapshots (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      azure_work_item_id text NOT NULL,
      work_item_type text NOT NULL,
      content_hash text NOT NULL,
      ado_revision integer,
      fields_json jsonb NOT NULL,
      source_updated_at text,
      captured_at text NOT NULL,
      created_at text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_knowledge_drafts (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      generation_mode text NOT NULL,
      compilation_mode text NOT NULL,
      status text NOT NULL,
      status_reason text,
      parent_draft_id text,
      rebase_depth integer NOT NULL DEFAULT 0,
      base_revision_id text,
      source_manifest_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_fingerprint text NOT NULL,
      compiler_contract_version text NOT NULL,
      wording_version text NOT NULL,
      provider text,
      model_name text,
      raw_output text,
      proposed_knowledge_json jsonb,
      operations_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      generation_data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      blockers_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      semantic_hash text,
      provenance_hash text,
      pending_drift boolean NOT NULL DEFAULT false,
      heartbeat_at text,
      review_ready_at text,
      created_by text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      published_at text
    );

    CREATE TABLE IF NOT EXISTS project_knowledge_migration_issues (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      entity_type text NOT NULL,
      entity_id text NOT NULL,
      issue_type text NOT NULL,
      details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'open',
      created_at text NOT NULL,
      resolved_at text,
      UNIQUE (entity_type, entity_id, issue_type)
    );

    CREATE TABLE IF NOT EXISTS project_knowledge_draft_batches (
      id text PRIMARY KEY,
      draft_id text NOT NULL,
      batch_index integer NOT NULL,
      status text NOT NULL,
      prompt_hash text NOT NULL,
      compiler_contract_version text NOT NULL,
      system_prompt text NOT NULL,
      user_prompt text NOT NULL,
      raw_output text,
      validated_output jsonb,
      heartbeat_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (draft_id, batch_index)
    );

    CREATE TABLE IF NOT EXISTS project_knowledge_entry_evidence_refs (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      entry_version_id text NOT NULL,
      source_snapshot_id text NOT NULL,
      source_work_item_id text NOT NULL,
      source_field text NOT NULL,
      quote text NOT NULL,
      locator_json jsonb,
      origin text NOT NULL,
      verification text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      created_at text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_knowledge_candidates (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      title text NOT NULL,
      content text NOT NULL,
      status text NOT NULL,
      source_work_item_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence_refs_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      citations_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      legacy_entry_version_id text,
      created_by text,
      rejected_by text,
      rejected_reason text,
      rejected_at text,
      integration_requested_by text,
      integration_requested_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_knowledge_hard_conflicts (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      draft_id text,
      revision_id text,
      run_id text,
      identity_key text NOT NULL,
      subject text NOT NULL,
      conflict_type text NOT NULL,
      status text NOT NULL,
      participants_json jsonb NOT NULL,
      resolution_json jsonb,
      reviewed_by text,
      reviewed_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_item_snapshots_lookup
      ON azure_devops_work_item_snapshots(project_id, azure_project_id, azure_work_item_id, captured_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_snapshots_identity
      ON azure_devops_work_item_snapshots(
        project_id, azure_project_id, azure_work_item_id, content_hash, COALESCE(ado_revision, -1)
      );
    CREATE INDEX IF NOT EXISTS idx_knowledge_drafts_project
      ON project_knowledge_drafts(project_id, azure_project_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_migration_issues_project
      ON project_knowledge_migration_issues(project_id, azure_project_id, status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_drafts_one_live_child
      ON project_knowledge_drafts(parent_draft_id)
      WHERE parent_draft_id IS NOT NULL
        AND status IN ('generating', 'awaiting_input', 'ready_for_review', 'blocked', 'rebase_required');
    CREATE INDEX IF NOT EXISTS idx_knowledge_draft_batches
      ON project_knowledge_draft_batches(draft_id, batch_index);
    CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_entry
      ON project_knowledge_entry_evidence_refs(entry_version_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_snapshot
      ON project_knowledge_entry_evidence_refs(source_snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_project
      ON project_knowledge_candidates(project_id, azure_project_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_conflicts_project
      ON project_knowledge_hard_conflicts(project_id, azure_project_id, status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_lint_fingerprint
      ON project_knowledge_lint_issues(project_id, azure_project_id, issue_fingerprint)
      WHERE issue_fingerprint IS NOT NULL;

    WITH chronological_revisions AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY project_id, azure_project_id
               ORDER BY created_at, id
             ) AS chronological_revision
      FROM project_knowledge_revisions
    )
    UPDATE project_knowledge_revisions r
    SET revision_number = chronological_revisions.chronological_revision
    FROM chronological_revisions
    WHERE r.id = chronological_revisions.id
      AND r.revision_number IS DISTINCT FROM chronological_revisions.chronological_revision;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_knowledge_revision_number_unique
      ON project_knowledge_revisions(project_id, azure_project_id, revision_number);

    INSERT INTO azure_devops_work_item_snapshots (
      id, workspace_id, project_id, azure_project_id, azure_project_name,
      azure_organization_url, azure_work_item_id, work_item_type, content_hash,
      ado_revision, fields_json, source_updated_at, captured_at, created_at
    )
    SELECT
      'awis_' || md5(
        wi.project_id || ':' || wi.azure_project_id || ':' || wi.azure_work_item_id || ':' ||
        COALESCE(wi.content_hash, md5(
          COALESCE(wi.title, '') || ':' || COALESCE(wi.description, '') || ':' ||
          COALESCE(wi.acceptance_criteria, '') || ':' || COALESCE(wi.state, '')
        ))
      ),
      wi.workspace_id, wi.project_id, wi.azure_project_id, wi.azure_project_name,
      wi.azure_organization_url, wi.azure_work_item_id, wi.work_item_type,
      COALESCE(wi.content_hash, md5(
        COALESCE(wi.title, '') || ':' || COALESCE(wi.description, '') || ':' ||
        COALESCE(wi.acceptance_criteria, '') || ':' || COALESCE(wi.state, '')
      )),
      CASE
        WHEN wi.raw_json ~ '"rev"[[:space:]]*:[[:space:]]*[0-9]+'
          THEN substring(wi.raw_json from '"rev"[[:space:]]*:[[:space:]]*([0-9]+)')::integer
        ELSE NULL
      END,
      jsonb_build_object(
        'title', wi.title,
        'description', wi.description,
        'acceptanceCriteria', wi.acceptance_criteria,
        'state', wi.state,
        'workItemType', wi.work_item_type,
        'tags', wi.tags,
        'areaPath', wi.area_path,
        'iterationPath', wi.iteration_path
      ),
      wi.updated_date,
      COALESCE(wi.last_synced_at, wi.updated_at, wi.created_at),
      COALESCE(wi.last_synced_at, wi.updated_at, wi.created_at)
    FROM azure_devops_work_items wi
    ON CONFLICT DO NOTHING;

    UPDATE azure_devops_work_items wi
    SET current_snapshot_id = snapshots.id
    FROM azure_devops_work_item_snapshots snapshots
    WHERE snapshots.project_id = wi.project_id
      AND snapshots.azure_project_id = wi.azure_project_id
      AND snapshots.azure_work_item_id = wi.azure_work_item_id
      AND snapshots.content_hash = COALESCE(wi.content_hash, snapshots.content_hash)
      AND wi.current_snapshot_id IS NULL;

    UPDATE document_chunks chunks
    SET source_snapshot_id = wi.current_snapshot_id
    FROM azure_devops_work_items wi
    WHERE chunks.project_id = wi.project_id
      AND chunks.azure_project_id = wi.azure_project_id
      AND chunks.azure_work_item_id = wi.azure_work_item_id
      AND chunks.source_type = 'azure_work_item'
      AND chunks.source_snapshot_id IS NULL;

    INSERT INTO project_knowledge_candidates (
      id, workspace_id, project_id, azure_project_id, azure_project_name,
      azure_organization_url, title, content, status, source_work_item_ids,
      evidence_refs_json, citations_json, legacy_entry_version_id,
      created_at, updated_at
    )
    SELECT
      'pkc_' || md5(versions.id), versions.workspace_id, versions.project_id,
      versions.azure_project_id, versions.azure_project_name,
      versions.azure_organization_url, versions.title, versions.content,
      'legacy_ungrounded',
      CASE
        WHEN pg_input_is_valid(versions.source_work_item_ids, 'jsonb') THEN
          CASE
            WHEN jsonb_typeof(versions.source_work_item_ids::jsonb) = 'array'
              THEN versions.source_work_item_ids::jsonb
            ELSE '[]'::jsonb
          END
        ELSE '[]'::jsonb
      END,
      '[]'::jsonb,
      jsonb_build_object('legacyEvidence', versions.evidence, 'legacyMetadata', versions.metadata_json),
      versions.id, versions.created_at, versions.updated_at
    FROM project_knowledge_entry_versions versions
    WHERE versions.status = 'candidate'
    ON CONFLICT (id) DO NOTHING;

    UPDATE project_knowledge_entry_versions
    SET status = 'migrated',
        knowledge_base_id = CASE WHEN knowledge_base_id = 'pending' THEN 'legacy' ELSE knowledge_base_id END,
        revision_id = CASE WHEN revision_id = 'pending' THEN 'legacy' ELSE revision_id END
    WHERE status = 'candidate';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_project_knowledge_revision_number_unique;
    DROP INDEX IF EXISTS idx_knowledge_lint_fingerprint;
    DROP INDEX IF EXISTS idx_knowledge_conflicts_project;
    DROP INDEX IF EXISTS idx_knowledge_candidates_project;
    DROP INDEX IF EXISTS idx_knowledge_evidence_snapshot;
    DROP INDEX IF EXISTS idx_knowledge_evidence_entry;
    DROP INDEX IF EXISTS idx_knowledge_draft_batches;
    DROP INDEX IF EXISTS idx_knowledge_drafts_one_live_child;
    DROP INDEX IF EXISTS idx_knowledge_drafts_project;
    DROP INDEX IF EXISTS idx_knowledge_migration_issues_project;
    DROP INDEX IF EXISTS idx_work_item_snapshots_lookup;
    DROP INDEX IF EXISTS idx_work_item_snapshots_identity;

    UPDATE project_knowledge_entry_versions versions
    SET status = 'candidate',
        knowledge_base_id = CASE WHEN versions.knowledge_base_id = 'legacy' THEN 'pending' ELSE versions.knowledge_base_id END,
        revision_id = CASE WHEN versions.revision_id = 'legacy' THEN 'pending' ELSE versions.revision_id END
    FROM project_knowledge_candidates candidates
    WHERE candidates.legacy_entry_version_id = versions.id
      AND versions.status = 'migrated';

    DROP TABLE IF EXISTS project_knowledge_hard_conflicts;
    DROP TABLE IF EXISTS project_knowledge_migration_issues;
    DROP TABLE IF EXISTS project_knowledge_candidates;
    DROP TABLE IF EXISTS project_knowledge_entry_evidence_refs;
    DROP TABLE IF EXISTS project_knowledge_draft_batches;
    DROP TABLE IF EXISTS project_knowledge_drafts;
    DROP TABLE IF EXISTS azure_devops_work_item_snapshots;

    ALTER TABLE project_knowledge_lint_issues
      DROP COLUMN IF EXISTS confirmed_at,
      DROP COLUMN IF EXISTS confirmed_by,
      DROP COLUMN IF EXISTS resolution_json,
      DROP COLUMN IF EXISTS resolved_at,
      DROP COLUMN IF EXISTS last_seen_at,
      DROP COLUMN IF EXISTS first_seen_at,
      DROP COLUMN IF EXISTS origin,
      DROP COLUMN IF EXISTS issue_fingerprint;

    ALTER TABLE project_knowledge_entry_versions
      DROP COLUMN IF EXISTS provenance_hash_version,
      DROP COLUMN IF EXISTS semantic_hash_version,
      DROP COLUMN IF EXISTS entry_provenance_hash,
      DROP COLUMN IF EXISTS entry_semantic_hash;

    ALTER TABLE project_knowledge_entries
      DROP COLUMN IF EXISTS provenance_status,
      DROP COLUMN IF EXISTS entry_provenance_hash,
      DROP COLUMN IF EXISTS entry_semantic_hash,
      DROP COLUMN IF EXISTS entry_version_id;

    ALTER TABLE project_knowledge_revisions
      DROP COLUMN IF EXISTS metrics_json,
      DROP COLUMN IF EXISTS wording_version,
      DROP COLUMN IF EXISTS compiler_contract_version,
      DROP COLUMN IF EXISTS provenance_hash_version,
      DROP COLUMN IF EXISTS semantic_hash_version,
      DROP COLUMN IF EXISTS provenance_hash,
      DROP COLUMN IF EXISTS semantic_hash,
      DROP COLUMN IF EXISTS source_fingerprint,
      DROP COLUMN IF EXISTS source_manifest_json,
      DROP COLUMN IF EXISTS base_revision_id;

    ALTER TABLE project_knowledge_base
      DROP COLUMN IF EXISTS stale_reason_json,
      DROP COLUMN IF EXISTS stale_since,
      DROP COLUMN IF EXISTS compiler_compatibility,
      DROP COLUMN IF EXISTS provenance_status,
      DROP COLUMN IF EXISTS freshness_status,
      DROP COLUMN IF EXISTS wording_version,
      DROP COLUMN IF EXISTS compiler_contract_version,
      DROP COLUMN IF EXISTS provenance_hash_version,
      DROP COLUMN IF EXISTS semantic_hash_version,
      DROP COLUMN IF EXISTS provenance_hash,
      DROP COLUMN IF EXISTS semantic_hash,
      DROP COLUMN IF EXISTS source_fingerprint,
      DROP COLUMN IF EXISTS source_manifest_json,
      DROP COLUMN IF EXISTS active_revision_id;

    ALTER TABLE llm_providers_config DROP COLUMN IF EXISTS max_input_tokens;
    ALTER TABLE user_llm_settings DROP COLUMN IF EXISTS max_input_tokens;
    ALTER TABLE document_chunks DROP COLUMN IF EXISTS source_snapshot_id;
    ALTER TABLE azure_devops_work_items DROP COLUMN IF EXISTS current_snapshot_id;
  `);
};
