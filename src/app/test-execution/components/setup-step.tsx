"use client";

import { useState } from "react";
import { ChevronDown, Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SearchableCombobox } from "@/components/ui/searchable-combobox";
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { SectionCard } from "@/components/workflow/test-intelligence-shared";
import { ExtraInstructionsField } from "@/components/workflow/extra-instructions-field";
import { cn } from "@/lib/utils";
import { SCREENSHOT_POLICIES, SCREENSHOT_POLICY_LABELS, type ScreenshotPolicy } from "@/modules/test-execution/screenshot-policy";
import {
  RUN_NAME_LIMIT,
  VIEWPORT_HEIGHT_MAX,
  VIEWPORT_HEIGHT_MIN,
  VIEWPORT_WIDTH_MAX,
  VIEWPORT_WIDTH_MIN,
  isValidHttpUrl,
  viewportIssues,
  type DraftSetup,
} from "../lib/execution-draft";
import type { ExecutionProfileView } from "../lib/run-types";
import { TestDataEditor } from "./test-data-editor";

function CollapsibleSection({
  id,
  title,
  defaultOpen,
  children,
}: {
  id: string;
  title: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-medium"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
      >
        {title}
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? <div id={id} className="border-t border-border p-3">{children}</div> : null}
    </div>
  );
}

/**
 * Step 1 — everything a run needs before test cases: where to start (Base
 * URL), what evidence to keep (screenshot policy), and the optional extras
 * (test data, AI instructions, reusable profiles). Only the Base URL is
 * required.
 */
