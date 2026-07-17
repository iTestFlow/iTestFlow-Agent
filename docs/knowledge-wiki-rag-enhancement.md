# Compiled Knowledge RAG Enhancement

This design adapts Andrej Karpathy's LLM-maintained wiki idea for iTestFlow:

https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

## Intent

iTestFlow keeps Azure DevOps work items as source truth and compiles them into a durable, cited project knowledge layer. Normal RAG retrieves raw context chunks at question time. The compiled knowledge layer preserves project understanding across runs so requirement analysis, test generation, coverage review, bug reporting, and the Business Owner Assistant reuse the same source-backed project memory.

## Operating Model

- Raw Azure DevOps work items remain immutable source evidence.
- Context sync stores active work items incrementally using content hashes.
- Knowledge compilation keeps the existing `ProjectKnowledgeBase` JSON contract as the active app format.
- Each compiled knowledge save records a revision, per-entry versions, event-log rows, and lint results.
- Retired, superseded, confirmed, and candidate knowledge versions are retained for audit/history.
- Markdown export is a personal/project knowledge-base surface, not the runtime source of truth.

## Scheduled Auto-Update

- The cron scheduler runs in the background worker, so at least one worker must be running when a schedule is due.
- Cron expressions are evaluated in the worker host's local timezone.
- Each due schedule enqueues a deduplicated Incremental Sync job for every active project in the workspace, using its configured work-item types and states.
- When the worker processes a job, it indexes Azure DevOps context with the workspace sync credential and records created, updated, unchanged, inactive, and skipped-empty counts in the project context log.
- Scheduled sync does not compile or replace the saved knowledge base and does not create a knowledge revision. An owner or admin reviews and runs knowledge compilation from Knowledge Hub.
- Manual Knowledge Hub controls remain user-triggered: context indexing or rebuild, knowledge compilation, full recompile, health checks, logs, and Markdown export.

## Health Rules

The deterministic lint pass checks for:

- Missing or inactive source work item IDs.
- Entries without active source support.
- Duplicate category/key entries.
- Missing evidence.
- Business rules that reference unknown modules.
- Dependencies that reference unknown modules, glossary terms, workflow names, or allowed external endpoints.
- Workflow-step dependency endpoints are accepted when their parent workflow or module is known; future saves normalize those endpoints to the parent and retain the original step detail in the dependency description.

Future LLM lint can add contradiction detection, missing glossary links, and broader consistency checks.

## Retrieval

Baseline retrieval is PostgreSQL full-text search: workflow context retrieval and
the Business Owner Assistant both query the `document_chunks_fts` /
`project_knowledge_entries_fts` tables through the shared query builder in
`src/modules/rag/full-text-search.ts` (prefix-matched terms plus a small QA-domain
synonym expansion).

Semantic retrieval is optional and deployment-configured (`EMBEDDINGS_PROVIDER` in
`.env`, off by default). When enabled, context indexing embeds chunks through
`src/modules/rag/embedding-provider.ts` into the `embeddings` table, and workflow
retrieval fuses cosine-ranked semantic hits with the full-text list via reciprocal
rank fusion (`src/modules/rag/hybrid-ranking.ts`). The recommended backend is
`local`: nomic-embed-text runs in-process via transformers.js/ONNX
(`src/modules/rag/local-embedding.ts`), auto-downloading quantized weights (~70MB)
into `data/model-cache` on first use — zero user setup. Server/cloud alternatives:
local Ollama, any OpenAI-compatible server, or Gemini. Nomic models get retrieval
task prefixes and Gemini gets retrieval task types (document vs. query) applied
automatically. Every embedding failure degrades to full-text-only retrieval;
semantic search augments lexical search, it never replaces it. The Business Owner
Assistant currently remains full-text-only.

The `VectorStore` interface (`src/modules/rag/rag-types.ts`) and its in-memory
`LocalKeywordVectorStore` are a currently-unused port kept for a future pluggable
vector backend (e.g. pgvector at larger scale); production semantic search goes
through `src/modules/rag/embedding-store.service.ts` directly.

## Impacted Areas

- Project Context / RAG: incremental sync replaces full delete-and-rebuild as the default.
- Project Knowledge Base: saves now create revisions, entry versions, log events, and lint results.
- Business Owner Assistant: cited answers can be promoted as candidate knowledge for review.
- `/knowledge-hub`: exposes context indexing mode, rebuild, compiled knowledge health, log, and Markdown export.
- QA workflows: continue consuming the active `ProjectKnowledgeBase` shape, now backed by revision history and health checks.
