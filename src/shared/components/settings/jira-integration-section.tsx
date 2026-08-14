"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Callout } from "@/components/qa/callout";
import { apiErrorMessage } from "@/shared/lib/api-error-message";
import { Field, SectionCard, StatusBadge } from "./section-card";

type Pair = { localField: string; jiraField: string };
type StatusPair = { localStatus: string; jiraStatus: string };
type JiraProject = {
  id: string; providerProjectId: string; key: string; name: string;
  backend: { type: "plain_jira" | "xray_cloud" | "zephyr_scale"; status: string; region: string | null } | null;
  sync: { direction: "jira_to_itestflow" | "itestflow_to_jira" | "two_way"; fieldMappings: Pair[]; statusMappings: StatusPair[] } | null;
};
type Overview = {
  providerId: "jira-cloud"; role: "owner" | "admin" | "member";
  workspace: { id: string; name: string; siteName: string; siteUrl: string };
  connection: { status: string };
  availableProjects: Array<{ id: string; key?: string; name: string }>;
  projects: JiraProject[];
  mappings: Array<{ id: string; projectId: string; jiraIssueKey: string; localEntityType: string; localEntityId: string; direction: string; status: string; lastSyncedAt: string | null; updatedAt: string }>;
  conflicts: Array<{ mappingId: string; projectId: string; field: string; localValue: unknown; remoteValue: unknown; updatedAt: string }>;
  traceLinks: Array<{ id: string; projectId: string; localArtifactType: string; localArtifactId: string; remoteArtifactId: string | null; remoteUrl: string | null; backendType: string; status: string; updatedAt: string }>;
};

