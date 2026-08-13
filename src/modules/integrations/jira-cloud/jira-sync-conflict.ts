export type JiraSyncValue = string | number | boolean | null | string[];
export type JiraSyncFields = Record<string, JiraSyncValue | undefined>;

export type JiraFieldConflict = {
  field: string;
  baseline: JiraSyncValue | undefined;
  local: JiraSyncValue | undefined;
  remote: JiraSyncValue | undefined;
};

export function reconcileJiraFields(input: {
  baseline: JiraSyncFields;
  local: JiraSyncFields;
  remote: JiraSyncFields;
}) {
  const merged: JiraSyncFields = {};
  const pulls: JiraSyncFields = {};
  const pushes: JiraSyncFields = {};
  const conflicts: JiraFieldConflict[] = [];
  const fields = new Set([...Object.keys(input.baseline), ...Object.keys(input.local), ...Object.keys(input.remote)]);

  for (const field of fields) {
    const baseline = input.baseline[field];
    const local = input.local[field];
    const remote = input.remote[field];
    const localChanged = !same(local, baseline);
    const remoteChanged = !same(remote, baseline);
    if (localChanged && remoteChanged && !same(local, remote)) {
      merged[field] = local;
      conflicts.push({ field, baseline, local, remote });
    } else if (remoteChanged) {
      merged[field] = remote;
      if (!same(local, remote)) pulls[field] = remote;
    } else {
      merged[field] = local;
      if (localChanged) pushes[field] = local;
    }
  }
  return { merged, pulls, pushes, conflicts };
}

function same(left: JiraSyncValue | undefined, right: JiraSyncValue | undefined) {
  return JSON.stringify(left) === JSON.stringify(right);
}
