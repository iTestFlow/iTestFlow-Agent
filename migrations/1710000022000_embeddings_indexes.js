/* eslint-disable camelcase */

/**
 * Prepares the (previously unused) embeddings table for semantic retrieval writes.
 * Chunk ids embed the owning project id, so they are globally unique; the unique
 * index enables ON CONFLICT (chunk_id) upserts when embeddings are refreshed. The
 * lookup index serves project-scoped vector loads and orphan cleanup.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // The table has never been written by application code, but stay safe on
  // databases that were touched manually: keep one row per chunk before adding
  // the unique index.
  pgm.sql(`
    DELETE FROM embeddings a
    USING embeddings b
    WHERE a.chunk_id = b.chunk_id
      AND a.ctid < b.ctid;
  `);
  pgm.createIndex("embeddings", ["chunk_id"], {
    unique: true,
    name: "idx_embeddings_chunk_unique",
  });
  pgm.createIndex("embeddings", ["project_id", "azure_project_id"], {
    name: "idx_embeddings_project_lookup",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex("embeddings", ["project_id", "azure_project_id"], {
    name: "idx_embeddings_project_lookup",
  });
  pgm.dropIndex("embeddings", ["chunk_id"], { name: "idx_embeddings_chunk_unique" });
};
