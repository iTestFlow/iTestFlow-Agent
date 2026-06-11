"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { Check, CheckCircle2, ChevronDown, Eye, EyeOff, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ContextFilterSelector } from "@/components/domain/context-filter-selector";
import { BRAND_LOGO_FULL_SRC } from "@/lib/constants";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_CONTEXT_STATES,
  DEFAULT_CONTEXT_WORK_ITEM_TYPES,
} from "@/lib/project-context-defaults";
import {
  DEFAULT_MAX_OUTPUT_TOKEN_CAP,
  DEFAULT_RETRY_ATTEMPTS,
  MAX_OUTPUT_TOKEN_CAP_OPTIONS,
  RETRY_ATTEMPT_OPTIONS,
} from "@/modules/llm/llm-defaults";
import { DEFAULT_AUTO_UPDATE_CRON_EXPRESSION } from "@/modules/settings/cron-expression";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";
import { dispatchRuntimeSettingsChanged } from "@/shared/lib/runtime-settings-events";
import {
  projectScopeKey,
  retainAvailableSelections,
  selectAvailableDefaults,
  useProjectWorkItemMetadata,
} from "@/shared/lib/use-project-work-item-metadata";
import { ModelPicker, useProviderModels } from "@/shared/components/live/model-picker";
import { apiErrorMessage } from "@/shared/validators/api-validation-errors";

type Provider = "openai" | "gemini" | "anthropic" | "ollama";

type FormState = {
  organizationUrl: string;
  personalAccessToken: string;
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxOutputTokenCap: number;
  retryAttempts: number;
  retrievalTopK: number;
  autoUpdateEnabled: boolean;
  autoUpdateCronExpression: string;
  autoUpdateProjectScope: ActiveProjectScope | null;
  autoUpdateWorkItemTypes: string[];
  autoUpdateStates: string[];
};

type TestResult = {
  success: boolean;
  azureDevOps: { success: boolean; error?: string };
  llm: { success: boolean; error?: string };
};

