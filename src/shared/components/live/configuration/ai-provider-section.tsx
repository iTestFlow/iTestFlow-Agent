"use client";

import { ChevronDown, Loader2, RefreshCw, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ModelPicker, type ModelOption } from "@/shared/components/live/model-picker";
import type { FormState } from "./form-state";
import type { Provider, ServiceTestResult } from "./types";
import {
  ConnectionResult,
  Field,
  SecretField,
  defaultBaseUrlPlaceholder,
  providerLabel,
} from "./section-card";

function providerHelp(provider: Provider): string {
  switch (provider) {
    case "openai":
      return "Use an OpenAI API key. Leave empty to keep the saved token; re-enter it only when rotating credentials.";
    case "gemini":
      return "Use a Google AI Studio API key. Leave empty to keep the saved token; re-enter it only when rotating credentials.";
    case "anthropic":
      return "Use an Anthropic API key. Leave empty to keep the saved token; re-enter it only when rotating credentials.";
    case "ollama":
      return "Runs against a local Ollama server. Add a token only if your endpoint requires authentication.";
  }
}

export function AiProviderSection({
  form,
  update,
  canUseSavedLlmKey,
  onProviderChange,
  models,
  loadingModels,
  modelError,
  selectedModelLabel,
  modelDropdownOpen,
  setModelDropdownOpen,
  onRefreshModels,
  onSelectModel,
  modelsRefreshedAt,
  onTest,
  testing,
  testResult,
}: {
  form: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  canUseSavedLlmKey: boolean;
  onProviderChange: (provider: Provider) => void;
  models: ModelOption[];
  loadingModels: boolean;
  modelError: string | null;
  selectedModelLabel: string;
  modelDropdownOpen: boolean;
  setModelDropdownOpen: (open: boolean) => void;
  onRefreshModels: () => void;
  onSelectModel: (modelId: string) => void;
  modelsRefreshedAt: Date | null;
  onTest: () => void;
  testing: boolean;
  testResult?: ServiceTestResult;
}) {
  const isOllama = form.provider === "ollama";
  const canLoadModels = isOllama || form.apiKey.trim().length > 0 || canUseSavedLlmKey;

  const modelHint = !canLoadModels
    ? "Enter the provider API token, then refresh to load models from the live provider API."
    : loadingModels
      ? "Fetching available models from the selected provider API..."
      : modelError
        ? "Model list could not be loaded. Use Refresh models to try again."
        : modelsRefreshedAt
          ? "Models loaded from the provider API. Use Refresh models to update the list."
          : "Use Refresh models to load the latest models from the provider API.";

  return (
    <div className="space-y-5">
      <Field label="LLM Provider" htmlFor="llm-provider">
        <select
          id="llm-provider"
          className="h-11 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
          value={form.provider}
          onChange={(event) => onProviderChange(event.target.value as Provider)}
        >
          <option value="openai">OpenAI</option>
          <option value="gemini">Gemini</option>
          <option value="anthropic">Anthropic</option>
          <option value="ollama">Ollama</option>
        </select>
      </Field>

      <SecretField
        id="llm-api-token"
        label={isOllama ? "LLM API Token (optional)" : "LLM API Token"}
        value={form.apiKey}
        onChange={(value) => update("apiKey", value)}
        placeholder="Enter LLM API token"
        hasSaved={canUseSavedLlmKey}
        description={providerHelp(form.provider)}
      />

      <Field
        label="Provider Base URL (optional)"
        htmlFor="llm-base-url"
        description="Optional. Use this only for Azure OpenAI, a proxy, or another provider-compatible endpoint."
      >
        <Input
          id="llm-base-url"
          className="h-11 border-input bg-card text-foreground"
          value={form.baseUrl}
          onChange={(event) => update("baseUrl", event.target.value)}
          placeholder={defaultBaseUrlPlaceholder(form.provider)}
        />
      </Field>

      <Field label="LLM Model" htmlFor="llm-model">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Popover
            open={modelDropdownOpen}
            onOpenChange={(open) => {
              setModelDropdownOpen(open);
              if (open && !models.length && canLoadModels) onRefreshModels();
            }}
          >
            <PopoverTrigger asChild>
              <button
                id="llm-model"
                type="button"
                aria-expanded={modelDropdownOpen}
                className="flex h-11 w-full items-center justify-between rounded-md border border-input bg-card px-3 text-left text-sm"
              >
                <span className="truncate">{loadingModels ? "Loading models from provider..." : selectedModelLabel}</span>
                {loadingModels ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="p-0"
              style={{ width: "var(--radix-popover-trigger-width)" }}
            >
              <ModelPicker
                models={models}
                loading={loadingModels}
                error={modelError}
                providerLabel={providerLabel(form.provider)}
                currentModel={form.model}
                autoFocus
                emptyHint="Use Refresh models to load models from the selected provider API."
                onRetry={onRefreshModels}
                onSelect={(modelId) => {
                  onSelectModel(modelId);
                  setModelDropdownOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="outline"
            className="h-11 shrink-0"
            onClick={onRefreshModels}
            disabled={loadingModels || !canLoadModels}
          >
            {loadingModels ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh models
          </Button>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{modelHint}</p>
        {modelError ? <p className="mt-1 text-xs leading-5 text-destructive">{modelError}</p> : null}
      </Field>

      <div className="space-y-3">
        <Button type="button" variant="outline" onClick={onTest} disabled={testing}>
          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Test AI provider connection
        </Button>
        <ConnectionResult label="AI provider" result={testResult} />
      </div>
    </div>
  );
}
