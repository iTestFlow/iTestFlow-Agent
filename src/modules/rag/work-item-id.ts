/**
 * Canonicalizes user-entered work item identifiers to the plain numeric string the
 * database stores (`azure_work_item_id` is always `String(item.id)` from the Azure
 * DevOps REST payload — see azure-devops-mapper.ts). Benchmark labels are typed by
 * hand, so "AB#1234", "#1234", "WI:1234" and pasted work-item URLs are all common;
 * stored verbatim they can never match retrieval output and silently score zero.
 *
 * No `server-only` import: pure string logic, unit-tested like
 * retrieval-benchmark-scorer.ts.
 */

const PLAIN_ID = /^\d+$/;
// "#1234" and prefixed forms like "AB#1234" (Azure Boards' cross-service mention syntax).
const HASH_PREFIXED = /^[a-z]*#(\d+)$/i;
// "WI:1234" — the sourceId prefix this codebase itself uses for citations.
const WI_PREFIXED = /^wi:\s*(\d+)$/i;
// Work item URLs: the web UI's /_workitems/edit/1234 and the REST API's /workItems/1234,
// tolerating a trailing slash, query string, or fragment.
const URL_FORM = /(?:\/_workitems\/edit\/|\/workitems\/)(\d+)(?=[/?#]|$)/i;

/**
 * Returns the canonical numeric work item id ("1234") for any accepted input form,
 * or null when no work item number can be extracted.
 */
export function normalizeExpectedWorkItemId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const digits = PLAIN_ID.test(trimmed)
    ? trimmed
    : (HASH_PREFIXED.exec(trimmed) ?? WI_PREFIXED.exec(trimmed) ?? URL_FORM.exec(trimmed))?.[1];
  if (!digits) return null;

  // The DB stores String(item.id), which never carries leading zeros.
  return digits.replace(/^0+(?=\d)/, "");
}
