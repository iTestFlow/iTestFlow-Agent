"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { NaturalPlan, NaturalStep } from "@/modules/test-execution/action-schema";

import { buildNaturalPlan } from "../lib/manual-step-form";
import { TextStepEditor } from "./text-step-editor";

/**
 * Environment step: pick a saved profile, edit one, or configure a one-time
 * run. The same EnvironmentConfigFields form serves both the one-time and the
 * edit-profile modes. Progressive disclosure — URL/login basics up front,
 * viewport/timeouts/evidence level behind "Advanced". Secret inputs are
 * write-only with a show/hide toggle during entry; saved secrets render
 * masked previews only, and replacing a value means re-entering it under the
 * same name.
 */

export type TestUserDraft = {
  handle: string;
  username: string;
  passwordSecretName: string | null;
  notes: string;
};

export type EnvironmentProfileSummary = {
  id: string;
  name: string;
  initialUrl: string;
  allowedOrigin: string;
  viewportWidth: number;
  viewportHeight: number;
  headless: boolean;
  defaultTimeoutMs: number;
  navigationTimeoutMs: number;
  evidenceLevel: "minimal" | "on_failure" | "all_steps";
  loginPlan: unknown;
  loginMode: "session" | "fresh";
  loggedInText: string;
  executionNotes: string;
  users: TestUserDraft[];
  secrets: { secretName: string; title: string; maskedPreview: string }[];
  sessionCapturedAt: string | null;
};

export type OneTimeEnvironmentState = {
  initialUrl: string;
  allowedOrigin: string;
  viewportWidth: number;
  viewportHeight: number;
  headless: boolean;
  defaultTimeoutMs: number;
  navigationTimeoutMs: number;
  evidenceLevel: "minimal" | "on_failure" | "all_steps";
  loginSteps: NaturalStep[];
  loginMode: "session" | "fresh";
  loggedInText: string;
  executionNotes: string;
  users: TestUserDraft[];
  secrets: { secretName: string; title: string; value: string }[];
};

export function defaultOneTimeEnvironment(): OneTimeEnvironmentState {
  return {
    initialUrl: "",
    allowedOrigin: "",
    viewportWidth: 1280,
    viewportHeight: 720,
    headless: true,
    defaultTimeoutMs: 10_000,
    navigationTimeoutMs: 30_000,
    evidenceLevel: "on_failure",
    loginSteps: [],
    loginMode: "session",
    loggedInText: "",
    executionNotes: "",
    users: [],
    secrets: [],
  };
}

export type EnvironmentSelection =
  | { mode: "profile"; profile: EnvironmentProfileSummary }
  | { mode: "one_time"; config: OneTimeEnvironmentState };

export function environmentSecretNames(selection: EnvironmentSelection | null): string[] {
  if (!selection) return [];
  return selection.mode === "profile"
    ? selection.profile.secrets.map((secret) => secret.secretName)
    : selection.config.secrets.map((secret) => secret.secretName);
}

export function environmentAllowedOrigin(selection: EnvironmentSelection | null): string {
  if (!selection) return "";
  return selection.mode === "profile" ? selection.profile.allowedOrigin : selection.config.allowedOrigin;
}

/**
 * Only complete rows leave the browser — half-filled user rows are dropped,
 * not rejected — and a password reference to a secret that will not actually
 * exist after this request falls back to null so the worker's
 * DEFAULT_PASSWORD fallback stays honest.
 */
export function usableTestUsers(users: TestUserDraft[], validSecretNames: string[]): TestUserDraft[] {
  const names = new Set(validSecretNames);
  return users
    .filter((user) => /^[a-z][a-z0-9_]{0,63}$/.test(user.handle) && user.username.trim().length > 0)
    .map((user) => ({
      ...user,
      username: user.username.trim(),
      passwordSecretName:
        user.passwordSecretName && names.has(user.passwordSecretName) ? user.passwordSecretName : null,
    }));
}

