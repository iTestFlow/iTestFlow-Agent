"use client";

import { useEffect, useState } from "react";

import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";

/**
 * Tracks the active Azure DevOps project scope from localStorage and keeps it in
 * sync with the `itestflow:active-project-changed` window event. Returns `undefined`
 * while the initial read is pending, `null` when no project is selected.
 */
export function useActiveProject() {
  const [scope, setScope] = useState<ActiveProjectScope | null | undefined>(undefined);

  useEffect(() => {
    setScope(readActiveProject());
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setScope(custom.detail ?? readActiveProject());
    };
    window.addEventListener("itestflow:active-project-changed", onChange);
    return () => window.removeEventListener("itestflow:active-project-changed", onChange);
  }, []);

  return scope;
}
