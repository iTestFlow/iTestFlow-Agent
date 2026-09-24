"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { postJson } from "@/components/workflow/post-json";
import type { ActiveProjectScope } from "@/shared/lib/active-project";
import type { DraftConnection } from "../lib/execution-draft";
import { newDraftConnection } from "../lib/execution-draft";

const SECRET_FIELDS = {
  bearer: ["bearerToken"], basic: ["basicPassword"], apiKey: ["apiKey"],
  oauth2ClientCredentials: ["oauthClientSecret"], none: [],
} as const;

export function ConnectionsEditor({ scope, connections, onChange }: {
  scope: ActiveProjectScope | null;
  connections: DraftConnection[];
  onChange: (connections: DraftConnection[]) => void;
}) {
  const [checks, setChecks] = useState<Record<string, { busy?: boolean; text: string }>>({});

  function update(localId: string, patch: Partial<DraftConnection>) {
    onChange(connections.map((connection) => connection.localId === localId ? { ...connection, ...patch } as DraftConnection : connection));
    setChecks((current) => ({ ...current, [localId]: { text: "Connection changed. Test again." } }));
  }

  function credential(connection: DraftConnection, field: string, value: string) {
    const old = connection.credentials?.[field] ?? {};
    update(connection.localId, { credentials: { ...connection.credentials, [field]: value ? { value } : { ...old, value: undefined } } });
  }

  async function check(connection: DraftConnection) {
    if (!scope) return;
    const { localId, ...input } = connection;
    setChecks((current) => ({ ...current, [localId]: { busy: true, text: "Checking connection…" } }));
    try {
      const result = await postJson<{ connected: boolean; authenticated: boolean; message?: string }>(
        "/api/test-execution/playwright/connections/check", { scope, connection: input },
      );
      setChecks((current) => ({ ...current, [localId]: {
        text: `Connectivity: ${result.connected ? "passed" : "failed"}. Authentication: ${result.authenticated ? "passed" : "failed"}.${result.message ? ` ${result.message}` : ""}`,
      } }));
    } catch (error) {
      setChecks((current) => ({ ...current, [localId]: { text: error instanceof Error ? error.message : "Connection check failed." } }));
    }
  }

  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">Name each connection so steps can refer to it. Connections start read-only. Credentials are saved only with profiles or runs.</p>
    {connections.map((connection) => {
      const auth = connection.kind === "api" ? connection.auth.type : null;
      const secrets: readonly string[] = connection.kind === "database" ? ["url", "password"] : SECRET_FIELDS[auth ?? "none"];
      return <div key={connection.localId} className="space-y-3 rounded-lg border border-border p-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <div className="space-y-1"><Label htmlFor={`alias-${connection.localId}`}>Alias</Label><Input id={`alias-${connection.localId}`} value={connection.alias} placeholder="orders-api" onChange={(event) => update(connection.localId, { alias: event.target.value.toLowerCase() })} /></div>
          <div className="space-y-1"><Label htmlFor={`kind-${connection.localId}`}>Type</Label><NativeSelect id={`kind-${connection.localId}`} value={connection.kind} onChange={(event) => { const replacement = newDraftConnection(event.target.value as "api" | "database"); onChange(connections.map((entry) => entry.localId === connection.localId ? { ...replacement, localId: entry.localId, alias: entry.alias } : entry)); }}><option value="api">API</option><option value="database">Database</option></NativeSelect></div>
          <Button type="button" variant="outline" className="self-end" onClick={() => onChange(connections.filter((entry) => entry.localId !== connection.localId))}>Remove</Button>
        </div>
        {connection.kind === "api" ? <>
          <div className="space-y-1"><Label htmlFor={`api-url-${connection.localId}`}>API base URL</Label><Input id={`api-url-${connection.localId}`} type="url" value={connection.baseUrl} placeholder="https://api.example.com" onChange={(event) => update(connection.localId, { baseUrl: event.target.value })} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor={`auth-${connection.localId}`}>Authentication</Label><NativeSelect id={`auth-${connection.localId}`} value={auth ?? "none"} onChange={(event) => {
              const type = event.target.value;
              const next = type === "basic" ? { type, username: "" } : type === "apiKey" ? { type, name: "X-API-Key", in: "header" as const } : type === "oauth2ClientCredentials" ? { type, tokenUrl: "", clientId: "" } : type === "bearer" ? { type } : { type: "none" as const };
              update(connection.localId, { auth: next, credentials: {} } as Partial<DraftConnection>);
            }}><option value="none">None</option><option value="bearer">Bearer token</option><option value="basic">Basic</option><option value="apiKey">API key</option><option value="oauth2ClientCredentials">OAuth2 client credentials</option></NativeSelect></div>
            <div className="space-y-1"><Label htmlFor={`openapi-${connection.localId}`}>OpenAPI JSON URL (optional)</Label><Input id={`openapi-${connection.localId}`} type="url" value={connection.openApiUrl ?? ""} onChange={(event) => update(connection.localId, { openApiUrl: event.target.value })} /></div>
          </div>
          {connection.auth.type === "basic" ? <div className="space-y-1"><Label htmlFor={`username-${connection.localId}`}>Basic username</Label><Input id={`username-${connection.localId}`} value={connection.auth.username} onChange={(event) => update(connection.localId, { auth: { type: "basic", username: event.target.value } } as Partial<DraftConnection>)} /></div> : null}
          {connection.auth.type === "apiKey" ? <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor={`key-name-${connection.localId}`}>Key name</Label><Input id={`key-name-${connection.localId}`} value={connection.auth.name} onChange={(event) => update(connection.localId, { auth: { ...connection.auth, name: event.target.value } } as Partial<DraftConnection>)} /></div><div className="space-y-1"><Label htmlFor={`key-in-${connection.localId}`}>Send in</Label><NativeSelect id={`key-in-${connection.localId}`} value={connection.auth.in} onChange={(event) => update(connection.localId, { auth: { ...connection.auth, in: event.target.value as "header" | "query" } } as Partial<DraftConnection>)}><option value="header">Header</option><option value="query">Query</option></NativeSelect></div></div> : null}
          {connection.auth.type === "oauth2ClientCredentials" ? <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor={`token-url-${connection.localId}`}>Token URL</Label><Input id={`token-url-${connection.localId}`} type="url" value={connection.auth.tokenUrl} onChange={(event) => update(connection.localId, { auth: { ...connection.auth, tokenUrl: event.target.value } } as Partial<DraftConnection>)} /></div><div className="space-y-1"><Label htmlFor={`client-id-${connection.localId}`}>Client ID</Label><Input id={`client-id-${connection.localId}`} value={connection.auth.clientId} onChange={(event) => update(connection.localId, { auth: { ...connection.auth, clientId: event.target.value } } as Partial<DraftConnection>)} /></div></div> : null}
          <div className="space-y-1"><Label htmlFor={`timeout-${connection.localId}`}>Timeout (ms, optional)</Label><Input id={`timeout-${connection.localId}`} type="number" min={1000} max={120000} value={connection.timeoutMs ?? ""} onChange={(event) => update(connection.localId, { timeoutMs: event.target.value ? Number(event.target.value) : undefined })} /></div>
        </> : <>
          <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor={`engine-${connection.localId}`}>Engine</Label><NativeSelect id={`engine-${connection.localId}`} value={connection.engine} onChange={(event) => update(connection.localId, { engine: event.target.value as "postgres" | "sqlserver" | "mysql" })}><option value="postgres">PostgreSQL</option><option value="sqlserver">SQL Server</option><option value="mysql">MySQL</option></NativeSelect></div><div className="space-y-1"><Label htmlFor={`host-${connection.localId}`}>Host</Label><Input id={`host-${connection.localId}`} value={connection.host ?? ""} onChange={(event) => update(connection.localId, { host: event.target.value })} /></div></div>
          <div className="grid gap-3 sm:grid-cols-3"><div className="space-y-1"><Label htmlFor={`port-${connection.localId}`}>Port</Label><Input id={`port-${connection.localId}`} type="number" value={connection.port ?? ""} onChange={(event) => update(connection.localId, { port: event.target.value ? Number(event.target.value) : undefined })} /></div><div className="space-y-1"><Label htmlFor={`database-${connection.localId}`}>Database</Label><Input id={`database-${connection.localId}`} value={connection.database ?? ""} onChange={(event) => update(connection.localId, { database: event.target.value })} /></div><div className="space-y-1"><Label htmlFor={`db-user-${connection.localId}`}>Username</Label><Input id={`db-user-${connection.localId}`} value={connection.username ?? ""} onChange={(event) => update(connection.localId, { username: event.target.value })} /></div></div>
          <div className="space-y-1"><Label htmlFor={`tls-${connection.localId}`}>TLS</Label><NativeSelect id={`tls-${connection.localId}`} value={connection.tlsMode ?? "verify-full"} onChange={(event) => update(connection.localId, { tlsMode: event.target.value as "verify-full" | "require" | "disable" })}><option value="verify-full">Verify certificate</option><option value="require">Require TLS</option><option value="disable">Disable TLS</option></NativeSelect></div>
        </>}
        <div className="grid gap-3 sm:grid-cols-2">{secrets.map((field) => <div className="space-y-1" key={field}><Label htmlFor={`${field}-${connection.localId}`}>{field === "url" ? "Connection URL (optional)" : field.replace(/([A-Z])/g, " $1")}</Label><Input id={`${field}-${connection.localId}`} type="password" autoComplete="off" value={connection.credentials?.[field]?.value ?? ""} placeholder={connection.credentials?.[field]?.fromProfileId || connection.credentials?.[field]?.fromRunId ? "Saved credential — leave blank to reuse" : ""} onChange={(event) => credential(connection, field, event.target.value)} />{connection.credentials?.[field]?.fromProfileId || connection.credentials?.[field]?.fromRunId ? <Button type="button" size="xs" variant="ghost" onClick={() => { const credentials = { ...connection.credentials }; delete credentials[field]; update(connection.localId, { credentials }); }}>Remove saved credential</Button> : null}</div>)}</div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={connection.allowWrites} onChange={(event) => update(connection.localId, { allowWrites: event.target.checked })} /> Allow writes through this connection</label>
        <div className="flex items-center gap-3"><Button type="button" size="sm" variant="outline" disabled={!scope || checks[connection.localId]?.busy} onClick={() => void check(connection)}>Test connection</Button><span role="status" className="text-xs text-muted-foreground">{checks[connection.localId]?.text}</span></div>
      </div>;
    })}
    <div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={connections.length >= 20} onClick={() => onChange([...connections, newDraftConnection("api")])}>Add API</Button><Button type="button" size="sm" variant="outline" disabled={connections.length >= 20} onClick={() => onChange([...connections, newDraftConnection("database")])}>Add database</Button></div>
  </div>;
}
