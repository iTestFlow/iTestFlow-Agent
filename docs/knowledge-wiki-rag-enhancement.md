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

## Duplicate-Rule Reconciliation

- Same-id business-rule entries are one logical claim and merge by default: the longer wording wins and evidence quotes are unioned.
- A merge is refused only for a provable atomic value contradiction with the same atomic identity. Both entries remain and the hard-conflict review blocks publication.
- The contradiction guard is module-agnostic, so a provable disagreement is never fused. Same-identity pairs that are not comparable (for example, unit mismatch or overlapping ranges) merge with their evidence preserved.
- Full rebuilds extract purely from current source work items and do not re-feed the published knowledge base. Incremental builds reconcile only changed sources.
- This intentionally accepts unprovable soft disagreements as one entry with all supporting quotes preserved, matching the main-branch behavior while keeping genuine atomic contradictions reviewable.

## Scheduled Auto-Update

- The cron scheduler runs in the background worker, so at least one worker must be running when a schedule is due.
- Cron expressions are evaluated in the worker host's local timezone.
- Each due schedule enqueues a deduplicated Incremental Sync job for every active project in the workspace, using its configured work-item types and states.
- When the worker processes a job, it indexes Azure DevOps context with the workspace sync credential and records created, updated, unchanged, inactive, and skipped-empty counts in the project context log.
- Scheduled sync does not compile or replace the saved knowledge base and does not create a knowledge revision. An owner or admin reviews and runs knowledge compilation from Knowledge Hub.
- Manual Knowledge Hub controls remain user-triggered: context indexing or rebuild, knowledge compilation, full recompile, logs, and Markdown export.

## Health Rules

The deterministic lint pass runs automatically after each knowledge publication and checks for:

- Missing or inactive source work item IDs.
- Entries without active source support.
- Duplicate category/key entries.
- Missing evidence.
- Business rules that reference unknown modules.
- Dependencies that reference unknown modules, glossary terms, workflow names, or allowed external endpoints.
- Workflow-step dependency endpoints are accepted when their parent workflow or module is known; future saves normalize those endpoints to the parent and retain the original step detail in the dependency description.

Future LLM lint can add contradiction detection, missing glossary links, and broader consistency checks.

## Retrieval

Retrieval combines up to three independent signals, fused via reciprocal rank
fusion (`src/modules/rag/hybrid-ranking.ts`). Every signal beyond full-text search
is optional and degrades silently on failure — a signal being unavailable or
erroring never breaks retrieval, it only means that call falls back to whichever
signals remain.

**Full-text search** (always on, the baseline). Workflow context retrieval and the
Business Owner Assistant both query the `document_chunks_fts` /
`project_knowledge_entries_fts` tables through the shared query builder in
`src/modules/rag/full-text-search.ts` (prefix-matched terms plus a small QA-domain
synonym expansion). `to_tsquery('simple', 'term:*')` matches only a word's own
prefix, so a query for "flow" cannot match "workflow" — that gap is what trigram
search below closes.

**Trigram search** (always on, no configuration). `src/modules/rag/trigram-search.ts`
queries the same two FTS mirror tables via PostgreSQL's `pg_trgm` extension
(`word_similarity()`/`<%`, GIN-indexed — see
`migrations/1710000023200_trigram_search.js`), catching compound-word/infix matches
word-prefix FTS matching misses (e.g. "flow" matching "workflow"). Queries under 3
characters skip trigram entirely (too little signal to compare).

**Semantic retrieval** (always on, no configuration). Context indexing embeds
work-item chunks
through `src/modules/rag/embedding-provider.ts` into the `embeddings` table
(`source_type = 'azure_work_item_chunk'`), and every knowledge base save embeds the
compiled knowledge entries into the same table under a separate
`source_type = 'project_knowledge_entry'` (keyed on each entry's stable
`category`/`entryKey` identity rather than its per-save row id, since
`project_knowledge_entries` gets a fresh id on every save — see
`syncProjectKnowledgeEntryEmbeddings` in `src/modules/rag/embedding-store.service.ts`).
Exactly one model is used and it cannot be changed: nomic-embed-text-v1.5 runs
in-process via transformers.js/ONNX (`src/modules/rag/local-embedding.ts`),
auto-downloading quantized weights (~131 MB) into `data/model-cache` on first use —
zero user setup, no server, no API key, no setting. Pinning the model is deliberate:
vectors are only comparable within the model that produced them, so a swappable
backend would silently invalidate every stored vector until a full re-index. A model
that cannot be loaded degrades retrieval to full-text + trigram rather than failing.
Retrieval quality is proven against the real weights in
`embedding-model.quality.db.test.ts` and `embedding-retrieval.quality.db.test.ts`
(`npm run test:model`).
Nomic models get retrieval task prefixes
(document vs. query) applied automatically.

**Where each signal is wired in**: `src/modules/rag/hybrid-chunk-search.ts` is the
shared FTS+semantic+trigram search for raw work-item chunks, used by both
`retrieveStoredProjectContext` (workflow auto-context) and the Business Owner
Assistant's context search — extracted so both call sites share one ranking/fusion
implementation instead of drifting apart. The Business Owner Assistant's knowledge
search (`searchKnowledge` in `src/modules/rag/context-chatbot-retrieval.service.ts`)
independently fuses the same three signals against compiled knowledge entries. When
neither trigram nor semantic contributes anything to a given call — e.g. the model
failed to load, or trigram found nothing — the raw full-text ranking is kept as-is
rather than run through reciprocal rank fusion, since fusing a single list would
flatten `ts_rank_cd`'s real score spread for no benefit.

**Known limitation — non-English content and the local embedding model.**
`nomic-embed-text-v1.5` is English-centric. This codebase
explicitly supports Arabic-language project content elsewhere (see the Arabic
Unicode range preserved in `normalizeKey` in `src/modules/rag/project-knowledge.service.ts`),
and Arabic content will get materially weaker semantic search quality than English
content — full-text search and trigram search are
unaffected, since both are language-agnostic (`to_tsvector('simple', ...)` does no
stemming, and trigram similarity is character-based). If a project's content is
predominantly non-English, changing the pinned model in
`src/modules/rag/embedding-provider.ts` to a multilingual one is a code change, not a
setting — and requires re-indexing every project so stored vectors match the new
model. There is no multilingual configuration path today.

The `VectorStore` interface (`src/modules/rag/rag-types.ts`) and its in-memory
`LocalKeywordVectorStore` are a currently-unused port kept for a future pluggable
vector backend (e.g. pgvector at larger scale); production semantic search goes
through `src/modules/rag/embedding-store.service.ts` directly.

## Impacted Areas

- Project Context / RAG: incremental sync replaces full delete-and-rebuild as the default.
- Project Knowledge Base: saves now create revisions, entry versions, log events, and lint results.
- Business Owner Assistant: cited answers can be promoted as candidate knowledge for review.
- `/knowledge-hub`: exposes context indexing mode, rebuild, compiled knowledge log, and Markdown export.
- QA workflows: continue consuming the active `ProjectKnowledgeBase` shape, now backed by revision history and publish-time lint checks.
