"use client";

import { useState } from "react";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { newTestDataEntry, type TestDataDraftEntry } from "../lib/execution-draft";

const MAX_ENTRIES = 20;

/**
 * Repeatable title/value rows for run test data. Secret rows are masked; a
 * row backed by a saved value renders "Saved — type to replace" and typing a
 * new value replaces it (the saved value itself never reaches the browser).
 */
export function TestDataEditor({
  entries,
  onChange,
}: {
  entries: TestDataDraftEntry[];
  onChange: (entries: TestDataDraftEntry[]) => void;
}) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  function updateEntry(localId: string, patch: Partial<TestDataDraftEntry>) {
    onChange(entries.map((entry) => (entry.localId === localId ? { ...entry, ...patch } : entry)));
  }

  function removeEntry(localId: string) {
    setRevealed((current) => ({ ...current, [localId]: false }));
    onChange(entries.filter((entry) => entry.localId !== localId));
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Values the tests can use by their title — for example a step can say “Enter the Admin password”.
        Private values are encrypted at rest and are only shared with your configured AI model while a test runs.
      </p>
      {entries.map((entry) => {
        const hasSavedValue = entry.isSecret && Boolean(entry.savedRef) && !entry.value;
        const showValue = !entry.isSecret || revealed[entry.localId];
        return (
          <div key={entry.localId} className="grid items-end gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor={`test-data-title-${entry.localId}`}>Title</Label>
              <Input
                id={`test-data-title-${entry.localId}`}
                value={entry.title}
                maxLength={100}
                placeholder="e.g. Username, Mobile number, Admin password"
                onChange={(event) => updateEntry(entry.localId, { title: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`test-data-value-${entry.localId}`}>Value</Label>
              <div className="relative">
                <Input
                  id={`test-data-value-${entry.localId}`}
                  type={showValue ? "text" : "password"}
                  value={entry.value}
                  maxLength={2000}
                  placeholder={hasSavedValue ? "Saved — type to replace" : entry.isSecret ? "Enter a private value" : "e.g. qa.user@example.com"}
                  className={entry.isSecret ? "pr-9" : undefined}
                  onChange={(event) => updateEntry(entry.localId, { value: event.target.value })}
                />
                {entry.isSecret ? (
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
                    aria-label={showValue ? `Hide ${entry.title || "value"}` : `Show ${entry.title || "value"}`}
                    onClick={() => setRevealed((current) => ({ ...current, [entry.localId]: !current[entry.localId] }))}
                  >
                    {showValue ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-3 pb-1.5">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={entry.isSecret}
                  onCheckedChange={(checked) => {
                    const isSecret = checked === true;
                    updateEntry(entry.localId, isSecret ? { isSecret } : { isSecret, savedRef: undefined });
                  }}
                />
                Keep private
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${entry.title || "test data entry"}`}
                onClick={() => removeEntry(entry.localId)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={entries.length >= MAX_ENTRIES}
        onClick={() => onChange([...entries, newTestDataEntry()])}
      >
        <Plus className="size-4" aria-hidden="true" />
        Add test data
      </Button>
    </div>
  );
}
