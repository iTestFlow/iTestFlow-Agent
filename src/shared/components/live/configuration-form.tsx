"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CheckCircle2, ChevronDown, Eye, EyeOff, Loader2, Search, ShieldCheck, XCircle } from "lucide-react";
import { Button, Card, TextInput } from "@/shared/components/ui";

type Provider = "openai" | "gemini" | "anthropic";

type FormState = {
  organizationUrl: string;
  personalAccessToken: string;
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  retryAttempts: number;
};

type TestResult = {
  success: boolean;
  azureDevOps: { success: boolean; error?: string };
  llm: { success: boolean; error?: string };
};

type ModelOption = {
  id: string;
  displayName: string;
  source: Provider;
};

type ApiErrorPayload = {
  error?: string;
  validationErrors?: Array<{
    field: string;
    label: string;
    message: string;
  }>;
};

export function ConfigurationForm({
  mode = "setup",
  redirectTo = "/dashboard",
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
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [modelError, setModelError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [hasSavedLlmKey, setHasSavedLlmKey] = useState(false);
  const [savedLlmProvider, setSavedLlmProvider] = useState<Provider | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [form, setForm] = useState<FormState>({
    organizationUrl: "",
    personalAccessToken: "",
    provider: "openai",
    model: "",
    apiKey: "",
    baseUrl: "",
    temperature: 0.2,
    maxTokens: 4000,
    retryAttempts: 1,
  });

  const selectedModels = useMemo(() => models, [models]);
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) return selectedModels;
    return selectedModels.filter((model) => {
      return model.id.toLowerCase().includes(query) || model.displayName.toLowerCase().includes(query);
    });
  }, [modelSearch, selectedModels]);
  const selectedModelLabel = selectedModels.find((model) => model.id === form.model)?.displayName ?? (form.model || "Select a model from live provider API");
  const canUseSavedLlmKey = hasSavedLlmKey && savedLlmProvider === form.provider;

  useEffect(() => {
    fetch("/api/settings/runtime", { cache: "no-store" })
      .then((response) => response.json())
      .then((summary) => {
        if (!summary.configured) return;
        setForm((current) => ({
          ...current,
          organizationUrl: summary.azureDevOps?.organizationUrl ?? "",
          provider: summary.llm?.provider ?? current.provider,
          model: summary.llm?.model ?? current.model,
          baseUrl: summary.llm?.baseUrl ?? "",
          temperature: summary.llm?.temperature ?? current.temperature,
          maxTokens: summary.llm?.maxTokens ?? current.maxTokens,
          retryAttempts: summary.llm?.retryAttempts ?? current.retryAttempts,
        }));
        setHasSavedLlmKey(Boolean(summary.llm?.hasApiKey));
        setSavedLlmProvider(summary.llm?.provider ?? null);
        setMessage(
          summary.savedAt === "env"
            ? "Loaded bootstrap settings from .env.local. Save here to move configuration into encrypted local runtime settings."
            : "Loaded saved local runtime settings. Re-enter secrets only when rotating credentials.",
        );
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setModels([]);
    setModelError(null);
  }, [form.provider, form.apiKey, form.baseUrl]);

  async function loadModelsFromProvider() {
    if (loadingModels) return;

    const requestedProvider = form.provider;
    const typedApiKey = form.apiKey.trim();

    setLoadingModels(true);
    setModelError(null);
    try {
      const response = await fetch("/api/settings/llm-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: requestedProvider,
          apiKey: typedApiKey || undefined,
          baseUrl: form.baseUrl.trim() || undefined,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(json, "Could not fetch provider models."));

      const fetched = (json.models ?? []) as ModelOption[];
      if (!fetched.length) {
        setModels([]);
        setModelError("No models were returned from the selected provider API.");
        return;
      }

      setModels(fetched);
      setModelError(null);
      setForm((current) => {
        if (current.provider !== requestedProvider) return current;
        return {
          ...current,
          model: fetched.some((model) => model.id === current.model) ? current.model : fetched[0].id,
        };
      });
    } catch (err) {
      setModels([]);
      setModelError(err instanceof Error ? err.message : "Could not fetch provider models.");
    } finally {
      setLoadingModels(false);
    }
  }

  function toggleModelDropdown() {
    setModelDropdownOpen((current) => {
      const next = !current;
      if (next) {
        setModelSearch("");
        void loadModelsFromProvider();
      }
      return next;
    });
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
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
        temperature: form.temperature,
        maxTokens: form.maxTokens,
        retryAttempts: form.retryAttempts,
      },
    };
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
      onSaved?.();
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save runtime settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={embedded ? "text-slate-950" : "min-h-screen bg-background p-[30px] text-slate-950"}>
      <div className={embedded ? "" : "grid min-h-[840px] gap-[120px] xl:grid-cols-[370px_minmax(0,1fr)]"}>
        {!embedded ? (
        <aside className="flex flex-col rounded-[10px] border border-[#c8d4e4] bg-white p-10">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">iTestFlow</h2>
            <p className="mt-5 max-w-56 text-lg font-semibold leading-6 text-slate-600">
              AI-Powered Testing Lifecycle Assistant
            </p>
          </div>
          <div className="mt-16 space-y-6">
            {["Connect Azure DevOps", "Configure LLM Provider", "Secure & Local First", "Start Intelligent Testing"].map((item) => (
              <div key={item} className="flex items-center gap-3 text-sm font-medium">
                <span className="flex h-5 w-5 items-center justify-center rounded border border-blue-600 text-blue-600">
                  <Check className="h-3.5 w-3.5" />
                </span>
                {item}
              </div>
            ))}
          </div>
          <div className="mt-auto text-xs text-slate-500">(c) 2026 iTestFlow</div>
        </aside>
        ) : null}

        <div className={embedded ? "" : "flex items-center justify-center"}>
          <Card className={`${embedded ? "w-full max-w-3xl" : "w-full max-w-[600px]"} border-[#c8d4e4] bg-white text-slate-950 shadow-none`}>
            <div className={embedded ? "p-6" : "p-12"}>
              <h1 className={embedded ? "text-xl font-bold tracking-tight" : "text-3xl font-bold tracking-tight"}>
                {embedded ? "Runtime Configuration" : "Initial Configuration"}
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                {embedded ? "View and update the live integration settings used by this local app." : "Set up your local connections to get started."}
              </p>

              <div className="mt-8 space-y-5">
                <Field
                  label="Azure DevOps Organization URL"
                  description="Required. The PAT authenticates the request; this URL tells iTestFlow which Azure DevOps organization endpoint to call."
                >
                  <TextInput
                    className="border-slate-300 bg-white text-slate-950"
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
                    className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                    value={form.provider}
                    onChange={(event) => {
                      const provider = event.target.value as Provider;
                      setModelDropdownOpen(false);
                      setModelSearch("");
                      setModelError(null);
                      setModels([]);
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
                    <option value="anthropic">Claude / Anthropic</option>
                  </select>
                </Field>

                <Field label="LLM API Token">
                  <SecretInput show={showSecrets} value={form.apiKey} onChange={(value) => update("apiKey", value)} placeholder="Enter LLM API token" />
                </Field>

                <Field label="Select LLM Model">
                  <div className="relative">
                    <button
                      type="button"
                      className="flex h-11 w-full items-center justify-between rounded-md border border-slate-300 bg-white px-3 text-left text-sm"
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
                      {loadingModels ? <Loader2 className="h-4 w-4 animate-spin text-blue-600" /> : <ChevronDown className="h-4 w-4 text-slate-500" />}
                    </button>
                    {modelDropdownOpen ? (
                      <div className="absolute bottom-full z-[100] mb-1 max-h-96 w-full overflow-hidden rounded-md border border-slate-300 bg-white text-sm shadow-lg">
                        <div className="sticky top-0 border-b border-slate-200 bg-white p-2">
                          <div className="flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-2">
                            <Search className="h-4 w-4 shrink-0 text-slate-500" />
                            <input
                              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
                              value={modelSearch}
                              onChange={(event) => setModelSearch(event.target.value)}
                              placeholder="Search models..."
                              autoFocus
                            />
                          </div>
                        </div>
                        <div className="max-h-80 overflow-auto py-1">
                        {loadingModels ? (
                          <div className="flex items-center gap-2 px-3 py-3 text-slate-600">
                            <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                            Loading {providerLabel(form.provider)} models...
                          </div>
                        ) : modelError ? (
                          <div className="space-y-3 px-3 py-3">
                            <div className="text-sm text-red-700">{modelError}</div>
                            <button
                              type="button"
                              className="rounded-md border border-blue-600 px-3 py-2 text-xs font-medium text-blue-700"
                              onClick={() => void loadModelsFromProvider()}
                            >
                              Retry Loading Models
                            </button>
                          </div>
                        ) : null}
                        {!loadingModels && filteredModels.length ? (
                          filteredModels.map((model) => (
                            <button
                              key={model.id}
                              type="button"
                              className={`block w-full px-3 py-2 text-left hover:bg-blue-50 ${model.id === form.model ? "bg-blue-50 text-blue-700" : "text-slate-900"}`}
                              onClick={() => {
                                update("model", model.id);
                                setModelDropdownOpen(false);
                              }}
                            >
                              <span className="block truncate">{model.displayName}</span>
                              <span className="block truncate font-mono text-[11px] text-slate-500">{model.id}</span>
                            </button>
                          ))
                        ) : !loadingModels && !modelError ? (
                          <div className="px-3 py-3 text-slate-600">
                            {modelSearch ? "No models match your search." : "Open the dropdown to load models from the selected provider API."}
                          </div>
                        ) : (
                          null
                        )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {form.apiKey || canUseSavedLlmKey
                      ? loadingModels
                        ? "Fetching all available models from the selected provider API..."
                        : modelError
                          ? "Model list could not be loaded from the selected provider API."
                          : "Open the dropdown to refresh models from the selected provider API."
                      : "Enter the provider API token, then open the dropdown to load models from the live provider API."}
                  </div>
                  {modelError ? <div className="mt-1 text-xs text-red-700">{modelError}</div> : null}
                </Field>

                <Field
                  label="Retry attempts on transient LLM failure"
                  description="0 disables automatic retry. Default is 1 retry after the initial request."
                >
                  <TextInput
                    className="border-slate-300 bg-white text-slate-950"
                    type="number"
                    min={0}
                    max={5}
                    step={1}
                    value={form.retryAttempts}
                    onChange={(event) => update("retryAttempts", Number(event.target.value || "0"))}
                  />
                </Field>

                <button
                  type="button"
                  className="flex items-center gap-2 text-xs font-medium text-blue-700"
                  onClick={() => setShowSecrets((current) => !current)}
                >
                  {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  {showSecrets ? "Hide tokens" : "Show tokens"}
                </button>

                {message ? (
                  <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                    <CheckCircle2 className="h-4 w-4" />
                    {message}
                  </div>
                ) : null}
                {error ? (
                  <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                    <XCircle className="h-4 w-4" />
                    {error}
                  </div>
                ) : null}
                {testResult ? (
                  <div className="grid gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm md:grid-cols-2">
                    <Status label="Azure DevOps" ok={testResult.azureDevOps.success} error={testResult.azureDevOps.error} />
                    <Status label="LLM Provider" ok={testResult.llm.success} error={testResult.llm.error} />
                  </div>
                ) : null}

                <div className="grid gap-4 pt-2 md:grid-cols-2">
                  <Button className="h-11 bg-blue-600 text-white hover:bg-blue-700" onClick={testConnections} disabled={testing || saving}>
                    {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    Test Connections
                  </Button>
                  <Button
                    variant="secondary"
                    className="h-11 border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100"
                    onClick={saveAndContinue}
                    disabled={testing || saving}
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {embedded ? "Save Configuration" : "Continue"}
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-slate-900">{label}</span>
      {children}
      {description ? <span className="mt-2 block text-xs leading-5 text-slate-500">{description}</span> : null}
    </label>
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
    <TextInput
      className="border-slate-300 bg-white text-slate-950"
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
      <div className={`font-semibold ${ok ? "text-emerald-700" : "text-red-700"}`}>{label}: {ok ? "Connected" : "Failed"}</div>
      {error ? <div className="mt-1 text-xs text-red-700">{error}</div> : null}
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
      return "Claude / Anthropic";
  }
}

function apiErrorMessage(payload: unknown, fallback: string) {
  const json = payload as ApiErrorPayload;
  if (json?.error) return json.error;
  if (json?.validationErrors?.length) {
    return json.validationErrors.map((item) => `${item.label}: ${item.message}`).join(" ");
  }
  return fallback;
}
