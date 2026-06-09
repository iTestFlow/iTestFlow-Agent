export const RUNTIME_SETTINGS_CHANGED_EVENT = "itestflow:runtime-settings-changed";

/**
 * Notify mounted listeners (e.g. the topbar status chips and the settings form) that
 * runtime settings changed. Pass the fresh summary as `detail` so listeners can update
 * in place; omit it to ask listeners to reload the summary from the API.
 */
export function dispatchRuntimeSettingsChanged(summary?: unknown) {
  window.dispatchEvent(new CustomEvent(RUNTIME_SETTINGS_CHANGED_EVENT, { detail: summary }));
}

/**
 * Subscribe to runtime-settings changes. Returns an unsubscribe function suitable for
 * returning directly from a `useEffect`. The detail type is supplied by the caller since
 * different surfaces hold structurally-narrower views of the summary.
 */
export function subscribeRuntimeSettingsChanged<TDetail = unknown>(
  handler: (summary: TDetail | undefined) => void,
): () => void {
  const listener = (event: Event) => {
    handler((event as CustomEvent<TDetail | undefined>).detail);
  };
  window.addEventListener(RUNTIME_SETTINGS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(RUNTIME_SETTINGS_CHANGED_EVENT, listener);
}