/** Clamp the numeric browser options into the ranges the API schema accepts. */
export function clampEnvironmentLimits(config: OneTimeEnvironmentState): OneTimeEnvironmentState {
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  return {
    ...config,
    viewportWidth: clamp(config.viewportWidth, 320, 3840),
    viewportHeight: clamp(config.viewportHeight, 320, 3840),
    defaultTimeoutMs: clamp(config.defaultTimeoutMs, 500, 60_000),
    navigationTimeoutMs: clamp(config.navigationTimeoutMs, 1_000, 120_000),
  };
}

/** Everything the PATCH route needs to persist a profile edit. */
export type ProfileUpdatePayload = {
  config: {
    name: string;
    initialUrl: string;
    allowedOrigin: string;
    viewportWidth: number;
    viewportHeight: number;
    headless: boolean;
    defaultTimeoutMs: number;
    navigationTimeoutMs: number;
    evidenceLevel: "minimal" | "on_failure" | "all_steps";
    loginPlan: NaturalPlan | null;
    loginMode: "session" | "fresh";
    loggedInText: string;
    executionNotes: string;
    users: TestUserDraft[];
  };
  upsertSecrets: { secretName: string; title: string; value: string }[];
  removeSecretNames: string[];
};

function profileToDraft(profile: EnvironmentProfileSummary): OneTimeEnvironmentState {
  return {
    initialUrl: profile.initialUrl,
    allowedOrigin: profile.allowedOrigin,
    viewportWidth: profile.viewportWidth,
    viewportHeight: profile.viewportHeight,
    headless: profile.headless,
    defaultTimeoutMs: profile.defaultTimeoutMs,
    navigationTimeoutMs: profile.navigationTimeoutMs,
    evidenceLevel: profile.evidenceLevel,
    loginSteps: (profile.loginPlan as { steps?: NaturalStep[] } | null)?.steps ?? [],
    loginMode: profile.loginMode,
    loggedInText: profile.loggedInText,
    executionNotes: profile.executionNotes,
    users: profile.users.map((user) => ({ ...user })),
    secrets: [],
  };
}

type ProfileEditState = {
  profile: EnvironmentProfileSummary;
  name: string;
  draft: OneTimeEnvironmentState;
  removeSecretNames: string[];
};

