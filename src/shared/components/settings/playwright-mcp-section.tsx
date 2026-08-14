"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { Field, SecretField, SectionCard, StatusBadge } from "./section-card"

type Config = { status: "not_configured" | "configured" | "disabled"; transport: "http" | "stdio" | null; endpoint: string | null; artifactBaseUrl: string | null }

export function PlaywrightMcpSection() {
  const [visible, setVisible] = useState(false)
  const [saving, setSaving] = useState(false)
  const [config, setConfig] = useState<Config | null>(null)
  const [transport, setTransport] = useState<"http" | "stdio">("http")
  const [endpoint, setEndpoint] = useState("")
  const [artifactBaseUrl, setArtifactBaseUrl] = useState("")
  const [bearerToken, setBearerToken] = useState("")

  useEffect(() => {
    void fetch("/api/workspace/playwright-mcp", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return
      const data = await response.json() as { config: Config }
      setVisible(true); setConfig(data.config)
      setTransport(data.config.transport ?? "http"); setEndpoint(data.config.endpoint ?? ""); setArtifactBaseUrl(data.config.artifactBaseUrl ?? "")
    })
  }, [])
  if (!visible) return null

  async function save() {
    setSaving(true)
    try {
      const body = transport === "http" ? {
        transport, endpoint: endpoint.trim(), artifactBaseUrl: artifactBaseUrl.trim() || null,
        ...(bearerToken.trim() ? { bearerToken: bearerToken.trim() } : {}), enabled: true,
      } : { transport, enabled: true }
      const response = await fetch("/api/workspace/playwright-mcp", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      const data = await response.json() as { config?: Config; error?: string }
      if (!response.ok || !data.config) throw new Error(data.error ?? "Could not save Playwright MCP configuration.")
      setConfig(data.config); setBearerToken(""); toast.success("Playwright MCP configuration saved.")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not save Playwright MCP configuration.") }
    finally { setSaving(false) }
  }

  return <SectionCard title="Playwright MCP" description="Workspace owners and admins configure the browser transport. Members can run approved Test Plan steps but cannot change this connection. Stdio commands come only from deployment environment variables." action={<StatusBadge tone={config?.status === "configured" ? "success" : "muted"} label={config?.status === "configured" ? "Configured" : "Not configured"} />}>
    <Field label="Transport" htmlFor="playwright-transport"><NativeSelect id="playwright-transport" value={transport} onChange={(event) => setTransport(event.target.value as "http" | "stdio")}><option value="http">Streamable HTTP</option><option value="stdio">Stdio (deployment-managed)</option></NativeSelect></Field>
    {transport === "http" && <>
      <Field label="MCP endpoint" htmlFor="playwright-endpoint" description="HTTPS is required except for localhost."><Input id="playwright-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://mcp.example.com/mcp" /></Field>
      <Field label="Artifact base URL" htmlFor="playwright-artifacts" description="Optional protected base URL used to import trace artifacts."><Input id="playwright-artifacts" value={artifactBaseUrl} onChange={(event) => setArtifactBaseUrl(event.target.value)} placeholder="https://mcp.example.com/artifacts/" /></Field>
      <SecretField id="playwright-token" label="Bearer token" value={bearerToken} onChange={setBearerToken} placeholder="Leave empty to keep saved token" hasSaved={config?.status === "configured"} description="Encrypted server-side and never returned to the browser." />
    </>}
    <Button type="button" disabled={saving || (transport === "http" && !endpoint.trim())} onClick={() => void save()}>{saving && <Loader2 className="size-4 animate-spin" />}Save Playwright MCP</Button>
  </SectionCard>
}
