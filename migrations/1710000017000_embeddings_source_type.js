/* eslint-disable camelcase */

/**
 * Adds a source_type discriminator to embeddings so a second embedding pipeline
 * (project knowledge entries, on top of the existing raw work-item chunk pipeline)
 * can share the table without cross-contaminating orphan cleanup.
 *
 * Without this, syncProjectChunkEmbeddings' orphan-cleanup query deletes any
 * embeddings row whose chunk_id doesn't exist in document_chunks -- a knowledge-entry
 * embedding row (keyed by a synthetic id, not a real document_chunks.id) would look
 * orphaned and get deleted on the very next chunk sync. source_type scopes each
 * pipeline's queries to its own rows so the two pipelines are mutually exclusive by
 * construction.
 *
 * The unique index moves from (chunk_id) to (source_type, chunk_id) accordingly.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn("embeddings", {
    source_type: { type: "text", notNull: true, default: "azure_work_item_chunk" },
  });
  pgm.dropIndex("embeddings", ["chunk_id"], { name: "idx_embeddings_chunk_unique" });
  pgm.createIndex("embeddings", ["source_type", "chunk_id"], {
    unique: true,
    name: "idx_embeddings_source_chunk_unique",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex("embeddings", ["source_type", "chunk_id"], { name: "idx_embeddings_source_chunk_unique" });
  pgm.createIndex("embeddings", ["chunk_id"], { unique: true, name: "idx_embeddings_chunk_unique" });
  pgm.dropColumn("embeddings", "source_type");
};
