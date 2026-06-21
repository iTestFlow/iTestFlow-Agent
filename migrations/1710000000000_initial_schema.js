/* eslint-disable camelcase */

/**
 * Phase 1a — initial PostgreSQL schema.
 *
 * Ported verbatim from the former src/modules/shared/infrastructure/database/schema.sql
 * (node:sqlite). Type mapping: TEXT->text, INTEGER->integer, REAL->double precision.
 * Integer 0/1 flag columns are kept as `integer` to avoid churn in the data layer.
 *
 * The two former FTS5 virtual tables are recreated as ordinary tables carrying a
 * GENERATED STORED `tsvector` column (config 'simple' ≈ FTS5 unicode61, no stemming)
 * with a GIN index. The retrieval service keeps maintaining these tables explicitly.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE local_profile (
      id text PRIMARY KEY,
      display_name text,
      default_project_id text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE projects (
      id text PRIMARY KEY,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (azure_organization_url, azure_project_id)
    );

    CREATE TABLE selected_azure_project (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      selected_at text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE project_settings (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      settings_json text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE azure_devops_connections (
      id text PRIMARY KEY,
      project_id text,
      azure_project_id text,
      azure_organization_url text NOT NULL,
      encrypted_pat_reference text,
      connection_status text NOT NULL,
      last_tested_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE azure_devops_projects (
      id text PRIMARY KEY,
      project_id text,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      state text,
      visibility text,
      last_synced_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE azure_devops_sync_runs (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      status text NOT NULL,
      fetched_count integer NOT NULL DEFAULT 0,
      indexed_count integer NOT NULL DEFAULT 0,
      error_count integer NOT NULL DEFAULT 0,
      push_status text,
      push_error text,
      started_at text NOT NULL,
      completed_at text,
      last_synced_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE azure_devops_work_items (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      azure_work_item_id text NOT NULL,
      work_item_type text NOT NULL,
      title text NOT NULL,
      description text,
      acceptance_criteria text,
      state text,
      assigned_to text,
      priority integer,
      tags text,
      area_path text,
      iteration_path text,
      raw_json text,
      created_date text,
      updated_date text,
      last_synced_at text,
      content_hash text,
      sync_status text NOT NULL DEFAULT 'active',
      current_index_run_id text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (project_id, azure_work_item_id)
    );

    CREATE TABLE azure_devops_work_item_links (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      source_work_item_id text NOT NULL,
      target_work_item_id text NOT NULL,
      relationship_type text NOT NULL,
      raw_json text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE azure_devops_test_plans (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      azure_test_plan_id text NOT NULL,
      name text NOT NULL,
      raw_json text,
      last_synced_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE azure_devops_test_suites (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      azure_test_plan_id text NOT NULL,
      azure_test_suite_id text NOT NULL,
      name text NOT NULL,
      raw_json text,
      last_synced_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE azure_devops_linked_test_cases (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      azure_work_item_id text NOT NULL,
      azure_test_case_id text NOT NULL,
      relationship_type text NOT NULL,
      title text NOT NULL,
      steps_json text,
      raw_json text,
      last_synced_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE documents (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text,
      source_type text NOT NULL,
      document_name text NOT NULL,
      document_type text NOT NULL,
      file_path text,
      parse_status text NOT NULL,
      last_synced_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE document_chunks (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text,
      source_type text NOT NULL,
      azure_work_item_id text,
      work_item_type text,
      document_id text,
      document_name text,
      document_type text,
      section text,
      page_number integer,
      chunk_index integer NOT NULL,
      content text NOT NULL,
      metadata_json text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE embeddings (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      chunk_id text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      vector_reference text NOT NULL,
      vector_json text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE document_chunks_fts (
      project_id text,
      azure_project_id text,
      chunk_id text,
      azure_work_item_id text,
      work_item_type text,
      title text,
      content text,
      metadata_json text,
      tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))
      ) STORED
    );
    CREATE INDEX idx_document_chunks_fts_tsv ON document_chunks_fts USING GIN (tsv);
    CREATE INDEX idx_document_chunks_fts_lookup ON document_chunks_fts (project_id, azure_project_id, chunk_id);

    CREATE TABLE requirements (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_work_item_id text NOT NULL,
      normalized_json text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE context_suggestion_runs (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      target_work_item_id text NOT NULL,
      workflow_type text NOT NULL,
      provider text,
      model_name text,
      prompt_version text,
      status text NOT NULL,
      raw_output text,
      validated_output text,
      error_details text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE context_suggested_items (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      run_id text NOT NULL,
      target_work_item_id text NOT NULL,
      suggested_work_item_id text NOT NULL,
      relevance_score double precision,
      reason text,
      suggested_by text NOT NULL,
      user_state text NOT NULL DEFAULT 'suggested',
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE context_selected_items (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      run_id text NOT NULL,
      target_work_item_id text NOT NULL,
      selected_work_item_id text NOT NULL,
      selection_source text NOT NULL,
      selected_state text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE project_knowledge_base (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      prompt_version text NOT NULL,
      provider text,
      model_name text,
      source_work_item_count integer NOT NULL DEFAULT 0,
      raw_output text,
      validated_output text NOT NULL,
      status text NOT NULL,
      error_details text,
      extracted_at text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (project_id, azure_project_id)
    );

    CREATE TABLE project_knowledge_entries (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      knowledge_base_id text NOT NULL,
      category text NOT NULL,
      entry_key text NOT NULL,
      title text NOT NULL,
      content text NOT NULL,
      source_work_item_ids text NOT NULL,
      evidence text NOT NULL,
      metadata_json text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE project_knowledge_revisions (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      knowledge_base_id text NOT NULL,
      revision_number integer NOT NULL,
      mode text NOT NULL,
      provider text,
      model_name text,
      source_work_item_count integer NOT NULL DEFAULT 0,
      source_change_summary_json text,
      raw_output text,
      validated_output text NOT NULL,
      created_at text NOT NULL
    );

    CREATE TABLE project_knowledge_entry_versions (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      knowledge_base_id text NOT NULL,
      revision_id text NOT NULL,
      category text NOT NULL,
      entry_key text NOT NULL,
      title text NOT NULL,
      content text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      source_work_item_ids text NOT NULL,
      evidence text NOT NULL,
      metadata_json text,
      content_hash text NOT NULL,
      superseded_by_entry_version_id text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE project_knowledge_log (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      event_type text NOT NULL,
      severity text NOT NULL DEFAULT 'info',
      title text NOT NULL,
      message text NOT NULL,
      source_ids text NOT NULL DEFAULT '[]',
      metadata_json text,
      created_at text NOT NULL
    );

    CREATE TABLE project_knowledge_lint_issues (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      issue_type text NOT NULL,
      severity text NOT NULL,
      title text NOT NULL,
      message text NOT NULL,
      category text,
      entry_key text,
      source_work_item_ids text NOT NULL DEFAULT '[]',
      status text NOT NULL DEFAULT 'open',
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE context_auto_update_runs (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      cron_expression text NOT NULL,
      cron_timezone text NOT NULL DEFAULT 'server local time',
      context_work_item_types text NOT NULL DEFAULT '[]',
      context_states text NOT NULL DEFAULT '[]',
      status text NOT NULL,
      started_at text NOT NULL,
      completed_at text,
      context_sync_mode text,
      context_fetched_count integer NOT NULL DEFAULT 0,
      context_indexed_work_item_count integer NOT NULL DEFAULT 0,
      context_indexed_chunk_count integer NOT NULL DEFAULT 0,
      context_created_count integer NOT NULL DEFAULT 0,
      context_updated_count integer NOT NULL DEFAULT 0,
      context_unchanged_count integer NOT NULL DEFAULT 0,
      context_inactive_count integer NOT NULL DEFAULT 0,
      context_skipped_empty_count integer NOT NULL DEFAULT 0,
      knowledge_base_id text,
      knowledge_source_work_item_count integer NOT NULL DEFAULT 0,
      knowledge_compile_mode text,
      knowledge_compile_status text NOT NULL DEFAULT 'pending',
      knowledge_compile_skipped_reason text,
      error_details text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE project_knowledge_entries_fts (
      project_id text,
      azure_project_id text,
      entry_id text,
      category text,
      entry_key text,
      title text,
      content text,
      source_work_item_ids text,
      evidence text,
      metadata_json text,
      tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, '') || ' ' || coalesce(evidence, ''))
      ) STORED
    );
    CREATE INDEX idx_project_knowledge_entries_fts_tsv ON project_knowledge_entries_fts USING GIN (tsv);
    CREATE INDEX idx_project_knowledge_entries_fts_lookup ON project_knowledge_entries_fts (project_id, azure_project_id, entry_id);

    CREATE TABLE requirement_analysis_runs (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      target_work_item_id text NOT NULL,
      prompt_version text NOT NULL,
      provider text,
      model_name text,
      selected_context_ids text,
      user_input text,
      raw_output text,
      validated_output text,
      token_usage text,
      cost_estimate double precision,
      status text NOT NULL,
      error_details text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE requirement_analysis_findings (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      run_id text NOT NULL,
      finding_json text NOT NULL,
      severity text NOT NULL,
      category text NOT NULL,
      selected integer NOT NULL DEFAULT 1,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE selected_requirement_findings (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      run_id text NOT NULL,
      finding_id text NOT NULL,
      edited_json text NOT NULL,
      selected integer NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE azure_devops_comment_drafts (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      azure_work_item_id text NOT NULL,
      body_markdown text NOT NULL,
      source_run_id text NOT NULL,
      status text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE azure_devops_comment_push_runs (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      azure_work_item_id text NOT NULL,
      draft_id text NOT NULL,
      push_status text NOT NULL,
      push_error text,
      azure_comment_id text,
      last_pushed_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE test_case_generation_runs (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      target_work_item_id text NOT NULL,
      prompt_version text NOT NULL,
      provider text,
      model_name text,
      selected_context_ids text,
      generation_options_json text,
      raw_output text,
      validated_output text,
      token_usage text,
      cost_estimate double precision,
      status text NOT NULL,
      error_details text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE generated_test_cases (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      run_id text NOT NULL,
      local_test_case_id text NOT NULL,
      test_case_json text NOT NULL,
      selected integer NOT NULL DEFAULT 1,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE test_cases (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      target_work_item_id text NOT NULL,
      source_type text NOT NULL,
      title text NOT NULL,
      description text,
      preconditions text,
      test_data text,
      expected_result text,
      priority text,
      severity text,
      test_type text,
      automation_suitability text,
      tags text,
      azure_test_case_id text,
      push_status text,
      push_error text,
      last_pushed_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE test_case_steps (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      test_case_id text NOT NULL,
      step_index integer NOT NULL,
      action text NOT NULL,
      expected_result text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE selected_test_cases (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      run_id text,
      test_case_id text NOT NULL,
      selected integer NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE manual_test_cases (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      target_work_item_id text NOT NULL,
      test_case_id text NOT NULL,
      author text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE test_case_edit_history (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      test_case_id text NOT NULL,
      field_name text NOT NULL,
      previous_value text,
      new_value text,
      actor text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE existing_test_case_review_runs (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      target_work_item_id text NOT NULL,
      linked_test_case_ids text,
      selected_context_ids text,
      prompt_version text NOT NULL,
      provider text,
      model_name text,
      raw_output text,
      validated_output text,
      status text NOT NULL,
      error_details text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE existing_test_case_review_findings (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      run_id text NOT NULL,
      finding_json text NOT NULL,
      severity text,
      category text,
      selected integer NOT NULL DEFAULT 1,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE suggested_test_case_additions (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      run_id text NOT NULL,
      test_case_json text NOT NULL,
      selected integer NOT NULL DEFAULT 1,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE azure_devops_test_case_push_runs (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      azure_work_item_id text NOT NULL,
      azure_test_plan_id text NOT NULL,
      azure_test_suite_id text NOT NULL,
      selected_test_case_ids text NOT NULL,
      push_status text NOT NULL,
      push_error text,
      success_count integer NOT NULL DEFAULT 0,
      failed_count integer NOT NULL DEFAULT 0,
      last_pushed_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE azure_devops_test_case_links (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      azure_work_item_id text NOT NULL,
      azure_test_case_id text NOT NULL,
      azure_test_plan_id text,
      azure_test_suite_id text,
      relationship_type text NOT NULL,
      push_status text,
      push_error text,
      last_pushed_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE scoring_results (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      target_work_item_id text,
      entity_type text NOT NULL,
      entity_id text NOT NULL,
      scores_json text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE llm_providers_config (
      id text PRIMARY KEY,
      project_id text,
      azure_project_id text,
      provider text NOT NULL,
      model text NOT NULL,
      base_url text,
      encrypted_api_key_reference text,
      max_tokens integer NOT NULL DEFAULT 4000,
      is_default integer NOT NULL DEFAULT 0,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE prompt_versions (
      id text PRIMARY KEY,
      project_id text,
      azure_project_id text,
      name text NOT NULL,
      version text NOT NULL,
      purpose text NOT NULL,
      input_schema_json text NOT NULL,
      output_schema_json text NOT NULL,
      system_instructions text NOT NULL,
      user_instructions text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (name, version)
    );

    CREATE TABLE audit_logs (
      id text PRIMARY KEY,
      project_id text,
      azure_project_id text,
      azure_project_name text,
      azure_organization_url text,
      entity_type text,
      entity_id text,
      action text NOT NULL,
      status text NOT NULL,
      actor text,
      message text NOT NULL,
      details_json text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE llm_request_logs (
      id text PRIMARY KEY,
      project_id text,
      azure_project_id text,
      azure_project_name text,
      azure_organization_url text,
      target_work_item_id text,
      action text,
      provider text NOT NULL,
      model_name text NOT NULL,
      schema_name text NOT NULL,
      prompt_name text,
      prompt_version text,
      system_prompt text NOT NULL,
      user_prompt text NOT NULL,
      request_body_json text,
      response_body_json text,
      raw_output text,
      validated_output_json text,
      status text NOT NULL,
      error_details text,
      duration_ms integer NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE analytics_workflow_runs (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      user_id text NOT NULL DEFAULT 'local-user',
      workflow_type text NOT NULL,
      work_item_id text,
      source_run_id text,
      started_at text NOT NULL,
      completed_at text,
      generation_started_at text,
      generation_completed_at text,
      review_started_at text,
      published_at text,
      status text NOT NULL,
      manual_baseline_minutes double precision NOT NULL DEFAULT 0,
      actual_duration_minutes double precision,
      estimated_saved_minutes double precision NOT NULL DEFAULT 0,
      items_generated integer NOT NULL DEFAULT 0,
      items_selected integer NOT NULL DEFAULT 0,
      items_edited integer NOT NULL DEFAULT 0,
      items_published integer NOT NULL DEFAULT 0,
      items_rejected integer NOT NULL DEFAULT 0,
      high_risk_items_found integer NOT NULL DEFAULT 0,
      medium_risk_items_found integer NOT NULL DEFAULT 0,
      low_risk_items_found integer NOT NULL DEFAULT 0,
      manual_actions_avoided integer NOT NULL DEFAULT 0,
      used_knowledge_context integer NOT NULL DEFAULT 0,
      feedback_rating integer,
      feedback_label text,
      feedback_comment text,
      metadata_json text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE INDEX idx_work_items_project ON azure_devops_work_items(project_id, azure_project_id);
    CREATE INDEX idx_chunks_project ON document_chunks(project_id, azure_project_id);
    CREATE INDEX idx_context_selected_project ON context_selected_items(project_id, azure_project_id);
    CREATE INDEX idx_project_knowledge_base_project ON project_knowledge_base(project_id, azure_project_id);
    CREATE INDEX idx_project_knowledge_entries_project ON project_knowledge_entries(project_id, azure_project_id);
    CREATE INDEX idx_project_knowledge_revisions_project ON project_knowledge_revisions(project_id, azure_project_id, revision_number);
    CREATE INDEX idx_project_knowledge_entry_versions_project ON project_knowledge_entry_versions(project_id, azure_project_id, category, entry_key);
    CREATE INDEX idx_project_knowledge_log_project ON project_knowledge_log(project_id, azure_project_id, created_at);
    CREATE INDEX idx_project_knowledge_lint_project ON project_knowledge_lint_issues(project_id, azure_project_id, status, severity);
    CREATE INDEX idx_context_auto_update_runs_project ON context_auto_update_runs(project_id, azure_project_id, started_at);
    CREATE INDEX idx_test_cases_project ON test_cases(project_id, azure_project_id);
    CREATE INDEX idx_audit_project ON audit_logs(project_id, azure_project_id);
    CREATE INDEX idx_llm_request_logs_project ON llm_request_logs(project_id, azure_project_id);
    CREATE INDEX idx_llm_request_logs_created_at ON llm_request_logs(created_at);
    CREATE INDEX idx_analytics_runs_project_date ON analytics_workflow_runs(project_id, azure_project_id, started_at);
    CREATE INDEX idx_analytics_runs_workflow ON analytics_workflow_runs(workflow_type, status);
    CREATE INDEX idx_analytics_runs_user ON analytics_workflow_runs(user_id, started_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS analytics_workflow_runs CASCADE;
    DROP TABLE IF EXISTS llm_request_logs CASCADE;
    DROP TABLE IF EXISTS audit_logs CASCADE;
    DROP TABLE IF EXISTS prompt_versions CASCADE;
    DROP TABLE IF EXISTS llm_providers_config CASCADE;
    DROP TABLE IF EXISTS scoring_results CASCADE;
    DROP TABLE IF EXISTS azure_devops_test_case_links CASCADE;
    DROP TABLE IF EXISTS azure_devops_test_case_push_runs CASCADE;
    DROP TABLE IF EXISTS suggested_test_case_additions CASCADE;
    DROP TABLE IF EXISTS existing_test_case_review_findings CASCADE;
    DROP TABLE IF EXISTS existing_test_case_review_runs CASCADE;
    DROP TABLE IF EXISTS test_case_edit_history CASCADE;
    DROP TABLE IF EXISTS manual_test_cases CASCADE;
    DROP TABLE IF EXISTS selected_test_cases CASCADE;
    DROP TABLE IF EXISTS test_case_steps CASCADE;
    DROP TABLE IF EXISTS test_cases CASCADE;
    DROP TABLE IF EXISTS generated_test_cases CASCADE;
    DROP TABLE IF EXISTS test_case_generation_runs CASCADE;
    DROP TABLE IF EXISTS azure_devops_comment_push_runs CASCADE;
    DROP TABLE IF EXISTS azure_devops_comment_drafts CASCADE;
    DROP TABLE IF EXISTS selected_requirement_findings CASCADE;
    DROP TABLE IF EXISTS requirement_analysis_findings CASCADE;
    DROP TABLE IF EXISTS requirement_analysis_runs CASCADE;
    DROP TABLE IF EXISTS project_knowledge_entries_fts CASCADE;
    DROP TABLE IF EXISTS context_auto_update_runs CASCADE;
    DROP TABLE IF EXISTS project_knowledge_lint_issues CASCADE;
    DROP TABLE IF EXISTS project_knowledge_log CASCADE;
    DROP TABLE IF EXISTS project_knowledge_entry_versions CASCADE;
    DROP TABLE IF EXISTS project_knowledge_revisions CASCADE;
    DROP TABLE IF EXISTS project_knowledge_entries CASCADE;
    DROP TABLE IF EXISTS project_knowledge_base CASCADE;
    DROP TABLE IF EXISTS context_selected_items CASCADE;
    DROP TABLE IF EXISTS context_suggested_items CASCADE;
    DROP TABLE IF EXISTS context_suggestion_runs CASCADE;
    DROP TABLE IF EXISTS requirements CASCADE;
    DROP TABLE IF EXISTS document_chunks_fts CASCADE;
    DROP TABLE IF EXISTS embeddings CASCADE;
    DROP TABLE IF EXISTS document_chunks CASCADE;
    DROP TABLE IF EXISTS documents CASCADE;
    DROP TABLE IF EXISTS azure_devops_linked_test_cases CASCADE;
    DROP TABLE IF EXISTS azure_devops_test_suites CASCADE;
    DROP TABLE IF EXISTS azure_devops_test_plans CASCADE;
    DROP TABLE IF EXISTS azure_devops_work_item_links CASCADE;
    DROP TABLE IF EXISTS azure_devops_work_items CASCADE;
    DROP TABLE IF EXISTS azure_devops_sync_runs CASCADE;
    DROP TABLE IF EXISTS azure_devops_projects CASCADE;
    DROP TABLE IF EXISTS azure_devops_connections CASCADE;
    DROP TABLE IF EXISTS project_settings CASCADE;
    DROP TABLE IF EXISTS selected_azure_project CASCADE;
    DROP TABLE IF EXISTS projects CASCADE;
    DROP TABLE IF EXISTS local_profile CASCADE;
  `);
};