export function EnvironmentStep({
  profiles,
  profilesLoading,
  selection,
  onSelectionChange,
  onSaveAsProfile,
  saving,
  onUpdateProfile,
  updatingProfile,
  onContinue,
  onInvalidateSession,
  invalidatingSession,
}: {
  profiles: EnvironmentProfileSummary[];
  profilesLoading: boolean;
  selection: EnvironmentSelection | null;
  onSelectionChange: (selection: EnvironmentSelection | null) => void;
  onSaveAsProfile: (name: string, config: OneTimeEnvironmentState) => Promise<void>;
  saving: boolean;
  onUpdateProfile: (profileId: string, payload: ProfileUpdatePayload) => Promise<boolean>;
  updatingProfile: boolean;
  onContinue: () => void;
  onInvalidateSession: (profileId: string) => Promise<void>;
  invalidatingSession: boolean;
}) {
  const [profileName, setProfileName] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProfileEditState | null>(null);
  const [editUrlError, setEditUrlError] = useState<string | null>(null);

  const oneTime = selection?.mode === "one_time" ? selection.config : null;
  const setOneTime = (patch: Partial<OneTimeEnvironmentState>) => {
    const base = oneTime ?? defaultOneTimeEnvironment();
    onSelectionChange({ mode: "one_time", config: { ...base, ...patch } });
  };

  const setEditDraft = (patch: Partial<OneTimeEnvironmentState>) => {
    setEditing((previous) => (previous ? { ...previous, draft: { ...previous.draft, ...patch } } : previous));
  };

  const validateUrls = (config: OneTimeEnvironmentState, report: (message: string | null) => void): boolean => {
    try {
      const initial = new URL(config.initialUrl);
      const origin = new URL(config.allowedOrigin || initial.origin);
      if (initial.origin !== origin.origin) {
        report("The initial URL must be inside the allowed origin.");
        return false;
      }
      report(null);
      return true;
    } catch {
      report("Enter a full URL including https:// — e.g. https://app.example.com/login.");
      return false;
    }
  };

  const startEdit = (profile: EnvironmentProfileSummary) => {
    setEditing({ profile, name: profile.name, draft: profileToDraft(profile), removeSecretNames: [] });
    setEditUrlError(null);
  };

  /**
   * Secret names that will exist on the profile after this edit is saved:
   * kept existing ones plus draft rows that would actually be sent (name AND
   * value — a valueless row is never persisted, so it must not be assignable).
   */
  const editValidSecretNames = (state: ProfileEditState): string[] => {
    const kept = state.profile.secrets
      .map((secret) => secret.secretName)
      .filter((name) => !state.removeSecretNames.includes(name));
    const added = state.draft.secrets
      .filter((secret) => secret.secretName && secret.value)
      .map((secret) => secret.secretName);
    return [...new Set([...kept, ...added])];
  };

  const saveProfileEdits = async () => {
    if (!editing) return;
    const draft = clampEnvironmentLimits(editing.draft);
    if (!validateUrls(draft, setEditUrlError)) return;
    // Same hygiene as the create path: blank steps dropped, valueless secret
    // rows never sent, titles default to the secret name.
    const upsertSecrets = draft.secrets
      .filter((secret) => secret.secretName && secret.value)
      .map((secret) => ({ ...secret, title: secret.title.trim() || secret.secretName }));
    const validNames = [
      ...new Set([
        ...editing.profile.secrets
          .map((secret) => secret.secretName)
          .filter((name) => !editing.removeSecretNames.includes(name)),
        ...upsertSecrets.map((secret) => secret.secretName),
      ]),
    ];
    const saved = await onUpdateProfile(editing.profile.id, {
      config: {
        name: editing.name.trim(),
        initialUrl: draft.initialUrl,
        allowedOrigin: draft.allowedOrigin || safeOrigin(draft.initialUrl),
        viewportWidth: draft.viewportWidth,
        viewportHeight: draft.viewportHeight,
        headless: draft.headless,
        defaultTimeoutMs: draft.defaultTimeoutMs,
        navigationTimeoutMs: draft.navigationTimeoutMs,
        evidenceLevel: draft.evidenceLevel,
        loginPlan: buildNaturalPlan(draft.loginSteps),
        loginMode: draft.loginMode,
        loggedInText: draft.loggedInText.trim(),
        executionNotes: draft.executionNotes.trim(),
        users: usableTestUsers(draft.users, validNames),
      },
      upsertSecrets,
      removeSecretNames: editing.removeSecretNames,
    });
    if (saved) {
      setEditing(null);
      setEditUrlError(null);
    }
  };

  const readyToContinue =
    selection?.mode === "profile" ||
    (oneTime !== null && oneTime.initialUrl.length > 0 && urlError === null);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Saved environment profiles</CardTitle>
          <CardDescription>
            An environment describes where tests run: target URL, browser options, login sequence, and encrypted credentials.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {profilesLoading ? (
            <div className="h-10 animate-pulse rounded-md bg-muted" aria-hidden />
          ) : profiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No profiles yet for this project — configure a one-time environment below, then save it as a profile for next time.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {profiles.map((profile) => {
                const selected = selection?.mode === "profile" && selection.profile.id === profile.id;
                return (
                  <div
                    key={profile.id}
                    className={`flex items-start gap-1 rounded-md border p-3 transition-colors ${selected ? "border-primary bg-primary/5" : "hover:bg-accent"}`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectionChange({ mode: "profile", profile })}
                      aria-pressed={selected}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="font-medium">{profile.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{profile.initialUrl}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {profile.secrets.length} secret(s) · {profile.loginPlan ? "login sequence" : "no login"} · evidence: {profile.evidenceLevel.replace(/_/g, " ")}
                        {profile.users.length > 0 ? ` · ${profile.users.length} test user(s)` : ""}
                        {profile.sessionCapturedAt ? " · login session saved" : ""}
                      </p>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      aria-label={`Edit profile ${profile.name}`}
                      onClick={() => startEdit(profile)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
          {selection?.mode === "profile" && selection.profile.sessionCapturedAt ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <p className="text-xs text-muted-foreground">
                Saved login session from {new Date(selection.profile.sessionCapturedAt).toLocaleString()} — the next run skips
                login if it is still valid.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={invalidatingSession}
                onClick={() => void onInvalidateSession(selection.profile.id)}
              >
                {invalidatingSession ? "Invalidating…" : "Invalidate session"}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {editing ? (
        <Card>
          <CardHeader>
            <CardTitle>Edit profile — {editing.profile.name}</CardTitle>
            <CardDescription>
              Changes apply to future runs. Secret values are write-only: add a credential with the same name to replace its
              value.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="te-edit-name">Profile name</Label>
              <Input
                id="te-edit-name"
                value={editing.name}
                maxLength={120}
                className="w-56"
                onChange={(event) =>
                  setEditing((previous) => (previous ? { ...previous, name: event.target.value } : previous))
                }
              />
            </div>

            <EnvironmentConfigFields
              config={editing.draft}
              onPatch={setEditDraft}
              idPrefix="te-edit"
              availableSecretNames={editValidSecretNames(editing)}
              urlError={editUrlError}
              onValidateUrls={() => validateUrls(editing.draft, setEditUrlError)}
              secretsSlot={
                <div className="space-y-2">
                  <p className="text-sm font-medium">Credentials for the app under test</p>
                  {editing.profile.secrets.length > 0 ? (
                    <ul className="space-y-1">
                      {editing.profile.secrets.map((secret) => {
                        const removed = editing.removeSecretNames.includes(secret.secretName);
                        return (
                          <li
                            key={secret.secretName}
                            className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
                          >
                            <span className={`min-w-0 flex-1 truncate ${removed ? "line-through opacity-60" : ""}`}>
                              <span className="font-mono text-xs">{secret.secretName}</span>
                              <span className="ml-2 text-xs text-muted-foreground">
                                {secret.title} · {secret.maskedPreview}
                              </span>
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setEditing((previous) =>
                                  previous
                                    ? {
                                        ...previous,
                                        removeSecretNames: removed
                                          ? previous.removeSecretNames.filter((name) => name !== secret.secretName)
                                          : [...previous.removeSecretNames, secret.secretName],
                                      }
                                    : previous,
                                )
                              }
                            >
                              {removed ? "Undo" : "Remove"}
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  <SecretListEditor
                    idPrefix="te-edit"
                    secrets={editing.draft.secrets}
                    onChange={(secrets) => setEditDraft({ secrets })}
                  />
                  <p className="text-xs text-muted-foreground">
                    New values are encrypted on save. Reusing an existing name replaces that credential&apos;s value.
                  </p>
                </div>
              }
            />

            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <Button
                disabled={updatingProfile || !editing.name.trim() || !editing.draft.initialUrl}
                onClick={() => void saveProfileEdits()}
              >
                {updatingProfile ? "Saving…" : "Save changes"}
              </Button>
              <Button variant="outline" disabled={updatingProfile} onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{selection?.mode === "profile" ? "Or configure a one-time environment" : "One-time environment"}</CardTitle>
            <CardDescription>Used for this run only unless you save it as a profile.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <EnvironmentConfigFields
              config={oneTime ?? defaultOneTimeEnvironment()}
              onPatch={setOneTime}
              idPrefix="te"
              availableSecretNames={(oneTime?.secrets ?? [])
                .filter((secret) => secret.secretName && secret.value)
                .map((secret) => secret.secretName)}
              urlError={urlError}
              onValidateUrls={() =>
                oneTime &&
                validateUrls(
                  { ...oneTime, allowedOrigin: oneTime.allowedOrigin || safeOrigin(oneTime.initialUrl) },
                  setUrlError,
                )
              }
              secretsSlot={
                <div className="space-y-2">
                  <p className="text-sm font-medium">Credentials for the app under test</p>
                  <SecretListEditor
                    idPrefix="te"
                    secrets={oneTime?.secrets ?? []}
                    onChange={(secrets) => setOneTime({ secrets })}
                  />
                </div>
              }
            />

            {oneTime ? (
              <div className="flex flex-wrap items-end gap-2 border-t pt-3">
                <div className="space-y-1.5">
                  <Label htmlFor="te-profile-name">Save as environment profile</Label>
                  <Input id="te-profile-name" value={profileName} maxLength={120} placeholder="e.g. Staging" onChange={(event) => setProfileName(event.target.value)} className="w-56" />
                </div>
                <Button
                  variant="outline"
                  disabled={saving || !profileName.trim() || !oneTime.initialUrl}
                  onClick={() => {
                    if (!validateUrls(oneTime, setUrlError)) return;
                    void onSaveAsProfile(profileName.trim(), {
                      ...oneTime,
                      allowedOrigin: oneTime.allowedOrigin || safeOrigin(oneTime.initialUrl),
                    });
                  }}
                >
                  {saving ? "Saving…" : "Save profile"}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button disabled={!readyToContinue} onClick={onContinue}>
          Continue to Test Scope
        </Button>
      </div>
    </div>
  );
}

/**
 * The full environment configuration form, mode-agnostic: the one-time card
 * and the edit-profile card render the same fields and differ only in the
 * credentials slot (value entry vs masked management).
 */
function EnvironmentConfigFields({
  config,
  onPatch,
  idPrefix,
  availableSecretNames,
  secretsSlot,
  urlError,
  onValidateUrls,
}: {
  config: OneTimeEnvironmentState;
  onPatch: (patch: Partial<OneTimeEnvironmentState>) => void;
  idPrefix: string;
  availableSecretNames: string[];
  secretsSlot: ReactNode;
  urlError: string | null;
  onValidateUrls: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-initial-url`}>
            Initial URL <span aria-hidden className="text-destructive">*</span>
          </Label>
          <Input
            id={`${idPrefix}-initial-url`}
            value={config.initialUrl}
            placeholder="https://app.example.com/login"
            onChange={(event) => onPatch({ initialUrl: event.target.value })}
            onBlur={onValidateUrls}
          />
          <p className="text-xs text-muted-foreground">The page the browser opens first.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-allowed-origin`}>Allowed origin</Label>
          <Input
            id={`${idPrefix}-allowed-origin`}
            value={config.allowedOrigin}
            placeholder="Defaults to the initial URL's origin"
            onChange={(event) => onPatch({ allowedOrigin: event.target.value })}
            onBlur={onValidateUrls}
          />
          <p className="text-xs text-muted-foreground">Navigation outside this origin is blocked at run time.</p>
        </div>
      </div>
      {urlError ? (
        <p className="text-sm text-destructive" role="alert">{urlError}</p>
      ) : null}

      {secretsSlot}

      <div className="space-y-2">
        <p className="text-sm font-medium">Test users (optional)</p>
        <p className="text-xs text-muted-foreground">
          Steps can name a user by handle — e.g. &quot;Login as expired_user&quot;. A user without its own password secret
          falls back to a secret named DEFAULT_PASSWORD when one exists.
        </p>
        <TestUserListEditor
          idPrefix={idPrefix}
          users={config.users}
          secretNames={availableSecretNames}
          onChange={(users) => onPatch({ users })}
        />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Login sequence (runs once per run, before any test case)</p>
        <TextStepEditor
          steps={config.loginSteps}
          onChange={(loginSteps) => onPatch({ loginSteps })}
          availableSecretNames={availableSecretNames}
          idPrefix={`${idPrefix}-login`}
        />
        {config.loginSteps.length > 0 ? (
          <div className="grid gap-3 pt-1 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-login-mode`}>Between runs</Label>
              <Select
                value={config.loginMode}
                onValueChange={(value) => onPatch({ loginMode: value as OneTimeEnvironmentState["loginMode"] })}
              >
                <SelectTrigger id={`${idPrefix}-login-mode`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="session">Reuse the login session (faster)</SelectItem>
                  <SelectItem value="fresh">Log in fresh every run</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-logged-in-text`}>Logged-in landmark text</Label>
              <Input
                id={`${idPrefix}-logged-in-text`}
                value={config.loggedInText}
                maxLength={200}
                placeholder='e.g. "Logout" or the account menu name'
                onChange={(event) => onPatch({ loggedInText: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Text visible only when logged in. Session reuse verifies this before skipping login; without it, every run
                logs in fresh.
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-execution-notes`}>Execution notes for the AI (optional)</Label>
        <Textarea
          id={`${idPrefix}-execution-notes`}
          value={config.executionNotes}
          maxLength={2000}
          rows={3}
          placeholder={
            "e.g. Dates use DD/MM/YYYY. The app shows a spinner after login — wait for the dashboard. " +
            "'Save' sits at the bottom of long forms."
          }
          onChange={(event) => onPatch({ executionNotes: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          Context the AI reads on every step: formats, timing quirks, where controls live. It guides execution but never
          overrides the safety rules or a step&apos;s expected result.
        </p>
      </div>

      <div>
        <button
          type="button"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setShowAdvanced((previous) => !previous)}
          aria-expanded={showAdvanced}
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`} aria-hidden />
          Advanced options
        </button>
        {showAdvanced ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-viewport-w`}>Viewport width</Label>
              <Input id={`${idPrefix}-viewport-w`} inputMode="numeric" value={config.viewportWidth} onChange={(event) => onPatch({ viewportWidth: Number(event.target.value) || 1280 })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-viewport-h`}>Viewport height</Label>
              <Input id={`${idPrefix}-viewport-h`} inputMode="numeric" value={config.viewportHeight} onChange={(event) => onPatch({ viewportHeight: Number(event.target.value) || 720 })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-evidence`}>Evidence level</Label>
              <Select value={config.evidenceLevel} onValueChange={(value) => onPatch({ evidenceLevel: value as OneTimeEnvironmentState["evidenceLevel"] })}>
                <SelectTrigger id={`${idPrefix}-evidence`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minimal">Minimal — failure screenshots only</SelectItem>
                  <SelectItem value="on_failure">Standard — failures + per-case final screenshot</SelectItem>
                  <SelectItem value="all_steps">Full — screenshot every step</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-timeout`}>Action timeout (ms)</Label>
              <Input id={`${idPrefix}-timeout`} inputMode="numeric" value={config.defaultTimeoutMs} onChange={(event) => onPatch({ defaultTimeoutMs: Number(event.target.value) || 10_000 })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-nav-timeout`}>Navigation timeout (ms)</Label>
              <Input id={`${idPrefix}-nav-timeout`} inputMode="numeric" value={config.navigationTimeoutMs} onChange={(event) => onPatch({ navigationTimeoutMs: Number(event.target.value) || 30_000 })} />
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Checkbox id={`${idPrefix}-headless`} checked={config.headless} onCheckedChange={(checked) => onPatch({ headless: checked === true })} />
              <Label htmlFor={`${idPrefix}-headless`} className="font-normal">Headless browser</Label>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SecretListEditor({
  idPrefix,
  secrets,
  onChange,
}: {
  idPrefix: string;
  secrets: { secretName: string; title: string; value: string }[];
  onChange: (secrets: { secretName: string; title: string; value: string }[]) => void;
}) {
  const [visible, setVisible] = useState<Record<number, boolean>>({});
  const update = (index: number, patch: Partial<{ secretName: string; title: string; value: string }>) => {
    onChange(secrets.map((secret, i) => (i === index ? { ...secret, ...patch } : secret)));
  };
  return (
    <div className="space-y-2">
      {secrets.map((secret, index) => (
        <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-secret-title-${index}`}>Title</Label>
            <Input id={`${idPrefix}-secret-title-${index}`} value={secret.title} maxLength={120} placeholder="Admin password" onChange={(event) => update(index, { title: event.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-secret-name-${index}`}>Name (used as {"{{secret:NAME}}"})</Label>
            <Input
              id={`${idPrefix}-secret-name-${index}`}
              value={secret.secretName}
              maxLength={64}
              placeholder="ADMIN_PASSWORD"
              onChange={(event) => update(index, { secretName: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-secret-value-${index}`}>Value (encrypted at rest)</Label>
            <div className="flex gap-1">
              <Input
                id={`${idPrefix}-secret-value-${index}`}
                type={visible[index] ? "text" : "password"}
                autoComplete="new-password"
                value={secret.value}
                onChange={(event) => update(index, { value: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={visible[index] ? "Hide secret value" : "Show secret value"}
                onClick={() => setVisible((previous) => ({ ...previous, [index]: !previous[index] }))}
              >
                {visible[index] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-destructive"
            aria-label={`Remove secret ${secret.secretName || index + 1}`}
            onClick={() => onChange(secrets.filter((_, i) => i !== index))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...secrets, { secretName: "", title: "", value: "" }])}
      >
        <Plus className="mr-1 h-4 w-4" /> Add credential
      </Button>
    </div>
  );
}

const NO_USER_SECRET = "__default__";

/**
 * Force the schema's handle grammar (^[a-z][a-z0-9_]{0,63}$) while typing, so
 * a visible handle is always a submittable one — never silently dropped later.
 */
export function sanitizeHandle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64);
}

function TestUserListEditor({
  idPrefix,
  users,
  secretNames,
  onChange,
}: {
  idPrefix: string;
  users: TestUserDraft[];
  secretNames: string[];
  onChange: (users: TestUserDraft[]) => void;
}) {
  const update = (index: number, patch: Partial<TestUserDraft>) => {
    onChange(users.map((user, i) => (i === index ? { ...user, ...patch } : user)));
  };
  return (
    <div className="space-y-2">
      {users.map((user, index) => (
        <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-user-handle-${index}`}>Handle (used in steps)</Label>
            <Input
              id={`${idPrefix}-user-handle-${index}`}
              value={user.handle}
              maxLength={64}
              placeholder="expired_user"
              onChange={(event) => update(index, { handle: sanitizeHandle(event.target.value) })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-user-username-${index}`}>Username / email</Label>
            <Input
              id={`${idPrefix}-user-username-${index}`}
              value={user.username}
              maxLength={200}
              placeholder="expired@example.com"
              onChange={(event) => update(index, { username: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-user-secret-${index}`}>Password secret</Label>
            <Select
              value={user.passwordSecretName ?? NO_USER_SECRET}
              onValueChange={(value) => update(index, { passwordSecretName: value === NO_USER_SECRET ? null : value })}
            >
              <SelectTrigger id={`${idPrefix}-user-secret-${index}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_USER_SECRET}>DEFAULT_PASSWORD (fallback)</SelectItem>
                {secretNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
                {user.passwordSecretName && !secretNames.includes(user.passwordSecretName) ? (
                  // Dangling reference stays VISIBLE (never silently cleared);
                  // save falls back to DEFAULT_PASSWORD unless re-linked.
                  <SelectItem value={user.passwordSecretName} className="text-destructive">
                    {user.passwordSecretName} (missing)
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-user-notes-${index}`}>Notes for the AI</Label>
            <Input
              id={`${idPrefix}-user-notes-${index}`}
              value={user.notes}
              maxLength={300}
              placeholder="e.g. subscription expired"
              onChange={(event) => update(index, { notes: event.target.value })}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-destructive"
            aria-label={`Remove test user ${user.handle || index + 1}`}
            onClick={() => onChange(users.filter((_, i) => i !== index))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...users, { handle: "", username: "", passwordSecretName: null, notes: "" }])}
      >
        <Plus className="mr-1 h-4 w-4" /> Add test user
      </Button>
    </div>
  );
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
