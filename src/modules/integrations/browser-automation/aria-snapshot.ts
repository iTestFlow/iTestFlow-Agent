/**
 * Aria snapshot parsing for @playwright/mcp@0.0.78 snapshots — the worker's
 * ground truth for validating model-proposed element refs.
 *
 * Snapshot lines look like:
 *   - button "Save" [ref=e5] [cursor=pointer]
 *   - checkbox "Accept terms" [checked] [ref=e12]
 *   - text: plain text content
 */

export type SnapshotNode = {
  role: string;
  name: string;
  ref: string | null;
  checked: boolean | "mixed" | null;
  disabled: boolean;
  selected: boolean;
  /** Trimmed snapshot line without the list dash — human-readable label. */
  line: string;
};

const NODE_LINE_PATTERN = /^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s+\[[^\]]*\])*)\s*:?\s*$/;
const ATTRIBUTE_PATTERN = /\[([a-z]+)(?:=([^\]]*))?\]/g;
const TEXT_LINE_PATTERN = /^\s*-\s+text:\s*(.*)$/;

export function parseAriaSnapshot(snapshotText: string): SnapshotNode[] {
  const nodes: SnapshotNode[] = [];
  for (const rawLine of snapshotText.split("\n")) {
    if (TEXT_LINE_PATTERN.test(rawLine)) continue;
    const match = NODE_LINE_PATTERN.exec(rawLine);
    if (!match) continue;
    const [, role, quotedName, attributeBlock] = match;

    let ref: string | null = null;
    let checked: boolean | "mixed" | null = null;
    let disabled = false;
    let selected = false;
    if (attributeBlock) {
      for (const attribute of attributeBlock.matchAll(ATTRIBUTE_PATTERN)) {
        const [, key, value] = attribute;
        if (key === "ref" && value) ref = value;
        else if (key === "checked") checked = value === "mixed" ? "mixed" : true;
        else if (key === "disabled") disabled = true;
        else if (key === "selected") selected = true;
      }
    }
    // Unchecked checkboxes/radios render without a [checked] attribute.
    if (checked === null && (role === "checkbox" || role === "radio" || role === "switch")) {
      checked = false;
    }

    nodes.push({
      role,
      name: quotedName ? quotedName.replace(/\\(.)/g, "$1") : "",
      ref,
      checked,
      disabled,
      selected,
      line: rawLine.trim().replace(/^-\s+/, "").replace(/:$/, ""),
    });
  }
  return nodes;
}

/** The set of element refs the model is allowed to target this iteration. */
export function collectSnapshotRefs(snapshotText: string): Set<string> {
  const refs = new Set<string>();
  for (const node of parseAriaSnapshot(snapshotText)) {
    if (node.ref) refs.add(node.ref);
  }
  return refs;
}

/** Checked state of the node carrying `ref`, when present in the snapshot. */
export function findSnapshotCheckedState(snapshotText: string, ref: string): boolean | "mixed" | null {
  for (const node of parseAriaSnapshot(snapshotText)) {
    if (node.ref === ref) return node.checked;
  }
  return null;
}
