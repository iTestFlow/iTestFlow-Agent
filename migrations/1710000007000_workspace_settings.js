/* eslint-disable camelcase */

/**
 * Per-workspace settings: retrieval breadth (top-K) and the LLM max output token
 * cap. One optional row per workspace, keyed directly by workspace_id (no project
 * derivation, so no trigger — unlike the project-scoped tables in
 * 1710000003000_workspace_scoping). A NULL column means "inherit the deployment
 * default" (PROJECT_CONTEXT_TOP_K env / 8 for top-K; DEFAULT_MAX_OUTPUT_TOKEN_CAP
 * for the cap), so a workspace that never sets these behaves exactly as before.
 * Owners/admins edit them in Settings → Workspace. Timestamps are ISO-8601 text.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE workspace_settings (
      workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      retrieval_top_k integer,
      max_output_token_cap integer,
      updated_by_user_id text REFERENCES users(id),
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS workspace_settings CASCADE;`);
};
