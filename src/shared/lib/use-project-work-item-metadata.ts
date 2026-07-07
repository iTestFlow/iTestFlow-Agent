"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ActiveProjectScope } from "@/shared/lib/active-project";
import { apiErrorMessage, caughtErrorMessage } from "@/shared/lib/api-error-message";

export type ProjectWorkItemMetadata = {
  workItemTypes: string[];
  states: string[];
};

const metadataCache = new Map<string, ProjectWorkItemMetadata>();

export function useProjectWorkItemMetadata(scope: ActiveProjectScope | null) {
  const cacheKey = useMemo(() => projectScopeKey(scope), [scope]);
  const initialMetadata = cacheKey ? metadataCache.get(cacheKey) ?? null : null;
  const [metadataState, setMetadataState] = useState<{
    cacheKey: string;
    metadata: ProjectWorkItemMetadata;
  } | null>(
    cacheKey && initialMetadata ? { cacheKey, metadata: initialMetadata } : null,
  );
  const metadata = metadataState?.cacheKey === cacheKey ? metadataState.metadata : null;
  const [loading, setLoading] = useState(Boolean(scope && !initialMetadata));
  const [error, setError] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    if (!scope || !cacheKey) {
      setMetadataState(null);
      setLoading(false);
      setError(null);
      return;
    }

    const cached = metadataCache.get(cacheKey);
    if (cached) {
      setMetadataState({ cacheKey, metadata: cached });
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void fetch("/api/azure-devops/work-item-metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(apiErrorMessage(json, "Azure DevOps work item metadata fetch failed."));
        return json as ProjectWorkItemMetadata;
      })
      .then((nextMetadata) => {
        metadataCache.set(cacheKey, nextMetadata);
        setMetadataState({ cacheKey, metadata: nextMetadata });
      })
      .catch((requestError) => {
        if (controller.signal.aborted) return;
        setError(
          caughtErrorMessage(requestError, "Azure DevOps work item metadata fetch failed."),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [cacheKey, requestVersion, scope]);

  const retry = useCallback(() => {
    if (cacheKey) metadataCache.delete(cacheKey);
    setRequestVersion((current) => current + 1);
  }, [cacheKey]);

  return { metadata, loading, error, retry };
}

export function projectScopeKey(scope: ActiveProjectScope | null) {
  if (!scope) return null;
  return `${scope.azureOrganizationUrl.trim().toLocaleLowerCase()}::${scope.azureProjectId}`;
}

export function selectAvailableDefaults(defaults: string[], options: string[]) {
  const optionByKey = new Map(options.map((option) => [normalizeValue(option), option]));
  return defaults
    .map((value) => optionByKey.get(normalizeValue(value)))
    .filter((value): value is string => Boolean(value));
}

export function retainAvailableSelections(selected: string[], options: string[]) {
  const optionByKey = new Map(options.map((option) => [normalizeValue(option), option]));
  return selected
    .map((value) => optionByKey.get(normalizeValue(value)))
    .filter((value): value is string => Boolean(value));
}

function normalizeValue(value: string) {
  return value.trim().toLocaleLowerCase();
}
