"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";

import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { Button } from "@/components/ui/button";
import { BRAND_LOGO_FULL_SRC } from "@/lib/constants";
import {
  DEFAULT_CONTEXT_STATES,
  DEFAULT_CONTEXT_WORK_ITEM_TYPES,
} from "@/lib/project-context-defaults";
import { validateCronExpression } from "@/modules/settings/cron-expression";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";
import { dispatchRuntimeSettingsChanged } from "@/shared/lib/runtime-settings-events";
import {
  projectScopeKey,
  retainAvailableSelections,
  selectAvailableDefaults,
  useProjectWorkItemMetadata,
} from "@/shared/lib/use-project-work-item-metadata";
import { useProviderModels } from "@/shared/components/live/model-picker";
import { apiErrorMessage } from "@/shared/validators/api-validation-errors";

import { INITIAL_FORM, formsEqual, type FormState } from "./configuration/form-state";
import type { LatestAutoUpdateRun, Provider, TestResult } from "./configuration/types";
import { SectionCard, StatusBadge } from "./configuration/section-card";
import { AzureSection, isValidOrganizationUrl } from "./configuration/azure-section";
import { AiProviderSection } from "./configuration/ai-provider-section";
import { AdvancedLlmControls } from "./configuration/advanced-llm-controls";
import { ProjectContextSection } from "./configuration/project-context-section";
import { ScheduledSyncSection } from "./configuration/scheduled-sync-section";
import { StatusSummary } from "./configuration/status-summary";
import { SaveActionBar } from "./configuration/save-action-bar";
import { deriveAiStatus, deriveAzureStatus, deriveSyncStatus } from "./configuration/status";

