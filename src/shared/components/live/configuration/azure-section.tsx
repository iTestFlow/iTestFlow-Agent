"use client";

import { Loader2, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FormState } from "./form-state";
import type { ServiceTestResult } from "./types";
import { ConnectionResult, Field, SecretField } from "./section-card";

/** True when the value parses as an http(s) URL — mirrors the schema's `.url()` requirement. */
export function isValidOrganizationUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Inline validation feedback for the organization URL field. */
function organizationUrlHint(value: string): { tone: "error" | "warning"; message: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!isValidOrganizationUrl(trimmed)) {
    return { tone: "error", message: "Enter a valid URL, for example https://dev.azure.com/your-org." };
  }
  let host = "";
  try {
    host = new URL(trimmed).host.toLowerCase();
  } catch {
    host = "";
  }
  const looksAzure = host === "dev.azure.com" || host.endsWith(".visualstudio.com");
  if (!looksAzure) {
    return {
      tone: "warning",
      message: "This doesn't look like an Azure DevOps organization URL (dev.azure.com/your-org or your-org.visualstudio.com).",
    };
  }
  return null;
}

export function AzureSection({
  form,
  update,
  hasSavedPat,
  onTest,
  testing,
  testResult,
}: {
  form: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  hasSavedPat: boolean;
  onTest: () => void;
  testing: boolean;
  testResult?: ServiceTestResult;
}) {
  const hint = organizationUrlHint(form.organizationUrl);

  return (
    <div className="space-y-5">
      <Field
        label="Azure DevOps Organization URL"
        htmlFor="azure-org-url"
        description="The PAT authenticates the request; this URL tells iTestFlow which Azure DevOps organization endpoint to call."
      >
        <Input
          id="azure-org-url"
          className="h-11 border-input bg-card text-foreground"
          value={form.organizationUrl}
          onChange={(event) => update("organizationUrl", event.target.value)}
          placeholder="https://dev.azure.com/your-org"
          aria-invalid={hint?.tone === "error" ? true : undefined}
        />
        {hint ? (
          <p
            className={cn(
              "mt-2 text-xs leading-5",
              hint.tone === "error" ? "text-destructive" : "text-warning-foreground dark:text-warning",
            )}
          >
            {hint.message}
          </p>
        ) : null}
      </Field>

      <SecretField
        id="azure-pat"
        label="Azure DevOps Personal Access Token (PAT)"
        value={form.personalAccessToken}
        onChange={(value) => update("personalAccessToken", value)}
        placeholder="Enter Azure DevOps PAT"
        hasSaved={hasSavedPat}
        description="Use a PAT with Work Items (Read & Write) and Test Management (Read & Write) scopes. Stored encrypted on this machine."
      />

      <div className="space-y-3">
        <Button type="button" variant="outline" onClick={onTest} disabled={testing}>
          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Test Azure DevOps Connection
        </Button>
        <ConnectionResult label="Azure DevOps" result={testResult} />
      </div>
    </div>
  );
}
