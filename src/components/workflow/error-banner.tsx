import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Passive failure banner for non-LLM integration calls (Azure DevOps reads
 * etc.): notify, don't offer retry — a page revisit or project switch
 * refetches. Extracted from the Suite Migration client so every module
 * renders request failures identically.
 */
export function ErrorBanner({ title = "Request failed", message }: { title?: string; message: string }) {
  return (
    <Alert className="border-destructive/30 bg-destructive/10">
      <AlertTriangle className="size-4 text-destructive" />
      <AlertTitle className="justify-self-start text-left">{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