const SETUP_CHECKLIST = [
  "Connect Azure DevOps",
  "Configure LLM Provider",
  "Secure & Local First",
  "Start Intelligent Testing",
];

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

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const { models, loading: loadingModels, error: modelError, load, reset: resetModels } = useProviderModels();
  const [hasSavedLlmKey, setHasSavedLlmKey] = useState(false);
  const [savedLlmProvider, setSavedLlmProvider] = useState<Provider | null>(null);
  const [hasSavedAzurePat, setHasSavedAzurePat] = useState(false);
  const [activeProject, setActiveProject] = useState<ActiveProjectScope | null>(null);
  const [runtimeSettingsLoaded, setRuntimeSettingsLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [lastTested, setLastTested] = useState<Date | null>(null);
  const [modelsRefreshedAt, setModelsRefreshedAt] = useState<Date | null>(null);
  const [latestRun, setLatestRun] = useState<LatestAutoUpdateRun | null>(null);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [savedBaseline, setSavedBaseline] = useState<FormState | null>(null);
  const filterProjectKeyRef = useRef<string | null>(null);
  const formRef = useRef(form);
  formRef.current = form;

  const isDirty = useMemo(() => (savedBaseline ? !formsEqual(form, savedBaseline) : false), [form, savedBaseline]);
  useUnsavedChangesGuard({ dirty: isDirty, busy: saving || testing });

  const selectedModelLabel =
    models.find((model) => model.id === form.model)?.displayName ??
    (form.model || "Select a model from the live provider API");
  const canUseSavedLlmKey = hasSavedLlmKey && savedLlmProvider === form.provider;
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
          setSavedBaseline(INITIAL_FORM);
          setRuntimeSettingsLoaded(true);
          return;
        }
        const savedProjectScope = summary.context?.autoUpdate?.projectScope ?? null;
        filterProjectKeyRef.current = projectScopeKey(savedProjectScope);
        const nextForm: FormState = {
          ...INITIAL_FORM,
          organizationUrl: summary.azureDevOps?.organizationUrl ?? "",
          provider: summary.llm?.provider ?? INITIAL_FORM.provider,
          model: summary.llm?.model ?? INITIAL_FORM.model,
          baseUrl: summary.llm?.baseUrl ?? "",
          maxOutputTokenCap: summary.llm?.maxOutputTokenCap ?? INITIAL_FORM.maxOutputTokenCap,
          retryAttempts: summary.llm?.retryAttempts ?? INITIAL_FORM.retryAttempts,
          retrievalTopK: summary.context?.retrievalTopK ?? INITIAL_FORM.retrievalTopK,
          autoUpdateEnabled: summary.context?.autoUpdate?.enabled ?? INITIAL_FORM.autoUpdateEnabled,
          autoUpdateCronExpression: summary.context?.autoUpdate?.cronExpression ?? INITIAL_FORM.autoUpdateCronExpression,
          autoUpdateProjectScope: savedProjectScope ?? INITIAL_FORM.autoUpdateProjectScope,
          autoUpdateWorkItemTypes: summary.context?.autoUpdate?.workItemTypes ?? INITIAL_FORM.autoUpdateWorkItemTypes,
          autoUpdateStates: summary.context?.autoUpdate?.states ?? INITIAL_FORM.autoUpdateStates,
        };
        setForm(nextForm);
        setSavedBaseline(nextForm);
        setHasSavedLlmKey(Boolean(summary.llm?.hasApiKey));
        setSavedLlmProvider(summary.llm?.provider ?? null);
        setHasSavedAzurePat(Boolean(summary.azureDevOps?.hasPersonalAccessToken));
        setLatestRun(summary.context?.autoUpdate?.latestRun ?? null);
        setMessage(
          summary.savedAt === "env"
            ? "Loaded bootstrap settings from .env.local. Save here to move configuration into encrypted local runtime settings."
            : "Loaded saved local runtime settings. Re-enter secrets only when rotating credentials.",
        );
        setRuntimeSettingsLoaded(true);
      })
      .catch(() => {
        setSavedBaseline(INITIAL_FORM);
        setRuntimeSettingsLoaded(true);
      });
  }, []);

  useEffect(() => {
    setActiveProject(readActiveProject());
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setActiveProject(custom.detail ?? readActiveProject());
    };
    window.addEventListener("itestflow:active-project-changed", onChange);
    return () => window.removeEventListener("itestflow:active-project-changed", onChange);
  }, []);

  useEffect(() => {
    resetModels();
    setModelsRefreshedAt(null);
  }, [form.provider, form.apiKey, form.baseUrl, resetModels]);

  useEffect(() => {
    if (!runtimeSettingsLoaded || !autoUpdateProjectKey || !workItemMetadata) return;

    const preserveCurrentSelections = filterProjectKeyRef.current === autoUpdateProjectKey;
    filterProjectKeyRef.current = autoUpdateProjectKey;
    const current = formRef.current;
    const nextWorkItemTypes = preserveCurrentSelections
      ? retainAvailableSelections(current.autoUpdateWorkItemTypes, workItemMetadata.workItemTypes)
      : selectAvailableDefaults(DEFAULT_CONTEXT_WORK_ITEM_TYPES, workItemMetadata.workItemTypes);
    const nextStates = preserveCurrentSelections
      ? retainAvailableSelections(current.autoUpdateStates, workItemMetadata.states)
      : selectAvailableDefaults(DEFAULT_CONTEXT_STATES, workItemMetadata.states);

    setForm((value) => ({ ...value, autoUpdateWorkItemTypes: nextWorkItemTypes, autoUpdateStates: nextStates }));

    // A project switch (not a user edit) re-seeds the filters from that project's
    // defaults. Re-baseline those fields so the auto-seed isn't read as unsaved work.
    if (!preserveCurrentSelections) {
      setSavedBaseline((baseline) =>
        baseline
          ? { ...baseline, autoUpdateWorkItemTypes: nextWorkItemTypes, autoUpdateStates: nextStates }
          : baseline,
      );
    }
  }, [autoUpdateProjectKey, runtimeSettingsLoaded, workItemMetadata]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
    setMessage(null);
    setTestResult(null);
  }

  function handleProviderChange(provider: Provider) {
    setModelDropdownOpen(false);
    setForm((current) => ({ ...current, provider, model: "", baseUrl: "" }));
    setError(null);
    setMessage(null);
    setTestResult(null);
  }

  async function loadModelsFromProvider() {
    if (loadingModels) return;

    const requestedProvider = form.provider;
    const fetched = await load({
      provider: requestedProvider,
      apiKey: form.apiKey.trim() || undefined,
      baseUrl: form.baseUrl.trim() || undefined,
    });

    if (fetched && fetched.length) {
      setModelsRefreshedAt(new Date());
      setForm((current) => {
        if (current.provider !== requestedProvider) return current;
        return {
          ...current,
          model: fetched.some((model) => model.id === current.model) ? current.model : fetched[0].id,
        };
      });
    }
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
          cronExpression: form.autoUpdateCronExpression.trim() || INITIAL_FORM.autoUpdateCronExpression,
          projectScope: form.autoUpdateEnabled ? autoUpdateProject : null,
          workItemTypes: form.autoUpdateWorkItemTypes,
          states: form.autoUpdateStates,
        },
      },
    };
  }

  function toggleAutoUpdate(enabled: boolean) {
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

  function discard() {
    if (!savedBaseline) return;
    setForm(savedBaseline);
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
      setLastTested(new Date());
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

      const savedForm: FormState = { ...form, personalAccessToken: "", apiKey: "" };
      setForm(savedForm);
      setSavedBaseline(savedForm);
      setHasSavedAzurePat(Boolean(json?.azureDevOps?.hasPersonalAccessToken));
      setHasSavedLlmKey(Boolean(json?.llm?.hasApiKey));
      setSavedLlmProvider(json?.llm?.provider ?? savedForm.provider);
      if (json?.context?.autoUpdate?.latestRun) setLatestRun(json.context.autoUpdate.latestRun);
      setTestResult(null);

      onSaved?.();
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

  const saveDisabledReason = useMemo<string | null>(() => {
    if (!form.organizationUrl.trim()) return "Add your Azure DevOps organization URL.";
    if (!isValidOrganizationUrl(form.organizationUrl)) return "Enter a valid organization URL.";
    if (!hasSavedAzurePat && !form.personalAccessToken.trim()) return "Enter your Azure DevOps PAT.";
    if (!form.model.trim()) return "Select an AI model.";
    if (form.provider !== "ollama" && !canUseSavedLlmKey && !form.apiKey.trim()) {
      return "Enter your AI provider API token.";
    }
    if (form.autoUpdateEnabled) {
      if (!autoUpdateProject) return "Select an Azure DevOps project for the scheduled sync.";
      if (validateCronExpression(form.autoUpdateCronExpression)) return "Fix the sync schedule.";
      if (!form.autoUpdateWorkItemTypes.length) return "Select at least one work item type for the sync.";
      if (!form.autoUpdateStates.length) return "Select at least one state for the sync.";
    }
    return null;
  }, [form, hasSavedAzurePat, canUseSavedLlmKey, autoUpdateProject]);

  const azureStatus = deriveAzureStatus({
    organizationUrl: form.organizationUrl,
    personalAccessToken: form.personalAccessToken,
    hasSavedPat: hasSavedAzurePat,
    testResult: testResult?.azureDevOps,
  });
  const aiStatus = deriveAiStatus({
    provider: form.provider,
    model: form.model,
    apiKey: form.apiKey,
    canUseSavedLlmKey,
    testResult: testResult?.llm,
  });
  const syncStatus = deriveSyncStatus({
    enabled: form.autoUpdateEnabled,
    project: autoUpdateProject,
    workItemTypes: form.autoUpdateWorkItemTypes,
    states: form.autoUpdateStates,
    cronExpression: form.autoUpdateCronExpression,
    latestRun,
  });

  const feedback = (
    <>
      {error ? (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <XCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 p-3 text-sm text-success">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {message}
        </div>
      ) : null}
      {lastTested && !error ? (
        <p className="text-xs text-muted-foreground">
          Last tested at {lastTested.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.
        </p>
      ) : null}
    </>
  );

  const azureSection = (
    <AzureSection
      form={form}
      update={update}
      hasSavedPat={hasSavedAzurePat}
      onTest={testConnections}
      testing={testing}
      testResult={testResult?.azureDevOps}
    />
  );

  const aiSection = (
    <AiProviderSection
      form={form}
      update={update}
      canUseSavedLlmKey={canUseSavedLlmKey}
      onProviderChange={handleProviderChange}
      models={models}
      loadingModels={loadingModels}
      modelError={modelError}
      selectedModelLabel={selectedModelLabel}
      modelDropdownOpen={modelDropdownOpen}
      setModelDropdownOpen={setModelDropdownOpen}
      onRefreshModels={() => void loadModelsFromProvider()}
      onSelectModel={(modelId) => update("model", modelId)}
      modelsRefreshedAt={modelsRefreshedAt}
      onTest={testConnections}
      testing={testing}
      testResult={testResult?.llm}
    />
  );

  if (embedded) {
    return (
      <div className="space-y-6 text-foreground">
        <StatusSummary azure={azureStatus} ai={aiStatus} sync={syncStatus} />
        {feedback}

        <SectionCard
          title="Azure DevOps Connection"
          description="Connect iTestFlow to your Azure DevOps organization."
          action={<StatusBadge tone={azureStatus.tone} label={azureStatus.label} />}
        >
          {azureSection}
        </SectionCard>

        <SectionCard
          title="AI Provider Configuration"
          description="Choose your model provider, authenticate, and select a model."
          action={<StatusBadge tone={aiStatus.tone} label={aiStatus.label} />}
        >
          {aiSection}
        </SectionCard>

        <AdvancedLlmControls form={form} update={update} />

        <SectionCard
          title="Project Context Retrieval"
          description="Tune how much project context the AI retrieves for analysis and test design."
        >
          <ProjectContextSection form={form} update={update} />
        </SectionCard>

        <SectionCard
          title="Scheduled Knowledge Sync"
          description="Keep the project context and knowledge base up to date on a schedule."
          action={<StatusBadge tone={syncStatus.tone} label={syncStatus.label} />}
        >
          <ScheduledSyncSection
            form={form}
            update={update}
            onToggleEnabled={toggleAutoUpdate}
            scheduledProject={autoUpdateProject}
            workItemTypeOptions={workItemMetadata?.workItemTypes ?? []}
            stateOptions={workItemMetadata?.states ?? []}
            metadataLoading={workItemMetadataLoading}
            metadataError={workItemMetadataError}
            onRetryMetadata={retryWorkItemMetadata}
            latestRun={latestRun}
          />
        </SectionCard>

        <SaveActionBar
          visible={isDirty}
          saving={saving}
          testing={testing}
          saveDisabledReason={saveDisabledReason}
          onTest={testConnections}
          onDiscard={discard}
          onSave={saveAndContinue}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-[30px] text-foreground">
      <div className="grid min-h-[840px] gap-[120px] xl:grid-cols-[370px_minmax(0,1fr)]">
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
            {SETUP_CHECKLIST.map((item) => (
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

        <div className="flex items-center justify-center">
          <div className="w-full max-w-[600px] rounded-2xl border border-border bg-card text-foreground">
            <div className="p-12">
              <h1 className="text-3xl font-bold tracking-tight">Initial Configuration</h1>
              <p className="mt-2 text-sm text-muted-foreground">Set up your local connections to get started.</p>

              <div className="mt-8 space-y-5">
                <SectionCard
                  title="Azure DevOps Connection"
                  description="Connect iTestFlow to your Azure DevOps organization."
                >
                  {azureSection}
                </SectionCard>

                <SectionCard
                  title="AI Provider Configuration"
                  description="Choose your model provider, authenticate, and select a model."
                >
                  {aiSection}
                </SectionCard>

                {feedback}
                {saveDisabledReason ? (
                  <p className="text-xs leading-5 text-muted-foreground">{saveDisabledReason}</p>
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
                    disabled={testing || saving || Boolean(saveDisabledReason)}
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Continue
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