export function JiraIntegrationSection() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selectedProject, setSelectedProject] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/integrations/jira", { cache: "no-store" });
      const data = await response.json().catch(() => null) as Overview | { error?: string } | null;
      if (!response.ok) throw new Error(apiErrorMessage(data, "Could not load Jira Cloud settings."));
      setOverview(data as Overview);
      setSelectedProject((current) => current || (data as Overview).availableProjects[0]?.id || "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load Jira Cloud settings.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function mutate(label: string, body?: Record<string, unknown>, method = "POST") {
    setBusy(label);
    try {
      const response = await fetch("/api/integrations/jira", {
        method, headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(apiErrorMessage(data, "Jira Cloud settings could not be updated."));
      toast.success(label);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Jira Cloud settings could not be updated.");
    } finally { setBusy(""); }
  }

  if (loading && !overview) return <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />Loading Jira Cloud settings…</div>;
  if (error && !overview) return <Callout tone="error" role="alert" title="Jira Cloud settings unavailable" action={<Button type="button" variant="outline" onClick={() => void load()}>Retry</Button>}>{error}</Callout>;
  if (!overview) return null;
  const canConfigure = overview.role === "owner" || overview.role === "admin";
  const connected = overview.connection.status === "active";

  return <div className="space-y-4">
    <SectionCard
      title="Jira Cloud Connection"
      description="OAuth credentials are encrypted per user. Shared project, mapping, and artifact settings are restricted to workspace owners and admins."
      action={<StatusBadge tone={connected ? "success" : "warning"} label={connected ? "Connected" : "Reconnect required"} />}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div><div className="text-xs text-muted-foreground">Site</div><div className="font-medium">{overview.workspace.siteName}</div></div>
        <div><div className="text-xs text-muted-foreground">Workspace role</div><div className="font-medium capitalize">{overview.role}</div></div>
      </div>
      <a className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={overview.workspace.siteUrl} target="_blank" rel="noreferrer">Open Jira site <ExternalLink className="size-3.5" aria-hidden="true" /></a>
      {!connected ? <Button asChild><a href="/api/auth/jira/start?returnTo=%2Fsettings">Reconnect Jira Cloud</a></Button> : null}
      {confirmDisconnect ? (
        <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
          <span className="text-sm text-destructive">Disconnect this Jira account? Shared history remains.</span>
          <Button type="button" variant="destructive" aria-label="Confirm Jira Cloud disconnect" disabled={Boolean(busy)} onClick={() => void mutate("Jira Cloud disconnected.", undefined, "DELETE")}>Confirm disconnect</Button>
          <Button type="button" variant="outline" onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
        </div>
      ) : <Button type="button" variant="outline" aria-label="Disconnect Jira Cloud" onClick={() => setConfirmDisconnect(true)}>Disconnect Jira Cloud</Button>}
    </SectionCard>

    {connected && canConfigure ? <SectionCard title="Jira Projects" description="Only projects visible to the connected Jira account can be added.">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label="Available Jira project" htmlFor="jira-project" description="Project access is rechecked by Jira before it is stored.">
          <select id="jira-project" aria-label="Available Jira project" className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)}>
            {overview.availableProjects.length === 0 ? <option value="">No Jira projects available</option> : null}
            {overview.availableProjects.map((project) => <option key={project.id} value={project.id}>{project.key ? `${project.key} — ` : ""}{project.name}</option>)}
          </select>
        </Field>
        <Button type="button" disabled={!selectedProject || Boolean(busy)} onClick={() => void mutate("Jira project added.", { action: "select_project", providerProjectId: selectedProject })}>Add Jira project</Button>
      </div>
    </SectionCard> : null}

    {overview.projects.map((project) => <div key={project.id} className="space-y-4">
      <SectionCard title={`${project.key} — ${project.name}`} description="Project-scoped synchronization and artifact publishing settings." action={<StatusBadge tone="success" label="Mapped" />}>
        {canConfigure ? <div className="grid gap-4 xl:grid-cols-2"><SyncConfigForm project={project} busy={Boolean(busy)} onSave={(body) => mutate("Jira synchronization mapping saved.", body)} /><BackendConfigForm project={project} busy={Boolean(busy)} onSave={(body) => mutate("Jira artifact backend saved.", body)} /></div> : <Callout tone="info" title="Read-only settings">Only workspace owners and admins can change shared Jira mappings and artifact backends.</Callout>}
      </SectionCard>
    </div>)}

    <SectionCard title="Synchronization Status" description="Latest Jira issue mappings and their most recent convergence state.">
      <div role="status" aria-live="polite" className="space-y-2">
        {overview.mappings.length === 0 ? <p className="text-sm text-muted-foreground">No Jira synchronization history yet.</p> : overview.mappings.map((mapping) => <div key={mapping.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"><span><strong>{mapping.jiraIssueKey}</strong> ↔ {mapping.localEntityType} {mapping.localEntityId}</span><StatusBadge tone={mapping.status === "error" || mapping.status === "conflict" ? "warning" : "success"} label={mapping.status} /></div>)}
      </div>
    </SectionCard>

    <SectionCard title="Field Conflicts" description="Choose the authoritative value. The losing side is updated through the durable sync queue.">
      {overview.conflicts.length === 0 ? <p className="text-sm text-muted-foreground">No unresolved conflicts.</p> : overview.conflicts.map((conflict) => <div key={`${conflict.mappingId}:${conflict.field}`} className="space-y-2 rounded-lg border p-3"><div className="font-medium">{conflict.field}</div><div className="grid gap-2 text-sm sm:grid-cols-2"><div><span className="text-muted-foreground">iTestFlow:</span> {displayValue(conflict.localValue)}</div><div><span className="text-muted-foreground">Jira:</span> {displayValue(conflict.remoteValue)}</div></div><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" aria-label={`Use iTestFlow value for ${conflict.field}`} disabled={Boolean(busy)} onClick={() => void mutate("Conflict resolution queued.", { action: "resolve_conflict", mappingId: conflict.mappingId, field: conflict.field, resolution: "use_local" })}>Use iTestFlow</Button><Button type="button" variant="outline" aria-label={`Use Jira value for ${conflict.field}`} disabled={Boolean(busy)} onClick={() => void mutate("Conflict resolution queued.", { action: "resolve_conflict", mappingId: conflict.mappingId, field: conflict.field, resolution: "use_remote" })}>Use Jira</Button></div></div>)}
    </SectionCard>

    <SectionCard title="Traceability Links" description="Stable links between local artifacts and their Jira, Xray, or Zephyr identities.">
      {overview.traceLinks.length === 0 ? <p className="text-sm text-muted-foreground">No published traceability links yet.</p> : <ul className="space-y-2">{overview.traceLinks.map((link) => <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"><span>{link.localArtifactType} {link.localArtifactId}</span>{link.remoteUrl && link.remoteArtifactId ? <a href={link.remoteUrl} target="_blank" rel="noreferrer" aria-label={`Open ${link.remoteArtifactId} in Jira`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{link.remoteArtifactId}<ExternalLink className="size-3.5" aria-hidden="true" /></a> : <StatusBadge tone="warning" label={link.status} />}</li>)}</ul>}
    </SectionCard>
  </div>;
}

function SyncConfigForm({ project, busy, onSave }: { project: JiraProject; busy: boolean; onSave(body: Record<string, unknown>): void }) {
  const [direction, setDirection] = useState(project.sync?.direction ?? "two_way");
  const [fields, setFields] = useState(formatPairs(project.sync?.fieldMappings ?? [{ localField: "title", jiraField: "summary" }], "localField", "jiraField"));
  const [statuses, setStatuses] = useState(formatPairs(project.sync?.statusMappings ?? [{ localStatus: "approved", jiraStatus: "Done" }], "localStatus", "jiraStatus"));
  return <fieldset className="space-y-3 rounded-lg border p-3"><legend className="px-1 font-medium">Field and status mapping</legend>
    <div><Label htmlFor={`direction-${project.id}`}>Synchronization direction</Label><select id={`direction-${project.id}`} className="mt-2 h-9 w-full rounded-lg border bg-background px-3 text-sm" value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)}><option value="two_way">Two-way</option><option value="jira_to_itestflow">Jira to iTestFlow</option><option value="itestflow_to_jira">iTestFlow to Jira</option></select></div>
    <div><Label htmlFor={`fields-${project.id}`}>Field mappings</Label><Textarea id={`fields-${project.id}`} value={fields} onChange={(event) => setFields(event.target.value)} aria-describedby={`fields-help-${project.id}`} /><p id={`fields-help-${project.id}`} className="mt-1 text-xs text-muted-foreground">One mapping per line: iTestFlow field = Jira field.</p></div>
    <div><Label htmlFor={`statuses-${project.id}`}>Status mappings</Label><Textarea id={`statuses-${project.id}`} value={statuses} onChange={(event) => setStatuses(event.target.value)} aria-describedby={`statuses-help-${project.id}`} /><p id={`statuses-help-${project.id}`} className="mt-1 text-xs text-muted-foreground">One mapping per line: iTestFlow status = Jira status.</p></div>
    <Button type="button" disabled={busy} onClick={() => {
      const fieldMappings = parsePairs(fields, "localField", "jiraField"); const statusMappings = parsePairs(statuses, "localStatus", "jiraStatus");
      if (!fieldMappings.length || !statusMappings.length) { toast.error("Enter at least one valid field and status mapping."); return; }
      onSave({ action: "configure_sync", projectId: project.id, direction, fieldMappings, statusMappings });
    }}>Save synchronization mapping</Button>
  </fieldset>;
}

function BackendConfigForm({ project, busy, onSave }: { project: JiraProject; busy: boolean; onSave(body: Record<string, unknown>): void }) {
  const [type, setType] = useState(project.backend?.type ?? "plain_jira");
  const [first, setFirst] = useState(""); const [secret, setSecret] = useState(""); const [field, setField] = useState(""); const [region, setRegion] = useState("us");
  return <fieldset className="space-y-3 rounded-lg border p-3"><legend className="px-1 font-medium">Artifact backend</legend>
    <div><Label htmlFor={`backend-${project.id}`}>Artifact backend</Label><select id={`backend-${project.id}`} className="mt-2 h-9 w-full rounded-lg border bg-background px-3 text-sm" value={type} onChange={(event) => { setType(event.target.value as typeof type); setFirst(""); setSecret(""); setField(""); }}><option value="plain_jira">Plain Jira</option><option value="xray_cloud">Xray Cloud</option><option value="zephyr_scale">Zephyr Scale Cloud</option></select></div>
    {type === "plain_jira" ? <><LabeledInput id={`issue-type-${project.id}`} label="Jira Test Case issue type ID" value={first} onChange={setFirst} /><LabeledInput id={`local-field-${project.id}`} label="Immutable local ID custom field" value={field} onChange={setField} placeholder="customfield_10001" /></> : null}
    {type === "xray_cloud" ? <><LabeledInput id={`xray-client-${project.id}`} label="Xray client ID" value={first} onChange={setFirst} /><LabeledInput id={`xray-secret-${project.id}`} label="Xray client secret" value={secret} onChange={setSecret} secret /><LabeledInput id={`xray-field-${project.id}`} label="Immutable local ID custom field" value={field} onChange={setField} placeholder="customfield_10001" /></> : null}
    {type === "zephyr_scale" ? <><LabeledInput id={`zephyr-token-${project.id}`} label="Zephyr Scale API token" value={secret} onChange={setSecret} secret /><div><Label htmlFor={`zephyr-region-${project.id}`}>Zephyr Scale region</Label><select id={`zephyr-region-${project.id}`} className="mt-2 h-9 w-full rounded-lg border bg-background px-3 text-sm" value={region} onChange={(event) => setRegion(event.target.value)}><option value="us">United States</option><option value="eu">Europe</option><option value="au">Australia</option><option value="de">Germany</option></select></div><LabeledInput id={`zephyr-field-${project.id}`} label="Immutable local ID field name" value={field} onChange={setField} /></> : null}
    <Button type="button" disabled={busy} onClick={() => {
      if (type === "plain_jira") onSave({ action: "configure_backend", projectId: project.id, backendType: type, testCaseIssueTypeId: first, localIdFieldId: field });
      if (type === "xray_cloud") onSave({ action: "configure_backend", projectId: project.id, backendType: type, clientId: first, clientSecret: secret, localIdFieldId: field });
      if (type === "zephyr_scale") onSave({ action: "configure_backend", projectId: project.id, backendType: type, apiToken: secret, region, localIdFieldName: field });
    }}>Save artifact backend</Button>
  </fieldset>;
}

function LabeledInput({ id, label, value, onChange, placeholder, secret = false }: { id: string; label: string; value: string; onChange(value: string): void; placeholder?: string; secret?: boolean }) {
  return <div><Label htmlFor={id}>{label}</Label><Input id={id} className="mt-2" type={secret ? "password" : "text"} autoComplete="off" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></div>;
}
function parsePairs<L extends string, R extends string>(value: string, left: L, right: R): Array<Record<L | R, string>> { return value.split("\n").map((line) => line.split("=")).filter((parts) => parts.length === 2 && parts[0].trim() && parts[1].trim()).map(([a, b]) => ({ [left]: a.trim(), [right]: b.trim() } as Record<L | R, string>)); }
function formatPairs<T extends Record<L | R, string>, L extends string, R extends string>(values: T[], left: L, right: R) { return values.map((value) => `${value[left]} = ${value[right]}`).join("\n"); }
function displayValue(value: unknown) { return typeof value === "string" ? value : JSON.stringify(value); }