export function ConfigurationForm({
  mode = "setup",
  redirectTo = "/dashboards",
  onSaved,
}: {
  mode?: "setup" | "settings";
  redirectTo?: string | null;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const embedded = mode === "settings";
  const [showSecrets, setShowSecrets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const { models, loading: loadingModels, error: modelError, load, reset: resetModels } = useProviderModels();
  const [hasSavedLlmKey, setHasSavedLlmKey] = useState(false);
  const [savedLlmProvider, setSavedLlmProvider] = useState<Provider | null>(null);
  const [activeProject, setActiveProject] = useState<ActiveProjectScope | null>(null);
  const [runtimeSettingsLoaded, setRuntimeSettingsLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [hasUnfinishedWork, setHasUnfinishedWork] = useState(false);
  useUnsavedChangesGuard({ dirty: hasUnfinishedWork, busy: saving || testing });
  const [form, setForm] = useState<FormState>({
    organizationUrl: "",
    personalAccessToken: "",
    provider: "openai",
    model: "",
    apiKey: "",
    baseUrl: "",
    maxOutputTokenCap: DEFAULT_MAX_OUTPUT_TOKEN_CAP,
    retryAttempts: DEFAULT_RETRY_ATTEMPTS,
    retrievalTopK: 8,
    autoUpdateEnabled: false,
    autoUpdateCronExpression: DEFAULT_AUTO_UPDATE_CRON_EXPRESSION,
    autoUpdateProjectScope: null,
    autoUpdateWorkItemTypes: DEFAULT_CONTEXT_WORK_ITEM_TYPES,
    autoUpdateStates: DEFAULT_CONTEXT_STATES,
  });
  const filterProjectKeyRef = useRef<string | null>(null);

  const selectedModelLabel = models.find((model) => model.id === form.model)?.displayName ?? (form.model || "Select a model from live provider API");
  const canUseSavedLlmKey = hasSavedLlmKey && savedLlmProvider === form.provider;
  const showAdvancedSettings = mode === "settings";
  const autoUpdateProject = activeProject ?? form.autoUpdateProjectScope;
  const autoUpdateProjectKey = projectScopeKey(autoUpdateProject);
  const {
    metadata: workItemMetadata,
    loading: workItemMetadataLoading,
    error: workItemMetadataError,
    retry: retryWorkItemMetadata,
  } = useProjectWorkItemMetadata(autoUpdateProject);

  useEffect(() => {
    fetch("/api/settings/runtime", { cache: "no-store" })
      .then((response) => response.json())
      .then((summary) => {
        if (!summary.configured) {
          setRuntimeSettingsLoaded(true);
          return;
        }
        const savedProjectScope = summary.context?.autoUpdate?.projectScope ?? null;
        filterProjectKeyRef.current = projectScopeKey(savedProjectScope);
        setForm((current) => ({
          ...current,
          organizationUrl: summary.azureDevOps?.organizationUrl ?? "",
          provider: summary.llm?.provider ?? current.provider,
          model: summary.llm?.model ?? current.model,
          baseUrl: summary.llm?.baseUrl ?? "",
          maxOutputTokenCap: summary.llm?.maxOutputTokenCap ?? current.maxOutputTokenCap,
          retryAttempts: summary.llm?.retryAttempts ?? current.retryAttempts,
          retrievalTopK: summary.context?.retrievalTopK ?? current.retrievalTopK,
          autoUpdateEnabled: summary.context?.autoUpdate?.enabled ?? current.autoUpdateEnabled,
          autoUpdateCronExpression: summary.context?.autoUpdate?.cronExpression ?? current.autoUpdateCronExpression,
          autoUpdateProjectScope: savedProjectScope ?? current.autoUpdateProjectScope,
          autoUpdateWorkItemTypes: summary.context?.autoUpdate?.workItemTypes ?? current.autoUpdateWorkItemTypes,
          autoUpdateStates: summary.context?.autoUpdate?.states ?? current.autoUpdateStates,
        }));
        setHasSavedLlmKey(Boolean(summary.llm?.hasApiKey));
        setSavedLlmProvider(summary.llm?.provider ?? null);
        setMessage(
          summary.savedAt === "env"
            ? "Loaded bootstrap settings from .env.local. Save here to move configuration into encrypted local runtime settings."
            : "Loaded saved local runtime settings. Re-enter secrets only when rotating credentials.",
        );
        setRuntimeSettingsLoaded(true);
      })
      .catch(() => setRuntimeSettingsLoaded(true));
  }, []);

  useEffect(() => {
    setActiveProject(readActiveProject());
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setActiveProject(custom.detail ?? readActiveProject());
      setHasUnfinishedWork(false);
    };
    window.addEventListener("itestflow:active-project-changed", onChange);
    return () => window.removeEventListener("itestflow:active-project-changed", onChange);
  }, []);

  useEffect(() => {
    resetModels();
  }, [form.provider, form.apiKey, form.baseUrl, resetModels]);

  useEffect(() => {
    if (!runtimeSettingsLoaded || !autoUpdateProjectKey || !workItemMetadata) return;

    const preserveCurrentSelections = filterProjectKeyRef.current === autoUpdateProjectKey;
    filterProjectKeyRef.current = autoUpdateProjectKey;
    setForm((current) => ({
      ...current,
      autoUpdateWorkItemTypes: preserveCurrentSelections
        ? retainAvailableSelections(current.autoUpdateWorkItemTypes, workItemMetadata.workItemTypes)
        : selectAvailableDefaults(DEFAULT_CONTEXT_WORK_ITEM_TYPES, workItemMetadata.workItemTypes),
      autoUpdateStates: preserveCurrentSelections
        ? retainAvailableSelections(current.autoUpdateStates, workItemMetadata.states)
        : selectAvailableDefaults(DEFAULT_CONTEXT_STATES, workItemMetadata.states),
    }));
  }, [autoUpdateProjectKey, runtimeSettingsLoaded, workItemMetadata]);

  async function loadModelsFromProvider() {
    if (loadingModels) return;

    const requestedProvider = form.provider;
    const fetched = await load({
      provider: requestedProvider,
      apiKey: form.apiKey.trim() || undefined,
      baseUrl: form.baseUrl.trim() || undefined,
    });

    if (fetched && fetched.length) {
      const nextModel = fetched.some((model) => model.id === form.model) ? form.model : fetched[0].id;
      if (nextModel !== form.model) setHasUnfinishedWork(true);
      setForm((current) => {
        if (current.provider !== requestedProvider) return current;
        return {
          ...current,
          model: fetched.some((model) => model.id === current.model) ? current.model : fetched[0].id,
        };
      });
    }
  }

  function toggleModelDropdown() {
    setModelDropdownOpen((current) => {
      const next = !current;
      if (next) void loadModelsFromProvider();
      return next;
    });
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setHasUnfinishedWork(true);
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
    setMessage(null);
    setTestResult(null);
  }

  function payload() {
    return {
      azureDevOps: {
        organizationUrl: form.organizationUrl.trim(),
        personalAccessToken: form.personalAccessToken,
      },
      llm: {
        provider: form.provider,
        model: form.model.trim(),
        apiKey: form.apiKey,
        baseUrl: form.baseUrl.trim() || undefined,
        maxOutputTokenCap: form.maxOutputTokenCap,
        retryAttempts: form.retryAttempts,
      },
      context: {
        retrievalTopK: form.retrievalTopK,
        autoUpdate: {
          enabled: form.autoUpdateEnabled,
          cronExpression: form.autoUpdateCronExpression.trim() || DEFAULT_AUTO_UPDATE_CRON_EXPRESSION,
          projectScope: form.autoUpdateEnabled ? autoUpdateProject : null,
          workItemTypes: form.autoUpdateWorkItemTypes,
          states: form.autoUpdateStates,
        },
      },
    };
  }

  function toggleAutoUpdate(enabled: boolean) {
    setHasUnfinishedWork(true);
    const selectedProject = readActiveProject();
    if (selectedProject) setActiveProject(selectedProject);
    setForm((current) => ({
      ...current,
      autoUpdateEnabled: enabled,
      autoUpdateProjectScope: enabled ? selectedProject ?? current.autoUpdateProjectScope : current.autoUpdateProjectScope,
    }));
    setError(null);
    setMessage(null);
    setTestResult(null);
  }

  async function testConnections() {
    setTesting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/test-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(json, "Connection test failed."));
      setTestResult(json);
      setMessage(json.success ? "Both connections validated successfully." : "One or more connection tests failed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection test failed.");
    } finally {
      setTesting(false);
    }
  }

  async function saveAndContinue() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/runtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(json, "Could not save runtime settings."));
      setMessage("Configuration saved locally. Live integrations will use these values now.");
      dispatchRuntimeSettingsChanged(json);
      onSaved?.();
      setHasUnfinishedWork(false);
      if (redirectTo) {
        router.push(redirectTo);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save runtime settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={embedded ? "text-foreground" : "min-h-screen bg-background p-[30px] text-foreground"}>
      <div className={embedded ? "" : "grid min-h-[840px] gap-[120px] xl:grid-cols-[370px_minmax(0,1fr)]"}>
        {!embedded ? (
        <aside className="flex flex-col rounded-[10px] border border-border bg-card p-10">
          <div>
            <Image
              src={BRAND_LOGO_FULL_SRC}
              alt="iTestFlow"
              width={1554}
              height={346}
              priority
              className="h-auto w-full max-w-[300px]"
            />
          </div>
          <div className="mt-16 space-y-6">
            {["Connect Azure DevOps", "Configure LLM Provider", "Secure & Local First", "Start Intelligent Testing"].map((item) => (
              <div key={item} className="flex items-center gap-3 text-sm font-medium">
                <span className="flex h-5 w-5 items-center justify-center rounded border border-primary text-primary">
                  <Check className="h-3.5 w-3.5" />
                </span>
                {item}
              </div>
            ))}
          </div>
          <div className="mt-auto text-xs text-muted-foreground">(c) 2026 iTestFlow</div>
        </aside>
        ) : null}

        <div className={embedded ? "" : "flex items-center justify-center"}>
          <div className={`${embedded ? "w-full max-w-3xl" : "w-full max-w-[600px]"} rounded-2xl border border-border bg-card text-foreground`}>
            <div className={embedded ? "p-6" : "p-12"}>
              <h1 className={embedded ? "text-xl font-bold tracking-tight" : "text-3xl font-bold tracking-tight"}>
                {embedded ? "Runtime Configuration" : "Initial Configuration"}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {embedded ? "View and update the live integration settings used by this local app." : "Set up your local connections to get started."}
              </p>

              <div className="mt-8 space-y-5">
                <Field
                  label="Azure DevOps Organization URL"
                  description="Required. The PAT authenticates the request; this URL tells iTestFlow which Azure DevOps organization endpoint to call."
                >
                  <Input
                    className="h-11 border-input bg-card text-foreground"
                    value={form.organizationUrl}
                    onChange={(event) => update("organizationUrl", event.target.value)}
                    placeholder="https://dev.azure.com/your-org"
                  />
                </Field>

                <Field label="Azure DevOps Personal Access Token (PAT)">
                  <SecretInput
                    show={showSecrets}
                    value={form.personalAccessToken}
                    onChange={(value) => update("personalAccessToken", value)}
                    placeholder="Enter Azure DevOps PAT"
                  />
                </Field>

                <Field label="Select LLM Provider">
                  <select
                    className="h-11 w-full rounded-md border border-input bg-card px-3 text-sm"
                    value={form.provider}
                    onChange={(event) => {
                      setHasUnfinishedWork(true);
                      const provider = event.target.value as Provider;
                      setModelDropdownOpen(false);
                      resetModels();
                      setForm((current) => ({
                        ...current,
                        provider,
                        model: "",
                        baseUrl: "",
                      }));
                    }}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="gemini">Gemini</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="ollama">Ollama</option>
                  </select>
                </Field>

                <Field
                  label={form.provider === "ollama" ? "LLM API Token (optional)" : "LLM API Token"}
                  description={form.provider === "ollama" ? "Only needed when your Ollama endpoint requires authentication." : undefined}
                >
                  <SecretInput show={showSecrets} value={form.apiKey} onChange={(value) => update("apiKey", value)} placeholder="Enter LLM API token" />
                </Field>

                <Field
                  label="Provider Base URL"
                  description="Optional. Use this when routing provider requests through a proxy or custom-compatible endpoint."
                >
                  <Input
                    className="h-11 border-input bg-card text-foreground"
                    value={form.baseUrl}
                    onChange={(event) => update("baseUrl", event.target.value)}
                    placeholder={defaultBaseUrlPlaceholder(form.provider)}
                  />
                </Field>

                <Field label="Select LLM Model">
                  <div className="relative">
                    <button
                      type="button"
                      className="flex h-11 w-full items-center justify-between rounded-md border border-input bg-card px-3 text-left text-sm"
                      onClick={toggleModelDropdown}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          if (!modelDropdownOpen) toggleModelDropdown();
                        }
                        if (event.key === "Escape") setModelDropdownOpen(false);
                      }}
                    >
                      <span className="truncate">{loadingModels ? "Loading models from provider..." : selectedModelLabel}</span>
                      {loadingModels ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    </button>
                    {modelDropdownOpen ? (
                      <div className="absolute bottom-full z-[100] mb-1 w-full overflow-hidden rounded-md border border-input bg-popover shadow-lg">
                        <ModelPicker
                          models={models}
                          loading={loadingModels}
                          error={modelError}
                          providerLabel={providerLabel(form.provider)}
                          currentModel={form.model}
                          autoFocus
                          emptyHint="Open the dropdown to load models from the selected provider API."
                          onRetry={() => void loadModelsFromProvider()}
                          onSelect={(modelId) => {
                            update("model", modelId);
                            setModelDropdownOpen(false);
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {form.provider === "ollama" || form.apiKey || canUseSavedLlmKey
                      ? loadingModels
                        ? "Fetching all available models from the selected provider API..."
                        : modelError
                          ? "Model list could not be loaded from the selected provider API."
                          : "Open the dropdown to refresh models from the selected provider API."
                      : "Enter the provider API token, then open the dropdown to load models from the live provider API."}
                  </div>
                  {modelError ? <div className="mt-1 text-xs text-destructive">{modelError}</div> : null}
                </Field>

                {showAdvancedSettings ? (
                  <>
                    <section className="rounded-xl border border-border bg-muted/30 p-4 md:p-5">
                      <div>
                        <h2 className="text-base font-semibold text-foreground">LLM Output and Retry Controls</h2>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          Bound output size, transient retries, and structured-response recovery.
                        </p>
                      </div>

                      <div className="mt-5 grid gap-5 md:grid-cols-2">
                        <Field
                          label="Maximum output token cap"
                          description="Absolute ceiling for every structured-output request. The first attempt already requests this full cap."
                        >
                          <NumberSelect
                            value={form.maxOutputTokenCap}
                            options={MAX_OUTPUT_TOKEN_CAP_OPTIONS}
                            formatOption={(value) => `${value.toLocaleString()} tokens`}
                            onChange={(value) => update("maxOutputTokenCap", value)}
                          />
                        </Field>

                        <Field
                          label="Transient failure retries"
                          description="Extra attempts after network failures or retryable provider responses."
                        >
                          <NumberSelect
                            value={form.retryAttempts}
                            options={RETRY_ATTEMPT_OPTIONS}
                            formatOption={(value) => value === 0 ? "0 (disabled)" : `${value} ${value === 1 ? "retry" : "retries"}`}
                            onChange={(value) => update("retryAttempts", value)}
                          />
                        </Field>
                      </div>
                    </section>

                    <Field
                      label="Project context retrieval count"
                      description="Number of stored context items auto-selected for analysis and test design. Default is 8."
                    >
                      <Input
                        className="h-11 border-input bg-card text-foreground"
                        type="number"
                        min={1}
                        max={25}
                        step={1}
                        value={form.retrievalTopK}
                        onChange={(event) => update("retrievalTopK", Number(event.target.value || "8"))}
                      />
                    </Field>

                    <div className="rounded-md border border-border bg-muted/40 p-4 text-foreground">
                      <Label className="flex items-start gap-3">
                        <Checkbox
                          checked={form.autoUpdateEnabled}
                          onCheckedChange={(checked) => toggleAutoUpdate(checked === true)}
                          className="mt-0.5"
                        />
                        <span>
                          <span className="block text-sm font-medium text-foreground">
                            Auto update project context and knowledge base
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            Runs on the local server for the selected Azure DevOps project using the filters configured here.
                          </span>
                        </span>
                      </Label>

                      {form.autoUpdateEnabled ? (
                        <div className="mt-4 space-y-3 border-t border-border pt-4">
                          <Field
                            label="Cron expression"
                            description="Use 5 fields: minute hour day-of-month month day-of-week. Example: 0 2 * * * runs daily at 2:00 AM local server time."
                          >
                            <Input
                              className="h-11 border-input bg-card font-mono text-foreground"
                              value={form.autoUpdateCronExpression}
                              onChange={(event) => update("autoUpdateCronExpression", event.target.value)}
                              placeholder={DEFAULT_AUTO_UPDATE_CRON_EXPRESSION}
                            />
                          </Field>
                          <div className={`rounded-md border p-3 text-xs ${autoUpdateProject ? "border-primary/30 bg-primary/10 text-primary dark:text-primary" : "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning"}`}>
                            Scheduled project: {autoUpdateProject ? autoUpdateProject.azureProjectName : "Select an Azure DevOps project in the header before saving."}
                          </div>
                          <ContextFilterSelector
                            title="Work item types"
                            description="Select from every work item type available in the scheduled Azure DevOps project."
                            options={workItemMetadata?.workItemTypes ?? []}
                            selectedValues={form.autoUpdateWorkItemTypes}
                            loading={workItemMetadataLoading}
                            error={workItemMetadataError}
                            disabled={!autoUpdateProject}
                            searchPlaceholder="Search work item types"
                            emptyMessage="No work item types were returned for this project."
                            onRetry={retryWorkItemMetadata}
                            onChange={(next) => update("autoUpdateWorkItemTypes", next)}
                          />
                          <ContextFilterSelector
                            title="States"
                            description="Select from the combined states available across this project's work item types."
                            options={workItemMetadata?.states ?? []}
                            selectedValues={form.autoUpdateStates}
                            loading={workItemMetadataLoading}
                            error={workItemMetadataError}
                            disabled={!autoUpdateProject}
                            searchPlaceholder="Search states"
                            emptyMessage="No work item states were returned for this project."
                            onRetry={retryWorkItemMetadata}
                            onChange={(next) => update("autoUpdateStates", next)}
                          />
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : null}

                <button
                  type="button"
                  className="flex items-center gap-2 text-xs font-medium text-primary"
                  onClick={() => setShowSecrets((current) => !current)}
                >
                  {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  {showSecrets ? "Hide tokens" : "Show tokens"}
                </button>

                {message ? (
                  <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 p-3 text-sm text-success">
                    <CheckCircle2 className="h-4 w-4" />
                    {message}
                  </div>
                ) : null}
                {error ? (
                  <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    <XCircle className="h-4 w-4" />
                    {error}
                  </div>
                ) : null}
                {testResult ? (
                  <div className="grid gap-3 rounded-md border border-border bg-muted p-3 text-sm md:grid-cols-2">
                    <Status label="Azure DevOps" ok={testResult.azureDevOps.success} error={testResult.azureDevOps.error} />
                    <Status label="LLM Provider" ok={testResult.llm.success} error={testResult.llm.error} />
                  </div>
                ) : null}

                <div className="grid gap-4 pt-2 md:grid-cols-2">
                  <Button className="h-11" onClick={testConnections} disabled={testing || saving}>
                    {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    Test Connections
                  </Button>
                  <Button
                    variant="secondary"
                    className="h-11"
                    onClick={saveAndContinue}
                    disabled={testing || saving}
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {embedded ? "Save Configuration" : "Continue"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-foreground">{label}</span>
      {children}
      {description ? <span className="mt-2 block text-xs leading-5 text-muted-foreground">{description}</span> : null}
    </label>
  );
}

function NumberSelect({
  value,
  options,
  formatOption,
  onChange,
}: {
  value: number;
  options: readonly number[];
  formatOption: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <select
      className="h-11 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {formatOption(option)}
        </option>
      ))}
    </select>
  );
}

function SecretInput({
  show,
  value,
  onChange,
  placeholder,
}: {
  show: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <Input
      className="h-11 border-input bg-card text-foreground"
      type={show ? "text" : "password"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
    />
  );
}

function Status({ label, ok, error }: { label: string; ok: boolean; error?: string }) {
  return (
    <div>
      <div className={`font-semibold ${ok ? "text-success" : "text-destructive"}`}>{label}: {ok ? "Connected" : "Failed"}</div>
      {error ? <div className="mt-1 text-xs text-destructive">{error}</div> : null}
    </div>
  );
}

function providerLabel(provider: Provider) {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "gemini":
      return "Gemini";
    case "anthropic":
      return "Anthropic";
    case "ollama":
      return "Ollama";
  }
}

function defaultBaseUrlPlaceholder(provider: Provider) {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "anthropic":
      return "https://api.anthropic.com";
    case "ollama":
      return "http://localhost:11434";
  }
}
