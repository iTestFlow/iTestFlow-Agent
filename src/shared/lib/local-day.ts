/**
 * Host-local calendar-day helpers shared by the project and system dashboards.
 *
 * The app is local-first: the Node process runs in the user's own timezone, so
 * "today" and daily trend buckets are computed against the host's local calendar
 * day rather than UTC. Azure DevOps timestamps are stored in UTC; convert
 * them with toLocalDayString for bucketing, and use localDayStartIso to derive the
 * UTC instant of a local day's midnight for fetch/query lower bounds.
 */

/** Local calendar day (YYYY-MM-DD) for a Date, in the host process timezone. */
export function toLocalDayString(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * UTC instant (ISO string) for local midnight of a YYYY-MM-DD day — a safe bound for
 * fetches and range queries against UTC-stored timestamps. The `T00:00:00` form (no Z)
 * is parsed as local time, so this is exactly the start of that local calendar day.
 */
export function localDayStartIso(day: string) {
  return new Date(`${day}T00:00:00`).toISOString();
}
