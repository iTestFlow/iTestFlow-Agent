"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ChevronDown, Loader2, Pencil, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { patchJson, postJson } from "@/components/workflow/post-json";
import type { WorkspaceRole } from "@/modules/workspace/workspace-access.service";
import type { ActiveProjectScope } from "@/shared/lib/active-project";

import {
  capabilityDefinitionSummary,
  capabilityEditorTemplate,
  capabilityCompatibilityIssue,
  compatibleApprovedCapabilityIds,
  databaseDriverLabel,
  normalizeIntegrationOperation,
  parseJsonObject,
  type CapabilityEnvironment,
  type IntegrationOperationView,
} from "../lib/integration-capabilities";

type EditorState = {
  mode: "create" | "revise";
  operation: IntegrationOperationView | null;
  stableKey: string;
  displayName: string;
  layer: "api" | "db";
  safetyClass: "read" | "mutation";
  databaseDriver: "postgres" | "sqlserver" | "mysql";
  parameterSchema: string;
  definition: string;
};

export function IntegrationCapabilitiesPanel({
  scope,
  workspaceRole,
  environment,
  selectedIds,
  onSelectedIdsChange,
}: {
  scope: ActiveProjectScope;
  workspaceRole: WorkspaceRole | null;
  environment: CapabilityEnvironment;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const canManage = workspaceRole === "owner" || workspaceRole === "admin";
  const [expanded, setExpanded] = useState(false);
  const [operations, setOperations] = useState<IntegrationOperationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [pendingTransition, setPendingTransition] = useState<{
    operation: IntegrationOperationView;
    action: "approve" | "archive";
  } | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(scope)) {
      if (typeof value === "string" && value) params.set(key, value);
    }
    return params.toString();
  }, [scope]);

  const loadOperations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const loadVisibility = async (includeAll: boolean) => {
        const params = new URLSearchParams(query);
        params.set("includeAll", String(includeAll));
        const response = await fetch(`/api/test-execution/integration-operations?${params}`, { cache: "no-store" });
        const body = await response.json().catch(() => ({})) as { operations?: unknown[]; error?: string };
        if (!response.ok) throw new Error(body.error || `Capabilities could not be loaded (${response.status}).`);
        return body.operations ?? [];
      };
      // Managers need the current draft/archived successor for lifecycle work
      // and the last approved revision for run selection while a draft exists.
      const batches = await Promise.all(canManage
        ? [loadVisibility(true), loadVisibility(false)]
        : [loadVisibility(false)]);
      const unique = new Map<string, IntegrationOperationView>();
      for (const item of batches.flat().map(normalizeIntegrationOperation)) {
        if (item) unique.set(item.id, item);
      }
      setOperations([...unique.values()]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Capabilities could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [canManage, query]);

  useEffect(() => {
    setOperations([]);
    onSelectedIdsChange([]);
    void loadOperations();
    // Selection is least-privilege and project-scoped: changing project never
    // carries an approved operation revision into the next scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadOperations, scope.projectId]);

  const compatibleIds = useMemo(
    () => compatibleApprovedCapabilityIds(operations, environment),
    [environment, operations],
  );
  const compatibleKey = compatibleIds.join("\u0000");
  const compatibleIdSet = new Set(compatibleIds);
  useEffect(() => {
    const available = new Set(compatibleIds);
    const next = selectedIds.filter((id) => available.has(id));
    if (next.length !== selectedIds.length) onSelectedIdsChange(next);
    // `compatibleKey` keeps this effect stable when callers recreate the environment object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compatibleKey, scope.projectId]);

  const approved = operations.filter((operation) => operation.approvalStatus === "approved");
  const visibleOperations = canManage ? operations : approved;
  const latestRevisionByKey = new Map<string, number>();
  for (const operation of operations) {
    latestRevisionByKey.set(operation.stableKey, Math.max(latestRevisionByKey.get(operation.stableKey) ?? 0, operation.revision));
  }

  const toggleSelection = (id: string, checked: boolean) => {
    onSelectedIdsChange(
      checked ? [...new Set([...selectedIds, id])] : selectedIds.filter((selectedId) => selectedId !== id),
    );
  };

  const openEditor = (state: EditorState) => {
    setError(null);
    setEditor(state);
  };

  const submitEditor = async () => {
    if (!editor) return;
    const parameters = parseJsonObject(editor.parameterSchema, "Parameter schema");
    const definition = parseJsonObject(editor.definition, "Definition");
    if (!parameters.ok) return setError(parameters.error);
    if (!definition.ok) return setError(definition.error);
    if (!editor.displayName.trim()) return setError("Enter a display name.");
    if (editor.mode === "create" && !/^[a-z][a-z0-9_.-]{0,119}$/.test(editor.stableKey)) {
      return setError("Stable key must start with a lowercase letter and use lowercase letters, numbers, dots, dashes, or underscores.");
    }
    setSaving(true);
    setError(null);
    try {
      if (editor.mode === "create") {
        await postJson("/api/test-execution/integration-operations", {
          scope,
          operation: {
            stableKey: editor.stableKey,
            displayName: editor.displayName.trim(),
            layer: editor.layer,
            sourceKind: "manual",
            safetyClass: editor.safetyClass,
            databaseDriver: editor.layer === "db" ? editor.databaseDriver : null,
            apiContractRevisionId: null,
            parameterSchema: parameters.value,
            definition: definition.value,
          },
        });
        toast.success("Draft capability created.");
      } else if (editor.operation) {
        await patchJson(`/api/test-execution/integration-operations/${encodeURIComponent(editor.operation.id)}`, {
          scope,
          action: "revise",
          changes: {
            displayName: editor.displayName.trim(),
            safetyClass: editor.safetyClass,
            databaseDriver: editor.layer === "db" ? editor.databaseDriver : null,
            parameterSchema: parameters.value,
            definition: definition.value,
          },
        });
        toast.success("Draft revision created.");
      }
      setEditor(null);
      await loadOperations();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The capability could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const transition = async (operation: IntegrationOperationView, action: "approve" | "archive") => {
    setActionId(operation.id);
    setError(null);
    try {
      await patchJson(`/api/test-execution/integration-operations/${encodeURIComponent(operation.id)}`, {
        scope,
        action,
      });
      toast.success(action === "approve" ? "Capability approved." : "Capability archived.");
      await loadOperations();
    } catch (transitionError) {
      setError(transitionError instanceof Error ? transitionError.message : `The capability could not be ${action}d.`);
    } finally {
      setActionId(null);
      setPendingTransition(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" aria-hidden /> Integration capabilities</CardTitle>
            <CardDescription>
              Approved API operations and database statements the agent may call. Selection is frozen when the run is approved.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{selectedIds.length} selected</Badge>
            <Button type="button" variant="outline" size="sm" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded} aria-controls="integration-capabilities-content">
              {canManage ? "Manage" : "Choose"}
              <ChevronDown className={`ml-1 h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
            </Button>
          </div>
        </div>
      </CardHeader>
      {expanded ? (
        <CardContent id="integration-capabilities-content" className="space-y-3">
          {error ? (
            <Alert variant="destructive"><AlertTitle>Capability action failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Only approved operations compatible with the selected environment can be included in a run.
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void loadOperations()}>
                <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden /> Refresh
              </Button>
              {canManage ? (
                <Button type="button" size="sm" onClick={() => openEditor(emptyEditor())}>
                  <Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> New capability
                </Button>
              ) : null}
            </div>
          </div>

          {loading && operations.length === 0 ? (
            <div className="h-20 animate-pulse rounded-md bg-muted" aria-label="Loading integration capabilities" />
          ) : visibleOperations.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              No approved capabilities are available{canManage ? " — create a draft, review it, then approve it" : ". Ask a workspace owner or admin to add one"}.
            </p>
          ) : (
            <ul className="space-y-2">
              {visibleOperations.map((operation) => {
                const compatibilityIssue = capabilityCompatibilityIssue(operation, environment);
                const selectable = compatibleIdSet.has(operation.id);
                const isLatestRevision = operation.revision === latestRevisionByKey.get(operation.stableKey);
                const selectionIssue = compatibilityIssue ??
                  (operation.approvalStatus === "approved" && !selectable ? "A newer approved revision is available." : null);
                return (
                  <li key={operation.id} className="flex flex-wrap items-start gap-2 rounded-md border p-2.5">
                    <Checkbox
                      id={`capability-${operation.id}`}
                      checked={selectedIds.includes(operation.id)}
                      disabled={!selectable}
                      onCheckedChange={(checked) => toggleSelection(operation.id, checked === true)}
                      aria-describedby={selectionIssue ? `capability-${operation.id}-issue` : undefined}
                    />
                    <Label htmlFor={`capability-${operation.id}`} className="min-w-0 flex-1 cursor-pointer font-normal">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{operation.displayName || operation.stableKey}</span>
                        <Badge variant="outline" className="uppercase">{operation.layer}</Badge>
                        <Badge variant={operation.safetyClass === "mutation" ? "destructive" : "secondary"}>{operation.safetyClass}</Badge>
                        <Badge variant="outline">v{operation.revision}</Badge>
                        {canManage ? <Badge variant={operation.approvalStatus === "approved" ? "default" : "outline"}>{operation.approvalStatus}</Badge> : null}
                      </span>
                      <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{operation.stableKey}</span>
                      {operation.databaseDriver ? <span className="block text-xs text-muted-foreground">{databaseDriverLabel(operation.databaseDriver)}</span> : null}
                      <span className="block truncate font-mono text-xs text-muted-foreground">{capabilityDefinitionSummary(operation)}</span>
                      {selectionIssue ? <span id={`capability-${operation.id}-issue`} className="block text-xs text-muted-foreground">{selectionIssue}</span> : null}
                    </Label>
                    {canManage && isLatestRevision ? (
                      <div className="flex shrink-0 flex-wrap gap-1">
                        {operation.approvalStatus !== "archived" ? (
                          <Button type="button" variant="ghost" size="sm" disabled={actionId !== null} onClick={() => openEditor(editorFromOperation(operation))}>
                            <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden /> Revise
                          </Button>
                        ) : null}
                        {operation.approvalStatus === "draft" ? (
                          <Button type="button" variant="outline" size="sm" disabled={actionId !== null} onClick={() => setPendingTransition({ operation, action: "approve" })}>
                            {actionId === operation.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Approve
                          </Button>
                        ) : null}
                        {operation.approvalStatus !== "archived" ? (
                          <Button type="button" variant="ghost" size="sm" className="text-destructive" disabled={actionId !== null} onClick={() => setPendingTransition({ operation, action: "archive" })}>
                            <Archive className="mr-1 h-3.5 w-3.5" aria-hidden /> Archive
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      ) : null}

      <CapabilityEditorDialog editor={editor} saving={saving} error={error} onChange={setEditor} onSave={() => void submitEditor()} onClose={() => !saving && setEditor(null)} />
      <ConfirmationDialog
        open={pendingTransition !== null}
        onOpenChange={(open) => !open && actionId === null && setPendingTransition(null)}
        title={pendingTransition?.action === "approve" ? "Approve integration capability?" : "Archive integration capability?"}
        description={pendingTransition?.action === "approve"
          ? <>This creates an immutable approved successor for <strong>{pendingTransition.operation.displayName}</strong>. It can then be selected for new test runs.</>
          : <>This creates an immutable archived successor for <strong>{pendingTransition?.operation.displayName}</strong>. Existing approved runs keep their frozen revision.</>}
        confirmLabel={pendingTransition?.action === "approve" ? "Approve capability" : "Archive capability"}
        onConfirm={() => pendingTransition && void transition(pendingTransition.operation, pendingTransition.action)}
      />
    </Card>
  );
}

function CapabilityEditorDialog({
  editor,
  saving,
  error,
  onChange,
  onSave,
  onClose,
}: {
  editor: EditorState | null;
  saving: boolean;
  error: string | null;
  onChange: (state: EditorState | null) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  if (!editor) return null;
  const patch = (changes: Partial<EditorState>) => onChange({ ...editor, ...changes });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editor.mode === "create" ? "New integration capability" : `Revise ${editor.operation?.displayName}`}</DialogTitle>
          <DialogDescription>
            Saving creates a new immutable draft revision. Approval is always a separate human action.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="capability-stable-key">Stable key</Label>
            <Input id="capability-stable-key" value={editor.stableKey} disabled={editor.mode === "revise"} placeholder="orders.create" onChange={(event) => patch({ stableKey: sanitizeStableKey(event.target.value) })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="capability-display-name">Display name</Label>
            <Input id="capability-display-name" value={editor.displayName} maxLength={200} onChange={(event) => patch({ displayName: event.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="capability-layer">Layer</Label>
            <Select
              value={editor.layer}
              disabled={editor.mode === "revise"}
              onValueChange={(nextLayer) => {
                const layer = nextLayer as EditorState["layer"];
                const template = capabilityEditorTemplate(layer, editor.safetyClass);
                patch({
                  layer,
                  parameterSchema: prettyJson(template.parameterSchema),
                  definition: prettyJson(template.definition),
                });
              }}
            >
              <SelectTrigger id="capability-layer"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="api">API</SelectItem><SelectItem value="db">Database</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="capability-safety">Safety class</Label>
            <Select
              value={editor.safetyClass}
              onValueChange={(nextSafetyClass) => {
                const safetyClass = nextSafetyClass as EditorState["safetyClass"];
                const template = capabilityEditorTemplate(editor.layer, safetyClass);
                patch({
                  safetyClass,
                  parameterSchema: prettyJson(template.parameterSchema),
                  definition: prettyJson(template.definition),
                });
              }}
            >
              <SelectTrigger id="capability-safety"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="read">Read</SelectItem><SelectItem value="mutation">Mutation</SelectItem></SelectContent>
            </Select>
          </div>
          {editor.layer === "db" ? (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="capability-driver">Database driver</Label>
              <Select value={editor.databaseDriver} onValueChange={(databaseDriver) => patch({ databaseDriver: databaseDriver as EditorState["databaseDriver"] })}>
                <SelectTrigger id="capability-driver"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="postgres">PostgreSQL</SelectItem><SelectItem value="sqlserver">SQL Server</SelectItem><SelectItem value="mysql">MySQL</SelectItem></SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="capability-parameters">Parameter schema (JSON object)</Label>
            <Textarea
              id="capability-parameters"
              rows={7}
              className="font-mono text-xs"
              value={editor.parameterSchema}
              aria-describedby="capability-parameters-help"
              onChange={(event) => patch({ parameterSchema: event.target.value })}
            />
            <p id="capability-parameters-help" className="text-xs text-muted-foreground">
              JSON Schema object for the operation parameters. Keep additionalProperties false so the executor can reject unexpected input.
            </p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="capability-definition">Executor definition (JSON object)</Label>
            <Textarea
              id="capability-definition"
              rows={9}
              className="font-mono text-xs"
              value={editor.definition}
              aria-describedby="capability-definition-help"
              onChange={(event) => patch({ definition: event.target.value })}
            />
            <p id="capability-definition-help" className="text-xs text-muted-foreground">
              {editor.layer === "api"
                ? <>Define method, relative path, and optional query, headers, body, and contentType. Use <code>{"{name}"}</code> in the path and <code>{"{{param:name}}"}</code> in values.</>
                : <>Define one SQL statement and use named placeholders such as <code>:orderId</code>. Values are driver-bound, never interpolated.</>}
              {" "}Credentials and connection targets belong in the environment, never here.
            </p>
          </div>
        </div>
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={saving || !editor.displayName.trim() || !editor.stableKey} onClick={onSave}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null} Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function emptyEditor(): EditorState {
  const template = capabilityEditorTemplate("api", "read");
  return {
    mode: "create",
    operation: null,
    stableKey: "",
    displayName: "",
    layer: "api",
    safetyClass: "read",
    databaseDriver: "postgres",
    parameterSchema: prettyJson(template.parameterSchema),
    definition: prettyJson(template.definition),
  };
}

function editorFromOperation(operation: IntegrationOperationView): EditorState {
  return {
    mode: "revise",
    operation,
    stableKey: operation.stableKey,
    displayName: operation.displayName,
    layer: operation.layer,
    safetyClass: operation.safetyClass,
    databaseDriver: operation.databaseDriver ?? "postgres",
    parameterSchema: JSON.stringify(operation.parameterSchema, null, 2),
    definition: JSON.stringify(operation.definition, null, 2),
  };
}

function sanitizeStableKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, "").replace(/^[^a-z]+/, "").slice(0, 120);
}

function prettyJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}
