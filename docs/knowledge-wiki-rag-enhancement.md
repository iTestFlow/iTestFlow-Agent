# Compiled Knowledge RAG Enhancement

This design adapts Andrej Karpathy's LLM-maintained wiki idea for iTestFlow:

https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

## Intent

iTestFlow keeps Azure DevOps work items as source truth and compiles them into a durable, cited project knowledge layer. Normal RAG retrieves raw context chunks at question time. The compiled knowledge layer preserves project understanding across runs so requirement analysis, test generation, coverage review, bug reporting, and the Context Chatbot reuse the same source-backed project memory.

## Operating Model

- Raw Azure DevOps work items remain immutable source evidence.
- Context sync stores active work items incrementally using content hashes.
- Knowledge compilation keeps the existing `ProjectKnowledgeBase` JSON contract as the active app format.
- Each compiled knowledge save records a revision, per-entry versions, event-log rows, and lint results.
- Retired, superseded, confirmed, and candidate knowledge versions are retained for audit/history.
- Markdown export is a personal/project knowledge-base surface, not the runtime source of truth.

## Health Rules

The deterministic lint pass checks for:

- Missing or inactive source work item IDs.
- Entries without active source support.
- Duplicate category/key entries.
- Missing evidence.
- Business rules that reference unknown modules.
- Dependencies that reference unknown modules.

Future LLM lint can add contradiction detection, missing glossary links, and broader consistency checks.

## Impacted Areas

- Project Context / RAG: incremental sync replaces full delete-and-rebuild as the default.
- Project Knowledge Base: saves now create revisions, entry versions, log events, and lint results.
- Context Chatbot: cited answers can be promoted as candidate knowledge for review.
- `/context`: exposes sync mode, full rebuild, compiled knowledge health, log, and Markdown export.
- QA workflows: continue consuming the active `ProjectKnowledgeBase` shape, now backed by revision history and health checks.