export function SetupStep({
  setup,
  onSetupChange,
  profiles,
  profilesLoading,
  profileBusy,
  onApplyProfile,
  onSaveProfile,
  onUpdateProfile,
  onDeleteProfile,
}: {
  setup: DraftSetup;
  onSetupChange: (setup: DraftSetup) => void;
  profiles: ExecutionProfileView[];
  profilesLoading: boolean;
  profileBusy: boolean;
  onApplyProfile: (profile: ExecutionProfileView) => void;
  onSaveProfile: (name: string) => Promise<boolean>;
  onUpdateProfile: () => Promise<void>;
  onDeleteProfile: () => Promise<void>;
}) {
  const [profileName, setProfileName] = useState("");
  const baseUrlInvalid = Boolean(setup.baseUrl.trim()) && !isValidHttpUrl(setup.baseUrl);
  const viewportProblems = viewportIssues(setup);
  const widthInvalid = viewportProblems.some((message) => message.includes("width"));
  const heightInvalid = viewportProblems.some((message) => message.includes("height"));
  const selectedProfile = profiles.find((profile) => profile.id === setup.profileId) ?? null;
  const hasOptionalContent = setup.testData.length > 0;

  return (
    <SectionCard
      title="Execution setup"
      description="Only the Base URL is required — everything else is optional and starts with sensible defaults."
    >
      <div className="space-y-4 p-4">
        {profiles.length || profilesLoading ? (
          <div className="grid items-end gap-3 lg:grid-cols-[280px_auto]">
            <div className="space-y-1.5">
              <Label>Start from a saved profile (optional)</Label>
              <SearchableCombobox
                value={setup.profileId ?? ""}
                options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
                onValueChange={(value) => {
                  const profile = profiles.find((entry) => entry.id === value);
                  if (profile) onApplyProfile(profile);
                }}
                loading={profilesLoading}
                placeholder="Select a profile"
                emptyMessage="No saved profiles yet."
              />
            </div>
            {selectedProfile ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" disabled={profileBusy} onClick={() => void onUpdateProfile()}>
                  {profileBusy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
                  Update “{selectedProfile.name}”
                </Button>
                <ConfirmationDialog
                  trigger={<Button type="button" variant="destructive" size="sm" disabled={profileBusy}>Delete profile</Button>}
                  title={`Delete "${selectedProfile.name}"?`}
                  description="The saved profile and its stored values are removed for everyone in this project. The current form keeps its values."
                  confirmLabel="Delete"
                  onConfirm={() => void onDeleteProfile()}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="execution-run-name">Run name (optional)</Label>
          <Input
            id="execution-run-name"
            value={setup.runName}
            maxLength={RUN_NAME_LIMIT}
            placeholder="e.g. Nightly smoke — staging"
            onChange={(event) => onSetupChange({ ...setup, runName: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Shown in run history next to the date. Leave empty to identify runs by date alone.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="execution-base-url">Base URL <span aria-hidden="true" className="text-destructive">*</span></Label>
          <Input
            id="execution-base-url"
            type="url"
            required
            value={setup.baseUrl}
            maxLength={2048}
            placeholder="https://your-app.example.com"
            aria-invalid={baseUrlInvalid || undefined}
            aria-describedby="execution-base-url-help"
            onChange={(event) => onSetupChange({ ...setup, baseUrl: event.target.value })}
          />
          <p id="execution-base-url-help" className={cn("text-xs", baseUrlInvalid ? "text-destructive" : "text-muted-foreground")}>
            {baseUrlInvalid
              ? "The Base URL must start with http:// or https://."
              : "Every test case starts from this page."}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="execution-screenshot-policy">Screenshots</Label>
          <NativeSelect
            id="execution-screenshot-policy"
            className="max-w-md"
            value={setup.screenshotPolicy}
            onChange={(event) => onSetupChange({ ...setup, screenshotPolicy: event.target.value as ScreenshotPolicy })}
          >
            {SCREENSHOT_POLICIES.map((policy) => (
              <option key={policy} value={policy}>{SCREENSHOT_POLICY_LABELS[policy]}</option>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            “Validation points only” captures each step that has an expected result, plus evidence whenever a step fails.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="execution-browser-mode">Browser window</Label>
          <NativeSelect
            id="execution-browser-mode"
            className="max-w-md"
            value={setup.headless ? "headless" : "headed"}
            onChange={(event) => onSetupChange({ ...setup, headless: event.target.value === "headless" })}
          >
            <option value="headless">Headless — no visible browser window (default)</option>
            <option value="headed">Headed — show the browser while tests run</option>
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            Applies when this deployment runs Playwright over stdio. A remote (HTTP) Playwright server controls its own browser window, and a deployment that already forces headless stays headless.
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="grid max-w-md gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="execution-viewport-width">Viewport width (px)</Label>
              <Input
                id="execution-viewport-width"
                type="number"
                min={VIEWPORT_WIDTH_MIN}
                max={VIEWPORT_WIDTH_MAX}
                value={setup.viewportWidth}
                aria-invalid={widthInvalid || undefined}
                aria-describedby="execution-viewport-help"
                onChange={(event) => onSetupChange({ ...setup, viewportWidth: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="execution-viewport-height">Viewport height (px)</Label>
              <Input
                id="execution-viewport-height"
                type="number"
                min={VIEWPORT_HEIGHT_MIN}
                max={VIEWPORT_HEIGHT_MAX}
                value={setup.viewportHeight}
                aria-invalid={heightInvalid || undefined}
                aria-describedby="execution-viewport-help"
                onChange={(event) => onSetupChange({ ...setup, viewportHeight: event.target.value })}
              />
            </div>
          </div>
          <p id="execution-viewport-help" className={cn("text-xs", viewportProblems.length ? "text-destructive" : "text-muted-foreground")}>
            {viewportProblems[0]
              ?? `Browser size for every test case. Width ${VIEWPORT_WIDTH_MIN}–${VIEWPORT_WIDTH_MAX}, height ${VIEWPORT_HEIGHT_MIN}–${VIEWPORT_HEIGHT_MAX}. Default 1920 × 1080.`}
          </p>
        </div>

        <CollapsibleSection id="execution-test-data" title={`Test data (optional)${setup.testData.length ? ` — ${setup.testData.length}` : ""}`} defaultOpen={hasOptionalContent}>
          <TestDataEditor entries={setup.testData} onChange={(testData) => onSetupChange({ ...setup, testData })} />
        </CollapsibleSection>

        <CollapsibleSection id="execution-notes" title="Instructions for the AI (optional)" defaultOpen={Boolean(setup.executionNotes)}>
          <ExtraInstructionsField
            value={setup.executionNotes}
            onChange={(executionNotes) => onSetupChange({ ...setup, executionNotes })}
            label="Instructions"
            placeholder="Anything the AI should know while executing — e.g. “The app shows a cookie banner on first visit; dismiss it.”"
            helperText="Background guidance for every test case in this run. It never overrides a step's own instruction or expected result."
          />
        </CollapsibleSection>

        <div className="grid items-end gap-3 border-t border-border pt-4 lg:grid-cols-[280px_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="execution-profile-name">Save this setup as a profile (optional)</Label>
            <Input
              id="execution-profile-name"
              value={profileName}
              maxLength={120}
              placeholder="e.g. Staging environment"
              onChange={(event) => setProfileName(event.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={!profileName.trim() || profileBusy}
            onClick={() => void onSaveProfile(profileName).then((saved) => { if (saved) setProfileName(""); })}
          >
            {profileBusy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
            Save profile
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
