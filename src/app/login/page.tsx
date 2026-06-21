"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function LoginPage() {
  const router = useRouter()
  const [organization, setOrganization] = useState("")
  const [personalAccessToken, setPersonalAccessToken] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organization, personalAccessToken }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(data.error ?? "Sign in failed.")
        return
      }
      toast.success("Signed in.")
      router.push("/")
      router.refresh()
    } catch {
      toast.error("Sign in failed. Check your connection and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center p-4">
      <Card>
        <CardHeader>
          <CardTitle>Sign in to iTestFlow</CardTitle>
          <CardDescription>
            Enter your Azure DevOps organization and a Personal Access Token. Your PAT is validated against Azure
            DevOps, stored encrypted, and never leaves the server in plain text.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-2">
              <Label htmlFor="organization">Azure DevOps organization</Label>
              <Input
                id="organization"
                placeholder="contoso  or  https://dev.azure.com/contoso"
                value={organization}
                onChange={(event) => setOrganization(event.target.value)}
                autoComplete="organization"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pat">Personal Access Token</Label>
              <Input
                id="pat"
                type="password"
                placeholder="Azure DevOps PAT"
                value={personalAccessToken}
                onChange={(event) => setPersonalAccessToken(event.target.value)}
                autoComplete="off"
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Validating…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
