/* eslint-disable camelcase */

/**
 * Enables pg_trgm (ships with postgres:16-alpine, a trusted extension so no
 * superuser or OS-level install is needed) and adds trigram GIN indexes on the FTS
 * mirror tables' combined-text expression -- the same coalesce(...) concatenation
 * the existing generated `tsv` columns already index, lowercased so trigram
 * matching is case-insensitive like to_tsvector('simple', ...) already is.
 *
 * This complements full-text search rather than replacing it: to_tsquery prefix
 * matching cannot match a term that appears as a suffix/infix of a longer word
 * (e.g. "flow" cannot match "workflow", since "flow" isn't a prefix of "workflow").
 * Trigram similarity catches those compound-word cases. This is a lightweight,
 * near-universally-available extension, not a step toward the heavier pgvector
 * path already deferred in docs/knowledge-wiki-rag-enhancement.md.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

  pgm.sql(`
    CREATE INDEX idx_document_chunks_fts_trgm
    ON document_chunks_fts
    USING GIN ((lower(coalesce(title, '') || ' ' || coalesce(content, ''))) gin_trgm_ops);
  `);

  pgm.sql(`
    CREATE INDEX idx_project_knowledge_entries_fts_trgm
    ON project_knowledge_entries_fts
    USING GIN ((lower(coalesce(title, '') || ' ' || coalesce(content, '') || ' ' || coalesce(evidence, ''))) gin_trgm_ops);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_project_knowledge_entries_fts_trgm;`);
  pgm.sql(`DROP INDEX IF EXISTS idx_document_chunks_fts_trgm;`);
  // Extension is left installed: dropping it risks breaking other objects, and
  // CREATE EXTENSION IF NOT EXISTS is idempotent/cheap to reapply if this migration
  // is re-run up.
};
