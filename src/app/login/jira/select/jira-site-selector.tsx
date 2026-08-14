"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function JiraSiteSelector({
  continuation,
  sites,
}: {
  continuation: string;
  sites: Array<{ id: string; name: string; url: string }>;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(sites[0]?.id ?? "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function connect() {
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/auth/jira/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ continuation, cloudId: selected }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "Jira site selection could not be completed.");
        setSubmitting(false);
        return;
      }
      router.replace(body.returnTo ?? "/dashboards");
    } catch {
      setError("Jira site selection is unavailable. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-semibold">Choose a Jira Cloud site</h1>
        <p className="mt-2 text-sm text-muted-foreground">Select the approved site to connect to this iTestFlow workspace.</p>
      </div>
      <div className="grid gap-3" role="radiogroup" aria-label="Jira Cloud sites">
        {sites.map((site) => (
          <label key={site.id} className="flex cursor-pointer gap-3 rounded-lg border p-4">
            <input type="radio" name="jira-site" value={site.id} checked={selected === site.id} onChange={() => setSelected(site.id)} />
            <span><span className="block font-medium">{site.name}</span><span className="text-sm text-muted-foreground">{site.url}</span></span>
          </label>
        ))}
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <button type="button" onClick={connect} disabled={!selected || submitting} className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">
        {submitting ? "Connecting…" : "Connect selected site"}
      </button>
    </main>
  );
}
