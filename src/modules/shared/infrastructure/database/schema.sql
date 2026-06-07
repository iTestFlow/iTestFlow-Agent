CREATE TABLE IF NOT EXISTS local_profile (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  default_project_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (azure_organization_url, azure_project_id)
);

CREATE TABLE IF NOT EXISTS selected_azure_project (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  selected_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS project_settings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS azure_devops_connections (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  azure_project_id TEXT,
  azure_organization_url TEXT NOT NULL,
  encrypted_pat_reference TEXT,
  connection_status TEXT NOT NULL,
  last_tested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS azure_devops_projects (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  state TEXT,
  visibility TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS azure_devops_sync_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  status TEXT NOT NULL,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  indexed_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  push_status TEXT,
  push_error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS azure_devops_work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  azure_work_item_id TEXT NOT NULL,
  work_item_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  acceptance_criteria TEXT,
  state TEXT,
  assigned_to TEXT,
  priority INTEGER,
  tags TEXT,
  area_path TEXT,
  iteration_path TEXT,
  raw_json TEXT,
  created_date TEXT,
  updated_date TEXT,
  last_synced_at TEXT,
  content_hash TEXT,
  sync_status TEXT NOT NULL DEFAULT 'active',
  current_index_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, azure_work_item_id)
);

CREATE TABLE IF NOT EXISTS azure_devops_work_item_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  source_work_item_id TEXT NOT NULL,
  target_work_item_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS azure_devops_test_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  azure_test_plan_id TEXT NOT NULL,
  name TEXT NOT NULL,
  raw_json TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS azure_devops_test_suites (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  azure_test_plan_id TEXT NOT NULL,
  azure_test_suite_id TEXT NOT NULL,
  name TEXT NOT NULL,
  raw_json TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS azure_devops_linked_test_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  azure_work_item_id TEXT NOT NULL,
  azure_test_case_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  title TEXT NOT NULL,
  steps_json TEXT,
  raw_json TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT,
  source_type TEXT NOT NULL,
  document_name TEXT NOT NULL,
  document_type TEXT NOT NULL,
  file_path TEXT,
  parse_status TEXT NOT NULL,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT,
  source_type TEXT NOT NULL,
  azure_work_item_id TEXT,
  work_item_type TEXT,
  document_id TEXT,
  document_name TEXT,
  document_type TEXT,
  section TEXT,
  page_number INTEGER,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  vector_reference TEXT NOT NULL,
  vector_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
  project_id UNINDEXED,
  azure_project_id UNINDEXED,
  chunk_id UNINDEXED,
  azure_work_item_id UNINDEXED,
  work_item_type UNINDEXED,
  title,
  content,
  metadata_json UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_work_item_id TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_suggestion_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  target_work_item_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  provider TEXT,
  model_name TEXT,
  prompt_version TEXT,
  status TEXT NOT NULL,
  raw_output TEXT,
  validated_output TEXT,
  error_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_suggested_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  target_work_item_id TEXT NOT NULL,
  suggested_work_item_id TEXT NOT NULL,
  relevance_score REAL,
  reason TEXT,
  suggested_by TEXT NOT NULL,
  user_state TEXT NOT NULL DEFAULT 'suggested',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_selected_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  target_work_item_id TEXT NOT NULL,
  selected_work_item_id TEXT NOT NULL,
  selection_source TEXT NOT NULL,
  selected_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_knowledge_base (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider TEXT,
  model_name TEXT,
  source_work_item_count INTEGER NOT NULL DEFAULT 0,
  raw_output TEXT,
  validated_output TEXT NOT NULL,
  status TEXT NOT NULL,
  error_details TEXT,
  extracted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, azure_project_id)
);

CREATE TABLE IF NOT EXISTS project_knowledge_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  knowledge_base_id TEXT NOT NULL,
  category TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_work_item_ids TEXT NOT NULL,
  evidence TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_knowledge_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  knowledge_base_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  mode TEXT NOT NULL,
  provider TEXT,
  model_name TEXT,
  source_work_item_count INTEGER NOT NULL DEFAULT 0,
  source_change_summary_json TEXT,
  raw_output TEXT,
  validated_output TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_knowledge_entry_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  knowledge_base_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  category TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source_work_item_ids TEXT NOT NULL,
  evidence TEXT NOT NULL,
  metadata_json TEXT,
  content_hash TEXT NOT NULL,
  superseded_by_entry_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_knowledge_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  source_ids TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_knowledge_lint_issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  category TEXT,
  entry_key TEXT,
  source_work_item_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_auto_update_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  cron_timezone TEXT NOT NULL DEFAULT 'server local time',
  context_work_item_types TEXT NOT NULL DEFAULT '[]',
  context_states TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  context_sync_mode TEXT,
  context_fetched_count INTEGER NOT NULL DEFAULT 0,
  context_indexed_work_item_count INTEGER NOT NULL DEFAULT 0,
  context_indexed_chunk_count INTEGER NOT NULL DEFAULT 0,
  context_created_count INTEGER NOT NULL DEFAULT 0,
  context_updated_count INTEGER NOT NULL DEFAULT 0,
  context_unchanged_count INTEGER NOT NULL DEFAULT 0,
  context_inactive_count INTEGER NOT NULL DEFAULT 0,
  context_skipped_empty_count INTEGER NOT NULL DEFAULT 0,
  knowledge_base_id TEXT,
  knowledge_source_work_item_count INTEGER NOT NULL DEFAULT 0,
  knowledge_compile_mode TEXT,
  knowledge_compile_status TEXT NOT NULL DEFAULT 'pending',
  knowledge_compile_skipped_reason TEXT,
  error_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS project_knowledge_entries_fts USING fts5(
  project_id UNINDEXED,
  azure_project_id UNINDEXED,
  entry_id UNINDEXED,
  category UNINDEXED,
  entry_key UNINDEXED,
  title,
  content,
  source_work_item_ids UNINDEXED,
  evidence,
  metadata_json UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS requirement_analysis_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  target_work_item_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider TEXT,
  model_name TEXT,
  selected_context_ids TEXT,
  user_input TEXT,
  raw_output TEXT,
  validated_output TEXT,
  token_usage TEXT,
  cost_estimate REAL,
  status TEXT NOT NULL,
  error_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requirement_analysis_findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  finding_json TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS selected_requirement_findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  edited_json TEXT NOT NULL,
  selected INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS azure_devops_comment_drafts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  azure_work_item_id TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS azure_devops_comment_push_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  azure_work_item_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  push_status TEXT NOT NULL,
  push_error TEXT,
  azure_comment_id TEXT,
  last_pushed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_case_generation_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  target_work_item_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider TEXT,
  model_name TEXT,
  selected_context_ids TEXT,
  generation_options_json TEXT,
  raw_output TEXT,
  validated_output TEXT,
  token_usage TEXT,
  cost_estimate REAL,
  status TEXT NOT NULL,
  error_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generated_test_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  local_test_case_id TEXT NOT NULL,
  test_case_json TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  target_work_item_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  preconditions TEXT,
  test_data TEXT,
  expected_result TEXT,
  priority TEXT,
  severity TEXT,
  test_type TEXT,
  automation_suitability TEXT,
  tags TEXT,
  azure_test_case_id TEXT,
  push_status TEXT,
  push_error TEXT,
  last_pushed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_case_steps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  test_case_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  action TEXT NOT NULL,
  expected_result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS selected_test_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  run_id TEXT,
  test_case_id TEXT NOT NULL,
  selected INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manual_test_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  target_work_item_id TEXT NOT NULL,
  test_case_id TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_case_edit_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  test_case_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT,
  actor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS existing_test_case_review_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  target_work_item_id TEXT NOT NULL,
  linked_test_case_ids TEXT,
  selected_context_ids TEXT,
  prompt_version TEXT NOT NULL,
  provider TEXT,
  model_name TEXT,
  raw_output TEXT,
  validated_output TEXT,
  status TEXT NOT NULL,
  error_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS existing_test_case_review_findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  finding_json TEXT NOT NULL,
  severity TEXT,
  category TEXT,
  selected INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suggested_test_case_additions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  test_case_json TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS azure_devops_test_case_push_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  azure_work_item_id TEXT NOT NULL,
  azure_test_plan_id TEXT NOT NULL,
  azure_test_suite_id TEXT NOT NULL,
  selected_test_case_ids TEXT NOT NULL,
  push_status TEXT NOT NULL,
  push_error TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_pushed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS azure_devops_test_case_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  azure_project_name TEXT NOT NULL,
  azure_organization_url TEXT NOT NULL,
  azure_work_item_id TEXT NOT NULL,
  azure_test_case_id TEXT NOT NULL,
  azure_test_plan_id TEXT,
  azure_test_suite_id TEXT,
  relationship_type TEXT NOT NULL,
  push_status TEXT,
  push_error TEXT,
  last_pushed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scoring_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  azure_project_id TEXT NOT NULL,
  target_work_item_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  scores_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_providers_config (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  azure_project_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  base_url TEXT,
  encrypted_api_key_reference TEXT,
  max_tokens INTEGER NOT NULL DEFAULT 4000,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  azure_project_id TEXT,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_schema_json TEXT NOT NULL,
  output_schema_json TEXT NOT NULL,
  system_instructions TEXT NOT NULL,
  user_instructions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  azure_project_id TEXT,
  azure_project_name TEXT,
  azure_organization_url TEXT,
  entity_type TEXT,
  entity_id TEXT,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  actor TEXT,
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_request_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  azure_project_id TEXT,
  azure_project_name TEXT,
  azure_organization_url TEXT,
  target_work_item_id TEXT,
  action TEXT,
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  prompt_name TEXT,
  prompt_version TEXT,
  system_prompt TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  request_body_json TEXT,
  response_body_json TEXT,
  raw_output TEXT,
  validated_output_json TEXT,
  status TEXT NOT NULL,
  error_details TEXT,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_items_project ON azure_devops_work_items(project_id, azure_project_id);
CREATE INDEX IF NOT EXISTS idx_chunks_project ON document_chunks(project_id, azure_project_id);
CREATE INDEX IF NOT EXISTS idx_context_selected_project ON context_selected_items(project_id, azure_project_id);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_base_project ON project_knowledge_base(project_id, azure_project_id);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_entries_project ON project_knowledge_entries(project_id, azure_project_id);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_revisions_project ON project_knowledge_revisions(project_id, azure_project_id, revision_number);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_entry_versions_project ON project_knowledge_entry_versions(project_id, azure_project_id, category, entry_key);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_log_project ON project_knowledge_log(project_id, azure_project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_lint_project ON project_knowledge_lint_issues(project_id, azure_project_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_context_auto_update_runs_project ON context_auto_update_runs(project_id, azure_project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_test_cases_project ON test_cases(project_id, azure_project_id);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(project_id, azure_project_id);
CREATE INDEX IF NOT EXISTS idx_llm_request_logs_project ON llm_request_logs(project_id, azure_project_id);
CREATE INDEX IF NOT EXISTS idx_llm_request_logs_created_at ON llm_request_logs(created_at);
