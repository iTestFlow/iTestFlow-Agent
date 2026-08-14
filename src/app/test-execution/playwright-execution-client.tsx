"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, Play, RefreshCw, Send, Square } from "lucide-react"
import { toast } from "sonner"
import { postJson } from "@/components/workflow/post-json"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { NativeSelect } from "@/components/ui/native-select"
import { Badge } from "@/components/ui/badge"
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project"

type Option = { id: string; name: string; path?: string }
type Run = { id: string; status: string; totalCases: number; completedCases: number; createdAt: string; errorMessage?: string | null; cases?: Array<{ id: string; title: string; status: string; errorMessage?: string | null; steps: Array<{ id: string; index: number; action: string; expectedResult?: string | null; status: string; errorMessage?: string | null }> }>; artifacts?: Array<{ id: string; kind: string; byteSize: number }> }

export function PlaywrightExecutionClient() {
  const [scope, setScope] = useState<ActiveProjectScope | null>(null)
  const [plans, setPlans] = useState<Option[]>([]); const [planId, setPlanId] = useState("")
  const [suites, setSuites] = useState<Option[]>([]); const [suiteId, setSuiteId] = useState("")
  const [runs, setRuns] = useState<Run[]>([]); const [activeRun, setActiveRun] = useState<Run | null>(null)
  const [reviewedRun, setReviewedRun] = useState<Run | null>(null)
  const [busy, setBusy] = useState(false)
  const activeRunId = activeRun?.id

  const loadHistory = useCallback(async (selectedScope: ActiveProjectScope) => {
    const data = await postJson<{ runs: Run[] }>("/api/test-execution/playwright/history", { scope: selectedScope })
    setRuns(data.runs); const live = data.runs.find((run) => run.status === "queued" || run.status === "running"); setActiveRun(live ?? null)
  }, [])

  useEffect(() => {
    const selected = readActiveProject(); setScope(selected)
    if (!selected) return
    void postJson<{ testPlans: Option[] }>("/api/azure-devops/test-plans", { scope: selected }).then((data) => { setPlans(data.testPlans); setPlanId(data.testPlans[0]?.id ?? "") }).catch((error) => toast.error(error.message))
    void loadHistory(selected).catch(() => undefined)
  }, [loadHistory])

  useEffect(() => {
    if (!scope || !planId) { setSuites([]); return }
    void postJson<{ testSuites: Option[] }>("/api/azure-devops/test-suites", { scope, testPlanId: planId }).then((data) => { setSuites(data.testSuites); setSuiteId(data.testSuites[0]?.id ?? "") }).catch((error) => toast.error(error.message))
  }, [scope, planId])

  useEffect(() => {
    if (!scope || !activeRunId) return
    const timer = window.setInterval(() => {
      void postJson<{ run: Run }>(`/api/test-execution/playwright/runs/${activeRunId}`, { scope }).then((data) => {
        setActiveRun(["queued", "running"].includes(data.run.status) ? data.run : null)
        setRuns((current) => [data.run, ...current.filter((run) => run.id !== data.run.id)])
      }).catch(() => undefined)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [scope, activeRunId])

  async function start() {
    if (!scope || !planId || !suiteId) return
    setBusy(true)
    try {
      const queued = await postJson<{ runId: string }>("/api/test-execution/playwright/runs", { scope, testPlanId: Number(planId), testSuiteId: Number(suiteId) })
      const run: Run = { id: queued.runId, status: "queued", totalCases: 0, completedCases: 0, createdAt: new Date().toISOString() }
      setActiveRun(run); setRuns((current) => [run, ...current]); toast.success("Execution queued.")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Execution could not be queued.") } finally { setBusy(false) }
  }

  async function cancel() { if (!scope || !activeRun) return; await postJson(`/api/test-execution/playwright/runs/${activeRun.id}/cancel`, { scope }); toast.success("Cancellation requested.") }
  async function publish(runId: string, retryFailed = false) {
    if (!scope) return
    try { const result = await postJson<{ published: number; total: number }>(`/api/test-execution/playwright/runs/${runId}/publish`, { scope, confirmedReviewed: true, retryFailed }); toast.success(`Published ${result.published} of ${result.total} outcomes.`) }
    catch (error) { toast.error(error instanceof Error ? error.message : "Results could not be published.") }
  }
  async function review(runId: string) { if (!scope) return; const data = await postJson<{ run: Run }>(`/api/test-execution/playwright/runs/${runId}`, { scope }); setReviewedRun(data.run) }
  function artifactHref(artifactId: string) { const query = new URLSearchParams(Object.entries(scope ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")); return `/api/test-execution/playwright/artifacts/${artifactId}?${query}` }

  return <div className="space-y-4">
    <Card><CardHeader><CardTitle>Run Test Suite</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
      <label className="space-y-2 text-sm font-medium">Test Plan<NativeSelect value={planId} onChange={(event) => setPlanId(event.target.value)}>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</NativeSelect></label>
      <label className="space-y-2 text-sm font-medium">Test Suite<NativeSelect value={suiteId} onChange={(event) => setSuiteId(event.target.value)}>{suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.path ?? suite.name}</option>)}</NativeSelect></label>
      <div className="flex gap-2 md:col-span-2"><Button onClick={() => void start()} disabled={busy || !scope || !suiteId || Boolean(activeRun)}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}Run with Playwright MCP</Button>{activeRun && <Button variant="destructive" onClick={() => void cancel()}><Square className="size-4" />Cancel</Button>}<Button variant="outline" onClick={() => scope && void loadHistory(scope)}><RefreshCw className="size-4" />Refresh</Button></div>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Execution History</CardTitle></CardHeader><CardContent className="space-y-3">
      {!runs.length && <p className="text-sm text-muted-foreground">No Playwright MCP executions yet.</p>}
      {runs.map((run) => <div key={run.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div><div className="flex items-center gap-2"><span className="font-mono text-xs">{run.id}</span><Badge variant="outline">{run.status}</Badge></div><p className="text-sm text-muted-foreground">{run.completedCases}/{run.totalCases} cases · {new Date(run.createdAt).toLocaleString()}</p>{run.errorMessage && <p className="text-sm text-destructive">{run.errorMessage}</p>}</div>{!["queued", "running"].includes(run.status) && <Button variant="outline" onClick={() => void review(run.id)}>Review results</Button>}</div>)}
    </CardContent></Card>
    {reviewedRun && <Card><CardHeader><CardTitle>Review {reviewedRun.id}</CardTitle></CardHeader><CardContent className="space-y-3">
      {reviewedRun.cases?.map((testCase) => <div key={testCase.id} className="rounded-lg border p-3"><div className="flex items-center justify-between"><span className="font-medium">{testCase.title}</span><Badge variant="outline">{testCase.status}</Badge></div><div className="mt-2 space-y-2">{testCase.steps.map((step) => <div key={step.id} className="rounded bg-muted/40 p-2 text-sm"><div className="flex justify-between gap-3"><span>{step.index + 1}. {step.action}</span><span>{step.status}</span></div>{step.expectedResult && <p className="text-muted-foreground">Expected: {step.expectedResult}</p>}{step.errorMessage && <p className="text-destructive">{step.errorMessage}</p>}</div>)}</div></div>)}
      {Boolean(reviewedRun.artifacts?.length) && <div><p className="mb-2 text-sm font-medium">Artifacts</p><div className="flex flex-wrap gap-2">{reviewedRun.artifacts?.map((artifact) => <Button key={artifact.id} variant="outline" asChild><a href={artifactHref(artifact.id)}>{artifact.kind} · {Math.ceil(artifact.byteSize / 1024)} KiB</a></Button>)}</div></div>}
      <div className="flex gap-2"><Button onClick={() => void publish(reviewedRun.id)}><Send className="size-4" />Publish reviewed results to Azure DevOps</Button><Button variant="outline" onClick={() => void publish(reviewedRun.id, true)}>Retry failed publication</Button></div>
    </CardContent></Card>}
  </div>
}
