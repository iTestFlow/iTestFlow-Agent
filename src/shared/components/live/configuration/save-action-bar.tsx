"use client";

import { Loader2, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Sticky action bar shown on the settings page only while there are unsaved
 * changes. Surfaces Discard / Test connections / Save changes, with the reason
 * Save is blocked stated inline when applicable.
 */
export function SaveActionBar({
  visible,
  saving,
  testing,
  saveDisabledReason,
  onTest,
  onDiscard,
  onSave,
}: {
  visible: boolean;
  saving: boolean;
  testing: boolean;
  saveDisabledReason: string | null;
  onTest: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  if (!visible) return null;
  const busy = saving || testing;

  return (
    <div className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div>
        <p className="text-sm font-medium text-foreground">You have unsaved changes</p>
        {saveDisabledReason ? (
          <p className="text-xs leading-5 text-warning-foreground dark:text-warning">
            Can&apos;t save yet: {saveDisabledReason}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
        <Button type="button" variant="outline" onClick={onTest} disabled={busy}>
          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Test connections
        </Button>
        <Button type="button" onClick={onSave} disabled={busy || Boolean(saveDisabledReason)}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save changes
        </Button>
      </div>
    </div>
  );
}
