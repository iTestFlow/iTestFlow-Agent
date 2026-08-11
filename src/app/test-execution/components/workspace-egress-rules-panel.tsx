"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  Loader2,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { deleteJson, patchJson, postJson } from "@/components/workflow/post-json";
import type { WorkspaceRole } from "@/modules/workspace/workspace-access.service";
import type { ActiveProjectScope } from "@/shared/lib/active-project";

type EgressTargetKind = "api" | "database" | "oauth" | "openapi";
type EgressProtocol = "http" | "https" | "tcp";

type WorkspaceEgressRule = {
  id: string;
  name: string;
  targetKind: EgressTargetKind;
  protocol: EgressProtocol;
  hostPattern: string;
  portFrom: number;
  portTo: number;
  allowPrivateNetwork: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type RuleInput = Omit<WorkspaceEgressRule, "id" | "createdAt" | "updatedAt">;

type EditorState = RuleInput & {
  mode: "create" | "edit";
  ruleId: string | null;
};

const TARGET_LABELS: Record<EgressTargetKind, string> = {
  api: "API",
  database: "Database",
  oauth: "OAuth",
  openapi: "OpenAPI",
};

export function WorkspaceEgressRulesPanel({
  scope,
  workspaceRole,
}: {
  scope: ActiveProjectScope;
  workspaceRole: WorkspaceRole | null;
}) {
  const canManage = workspaceRole === "owner" || workspaceRole === "admin";
  const workspaceId = scope.workspaceId ?? "";
  const [expanded, setExpanded] = useState(false);
  const [rules, setRules] = useState<WorkspaceEgressRule[]>([]);
  const [loading, setLoading] = useState(canManage);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceEgressRule | null>(null);

  const loadRules = useCallback(async (signal?: AbortSignal) => {
    if (!canManage) return;
    setLoading(true);
    setError(null);
    if (!workspaceId) {
      setRules([]);
      setError("Select a workspace before managing network access rules.");
      setLoading(false);
      return;
    }
    try {
      const params = new URLSearchParams({ workspaceId });
      const response = await fetch(`/api/test-execution/egress-rules?${params}`, {
        cache: "no-store",
        signal,
      });
      const body = await response.json().catch(() => ({})) as {
        rules?: WorkspaceEgressRule[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `Network rules could not be loaded (${response.status}).`);
      setRules(Array.isArray(body.rules) ? body.rules : []);
    } catch (loadError) {
      if (signal?.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "Network rules could not be loaded.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [canManage, workspaceId]);

  useEffect(() => {
    setRules([]);
    setEditor(null);
    setEditorError(null);
    setPendingDelete(null);
    if (!canManage) {
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    void loadRules(controller.signal);
    return () => controller.abort();
  }, [canManage, loadRules]);

  if (!canManage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Network className="h-4 w-4" aria-hidden /> Network access policy
          </CardTitle>
          <CardDescription>
            Workspace rules control every API, database, OAuth, and OpenAPI connection made during test execution.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <ShieldAlert className="h-4 w-4" aria-hidden />
            <AlertTitle>Outbound connections are default-deny</AlertTitle>
            <AlertDescription>
              A matching enabled rule must allow the target host, protocol, and port. Ask a workspace owner or admin to review network access when a connection is blocked.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const enabledCount = rules.filter((rule) => rule.enabled).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Network className="h-4 w-4" aria-hidden /> Network access policy
            </CardTitle>
            <CardDescription>
              Default-deny allowlist for API, database, OAuth, and OpenAPI connections in this workspace.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{enabledCount} enabled</Badge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setExpanded((current) => !current)}
              aria-expanded={expanded}
              aria-controls="workspace-egress-rules-content"
            >
              Manage
              <ChevronDown className={`ml-1 h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
            </Button>
          </div>
        </div>
      </CardHeader>

      {expanded ? (
        <CardContent id="workspace-egress-rules-content" className="space-y-3">
          <Alert>
            <ShieldAlert className="h-4 w-4" aria-hidden />
            <AlertTitle>Only add destinations used by test environments</AlertTitle>
            <AlertDescription>
              Exact hosts are safest. Wildcards use a leading <code>*.</code>; CIDR ranges are supported. Private, loopback, and link-local targets also require “Allow private network.”
            </AlertDescription>
          </Alert>

          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Network policy action failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Rules are workspace-wide and apply at every outbound connection and redirect.
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void loadRules()}>
                <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden /> Refresh
              </Button>
              <Button type="button" size="sm" onClick={() => {
                setEditorError(null);
                setEditor(emptyEditor());
              }}>
                <Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> New rule
              </Button>
            </div>
          </div>

          {loading && rules.length === 0 ? (
            <div className="h-20 animate-pulse rounded-md bg-muted" aria-label="Loading network access rules" />
          ) : rules.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              No destinations are allowed. Add a narrowly scoped rule before running API or database tests.
            </p>
          ) : (
            <ul className="space-y-2" aria-label="Workspace network access rules">
              {rules.map((rule) => {
                const busy = busyRuleId === rule.id;
                return (
                  <li key={rule.id} className="flex flex-wrap items-start gap-3 rounded-md border p-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{rule.name}</span>
                        <Badge variant="outline">{TARGET_LABELS[rule.targetKind]}</Badge>
                        {rule.allowPrivateNetwork ? <Badge variant="destructive">Private network</Badge> : null}
                      </div>
                      <p className="break-all font-mono text-xs text-muted-foreground">
                        {rule.protocol}://{rule.hostPattern}:{formatPortRange(rule)}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={`Updating ${rule.name}`} /> : null}
                      <Switch
                        id={`egress-rule-enabled-${rule.id}`}
                        checked={rule.enabled}
                        disabled={busy}
                        onCheckedChange={(enabled) => void updateRule(rule, { enabled })}
                      />
                      <Label htmlFor={`egress-rule-enabled-${rule.id}`} className="text-xs font-normal">
                        {rule.enabled ? "Enabled" : "Disabled"}
                      </Label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        aria-label={`Edit ${rule.name}`}
                        onClick={() => {
                          setEditorError(null);
                          setEditor(editorFor(rule));
                        }}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-destructive"
                        disabled={busy}
                        aria-label={`Delete ${rule.name}`}
                        onClick={() => setPendingDelete(rule)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="sr-only" aria-live="polite">
            {loading ? "Loading network access rules." : `${rules.length} network access rules loaded.`}
          </p>
        </CardContent>
      ) : null}

      <Dialog open={Boolean(editor)} onOpenChange={(open) => {
        if (!open && !saving) {
          setEditor(null);
          setEditorError(null);
        }
      }}>
        {editor ? (
          <DialogContent className="sm:max-w-2xl">
            <form onSubmit={(event) => {
              event.preventDefault();
              void saveEditor();
            }}>
              <DialogHeader>
                <DialogTitle>{editor.mode === "create" ? "New network access rule" : `Edit ${editor.name}`}</DialogTitle>
                <DialogDescription>
                  Allow one target type to reach a bounded host and port range. Changes apply to subsequent outbound operations.
                </DialogDescription>
              </DialogHeader>

              {editorError ? (
                <Alert variant="destructive" role="alert" className="mt-4">
                  <AlertTitle>Rule could not be saved</AlertTitle>
                  <AlertDescription>{editorError}</AlertDescription>
                </Alert>
              ) : null}

              <div className="grid gap-4 py-4 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="egress-rule-name">Rule name</Label>
                  <Input
                    id="egress-rule-name"
                    value={editor.name}
                    maxLength={120}
                    autoFocus
                    placeholder="Staging orders API"
                    onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="egress-rule-target">Target type</Label>
                  <Select value={editor.targetKind} onValueChange={(targetKind) => {
                    setEditor(changeTargetKind(editor, targetKind as EgressTargetKind));
                  }}>
                    <SelectTrigger id="egress-rule-target"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="api">API requests</SelectItem>
                      <SelectItem value="database">Database connections</SelectItem>
                      <SelectItem value="oauth">OAuth token requests</SelectItem>
                      <SelectItem value="openapi">OpenAPI imports</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="egress-rule-protocol">Protocol</Label>
                  <Select value={editor.protocol} onValueChange={(protocol) => {
                    setEditor({ ...editor, protocol: protocol as EgressProtocol });
                  }}>
                    <SelectTrigger id="egress-rule-protocol"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {editor.targetKind === "database" ? (
                        <SelectItem value="tcp">TCP</SelectItem>
                      ) : (
                        <>
                          <SelectItem value="https">HTTPS</SelectItem>
                          <SelectItem value="http">HTTP</SelectItem>
                        </>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="egress-rule-host">Host pattern</Label>
                  <Input
                    id="egress-rule-host"
                    value={editor.hostPattern}
                    maxLength={255}
                    placeholder="api.staging.example.com"
                    aria-describedby="egress-rule-host-help"
                    onChange={(event) => setEditor({ ...editor, hostPattern: event.target.value })}
                  />
                  <p id="egress-rule-host-help" className="text-xs text-muted-foreground">
                    Host only—no URL scheme or path. Examples: <code>api.example.com</code>, <code>*.staging.example.com</code>, or <code>10.20.0.0/16</code>.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="egress-rule-port-from">Port from</Label>
                  <Input
                    id="egress-rule-port-from"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65_535}
                    value={editor.portFrom}
                    onChange={(event) => setEditor({ ...editor, portFrom: Number(event.target.value) })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="egress-rule-port-to">Port to</Label>
                  <Input
                    id="egress-rule-port-to"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65_535}
                    value={editor.portTo}
                    onChange={(event) => setEditor({ ...editor, portTo: Number(event.target.value) })}
                  />
                </div>

                <div className="flex items-start gap-3 rounded-md border p-3 sm:col-span-2">
                  <Switch
                    id="egress-rule-private"
                    checked={editor.allowPrivateNetwork}
                    onCheckedChange={(allowPrivateNetwork) => setEditor({ ...editor, allowPrivateNetwork })}
                  />
                  <div className="space-y-0.5">
                    <Label htmlFor="egress-rule-private">Allow private network</Label>
                    <p className="text-xs text-muted-foreground">
                      Required for private, loopback, or link-local resolutions. Enable only for intentional internal test systems.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3 sm:col-span-2">
                  <Switch
                    id="egress-rule-enabled-editor"
                    checked={editor.enabled}
                    onCheckedChange={(enabled) => setEditor({ ...editor, enabled })}
                  />
                  <Label htmlFor="egress-rule-enabled-editor">Enable this rule</Label>
                </div>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" disabled={saving} onClick={() => {
                  setEditor(null);
                  setEditorError(null);
                }}>Cancel</Button>
                <Button type="submit" disabled={saving}>
                  {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
                  {editor.mode === "create" ? "Create rule" : "Save changes"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>

      <ConfirmationDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete network access rule?"
        description={pendingDelete
          ? <>“{pendingDelete.name}” will stop authorizing new matching connections. In-flight operations are not changed.</>
          : "This rule will be deleted."}
        confirmLabel="Delete rule"
        onConfirm={() => {
          if (pendingDelete) void deleteRule(pendingDelete);
        }}
      />
    </Card>
  );

  async function saveEditor() {
    if (!editor) return;
    const issue = editorIssue(editor);
    if (issue) {
      setEditorError(issue);
      return;
    }
    setSaving(true);
    setEditorError(null);
    const rule = toRuleInput(editor);
    try {
      const body = editor.mode === "create"
        ? await postJson<{ rule: WorkspaceEgressRule }>("/api/test-execution/egress-rules", {
            workspaceId,
            rule,
          })
        : await patchJson<{ rule: WorkspaceEgressRule }>(
            `/api/test-execution/egress-rules/${encodeURIComponent(editor.ruleId ?? "")}`,
            { workspaceId, changes: rule },
          );
      setRules((current) => upsertRule(current, body.rule));
      setEditor(null);
      toast.success(editor.mode === "create" ? "Network access rule created." : "Network access rule updated.");
    } catch (saveError) {
      setEditorError(saveError instanceof Error ? saveError.message : "The network access rule could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function updateRule(rule: WorkspaceEgressRule, changes: Partial<RuleInput>) {
    setBusyRuleId(rule.id);
    setError(null);
    try {
      const body = await patchJson<{ rule: WorkspaceEgressRule }>(
        `/api/test-execution/egress-rules/${encodeURIComponent(rule.id)}`,
        { workspaceId, changes },
      );
      setRules((current) => upsertRule(current, body.rule));
      toast.success(body.rule.enabled ? "Network access rule enabled." : "Network access rule disabled.");
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "The network access rule could not be updated.");
    } finally {
      setBusyRuleId(null);
    }
  }

  async function deleteRule(rule: WorkspaceEgressRule) {
    setBusyRuleId(rule.id);
    setError(null);
    try {
      await deleteJson<{ deleted: boolean }>(
        `/api/test-execution/egress-rules/${encodeURIComponent(rule.id)}`,
        { workspaceId },
      );
      setRules((current) => current.filter((candidate) => candidate.id !== rule.id));
      toast.success("Network access rule deleted.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "The network access rule could not be deleted.");
    } finally {
      setBusyRuleId(null);
      setPendingDelete(null);
    }
  }
}

function emptyEditor(): EditorState {
  return {
    mode: "create",
    ruleId: null,
    name: "",
    targetKind: "api",
    protocol: "https",
    hostPattern: "",
    portFrom: 443,
    portTo: 443,
    allowPrivateNetwork: false,
    enabled: true,
  };
}

function editorFor(rule: WorkspaceEgressRule): EditorState {
  return { ...rule, mode: "edit", ruleId: rule.id };
}

function changeTargetKind(editor: EditorState, targetKind: EgressTargetKind): EditorState {
  if (targetKind === "database") {
    return { ...editor, targetKind, protocol: "tcp", portFrom: 5432, portTo: 5432 };
  }
  const protocol = editor.protocol === "tcp" ? "https" : editor.protocol;
  const resetPort = editor.targetKind === "database";
  return {
    ...editor,
    targetKind,
    protocol,
    portFrom: resetPort ? 443 : editor.portFrom,
    portTo: resetPort ? 443 : editor.portTo,
  };
}

function toRuleInput(editor: EditorState): RuleInput {
  return {
    name: editor.name.trim(),
    targetKind: editor.targetKind,
    protocol: editor.protocol,
    hostPattern: editor.hostPattern.trim(),
    portFrom: editor.portFrom,
    portTo: editor.portTo,
    allowPrivateNetwork: editor.allowPrivateNetwork,
    enabled: editor.enabled,
  };
}

function editorIssue(editor: EditorState): string | null {
  if (!editor.name.trim()) return "Enter a rule name.";
  const host = editor.hostPattern.trim();
  if (!host) return "Enter a host pattern.";
  if (host.includes("://") || /[\s?#@]/.test(host)) {
    return "Enter a host, wildcard hostname, IP address, or CIDR range without a URL scheme or path.";
  }
  if (!Number.isInteger(editor.portFrom) || editor.portFrom < 1 || editor.portFrom > 65_535) {
    return "Port from must be a whole number from 1 to 65535.";
  }
  if (!Number.isInteger(editor.portTo) || editor.portTo < 1 || editor.portTo > 65_535) {
    return "Port to must be a whole number from 1 to 65535.";
  }
  if (editor.portTo < editor.portFrom) return "Port to must be greater than or equal to port from.";
  if (editor.targetKind === "database" && editor.protocol !== "tcp") return "Database rules must use TCP.";
  if (editor.targetKind !== "database" && editor.protocol === "tcp") {
    return "API, OAuth, and OpenAPI rules must use HTTP or HTTPS.";
  }
  return null;
}

function formatPortRange(rule: Pick<WorkspaceEgressRule, "portFrom" | "portTo">): string {
  return rule.portFrom === rule.portTo ? String(rule.portFrom) : `${rule.portFrom}-${rule.portTo}`;
}

function upsertRule(rules: WorkspaceEgressRule[], saved: WorkspaceEgressRule): WorkspaceEgressRule[] {
  const next = rules.some((rule) => rule.id === saved.id)
    ? rules.map((rule) => rule.id === saved.id ? saved : rule)
    : [...rules, saved];
  return next.sort((left, right) => Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name));
}
