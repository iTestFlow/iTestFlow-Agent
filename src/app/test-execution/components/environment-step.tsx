"use client";

import { useState } from "react";
import { ChevronDown, Eye, EyeOff, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { NaturalStep } from "@/modules/test-execution/action-schema";

import { TextStepEditor } from "./text-step-editor";

/**
 * Environment step: pick a saved profile or configure a one-time run.
 * Progressive disclosure — URL/login basics up front, viewport/timeouts/
 * evidence level behind "Advanced". Secret inputs are write-only with a
 * show/hide toggle during entry; saved secrets render masked previews only.
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

export function EnvironmentStep({
  profiles,
  profilesLoading,
  selection,
  onSelectionChange,
  onSaveAsProfile,
  saving,
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
  onContinue: () => void;
  onInvalidateSession: (profileId: string) => Promise<void>;
  invalidatingSession: boolean;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  const oneTime = selection?.mode === "one_time" ? selection.config : null;
  const setOneTime = (patch: Partial<OneTimeEnvironmentState>) => {
    const base = oneTime ?? defaultOneTimeEnvironment();
    onSelectionChange({ mode: "one_time", config: { ...base, ...patch } });
  };

  const validateUrls = (config: OneTimeEnvironmentState): boolean => {
    try {
      const initial = new URL(config.initialUrl);
      const origin = new URL(config.allowedOrigin || initial.origin);
      if (initial.origin !== origin.origin) {
        setUrlError("The initial URL must be inside the allowed origin.");
        return false;
      }
      setUrlError(null);
      return true;
    } catch {
      setUrlError("Enter a full URL including https:// — e.g. https://app.example.com/login.");
      return false;
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
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => onSelectionChange({ mode: "profile", profile })}
                    aria-pressed={selected}
                    className={`rounded-md border p-3 text-left transition-colors ${selected ? "border-primary bg-primary/5" : "hover:bg-accent"}`}
                  >
                    <p className="font-medium">{profile.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{profile.initialUrl}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {profile.secrets.length} secret(s) · {profile.loginPlan ? "login sequence" : "no login"} · evidence: {profile.evidenceLevel.replace(/_/g, " ")}
                      {profile.users.length > 0 ? ` · ${profile.users.length} test user(s)` : ""}
                      {profile.sessionCapturedAt ? " · login session saved" : ""}
                    </p>
                  </button>
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

      <Card>
        <CardHeader>
          <CardTitle>{selection?.mode === "profile" ? "Or configure a one-time environment" : "One-time environment"}</CardTitle>
          <CardDescription>Used for this run only unless you save it as a profile.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="te-initial-url">
                Initial URL <span aria-hidden className="text-destructive">*</span>
              </Label>
              <Input
                id="te-initial-url"
                value={oneTime?.initialUrl ?? ""}
                placeholder="https://app.example.com/login"
                onChange={(event) => setOneTime({ initialUrl: event.target.value, allowedOrigin: oneTime?.allowedOrigin ?? "" })}
                onBlur={() => oneTime && validateUrls({ ...oneTime, allowedOrigin: oneTime.allowedOrigin || safeOrigin(oneTime.initialUrl) })}
              />
              <p className="text-xs text-muted-foreground">The page the browser opens first.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="te-allowed-origin">Allowed origin</Label>
              <Input
                id="te-allowed-origin"
                value={oneTime?.allowedOrigin ?? ""}
                placeholder="Defaults to the initial URL's origin"
                onChange={(event) => setOneTime({ allowedOrigin: event.target.value })}
                onBlur={() => oneTime && validateUrls(oneTime)}
              />
              <p className="text-xs text-muted-foreground">Navigation outside this origin is blocked at run time.</p>
            </div>
          </div>
          {urlError ? (
            <p className="text-sm text-destructive" role="alert">{urlError}</p>
          ) : null}

          <div className="space-y-2">
            <p className="text-sm font-medium">Credentials for the app under test</p>
            <SecretListEditor
              secrets={oneTime?.secrets ?? []}
              onChange={(secrets) => {
                // A deleted or renamed credential must not leave test users
                // pointing at a name that no longer exists.
                const names = new Set(secrets.map((secret) => secret.secretName));
                const users = (oneTime?.users ?? []).map((user) =>
                  user.passwordSecretName && !names.has(user.passwordSecretName)
                    ? { ...user, passwordSecretName: null }
                    : user,
                );
                setOneTime({ secrets, users });
              }}
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Test users (optional)</p>
            <p className="text-xs text-muted-foreground">
              Steps can name a user by handle — e.g. &quot;Login as expired_user&quot;. A user without its own password secret
              falls back to a secret named DEFAULT_PASSWORD when one exists.
            </p>
            <TestUserListEditor
              users={oneTime?.users ?? []}
              secretNames={(oneTime?.secrets ?? []).map((secret) => secret.secretName).filter(Boolean)}
              onChange={(users) => setOneTime({ users })}
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Login sequence (runs once per run, before any test case)</p>
            <TextStepEditor
              steps={oneTime?.loginSteps ?? []}
              onChange={(loginSteps) => setOneTime({ loginSteps })}
              availableSecretNames={(oneTime?.secrets ?? []).map((secret) => secret.secretName)}
              idPrefix="te-login"
            />
            {(oneTime?.loginSteps.length ?? 0) > 0 ? (
              <div className="grid gap-3 pt-1 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="te-login-mode">Between runs</Label>
                  <Select
                    value={oneTime?.loginMode ?? "session"}
                    onValueChange={(value) => setOneTime({ loginMode: value as OneTimeEnvironmentState["loginMode"] })}
                  >
                    <SelectTrigger id="te-login-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="session">Reuse the login session (faster)</SelectItem>
                      <SelectItem value="fresh">Log in fresh every run</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="te-logged-in-text">Logged-in landmark text</Label>
                  <Input
                    id="te-logged-in-text"
                    value={oneTime?.loggedInText ?? ""}
                    placeholder='e.g. "Logout" or the account menu name'
                    onChange={(event) => setOneTime({ loggedInText: event.target.value })}
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
            <Label htmlFor="te-execution-notes">Execution notes for the AI (optional)</Label>
            <Textarea
              id="te-execution-notes"
              value={oneTime?.executionNotes ?? ""}
              maxLength={2000}
              rows={3}
              placeholder={
                "e.g. Dates use DD/MM/YYYY. The app shows a spinner after login — wait for the dashboard. " +
                "'Save' sits at the bottom of long forms."
              }
              onChange={(event) => setOneTime({ executionNotes: event.target.value })}
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
                  <Label htmlFor="te-viewport-w">Viewport width</Label>
                  <Input id="te-viewport-w" inputMode="numeric" value={oneTime?.viewportWidth ?? 1280} onChange={(event) => setOneTime({ viewportWidth: Number(event.target.value) || 1280 })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="te-viewport-h">Viewport height</Label>
                  <Input id="te-viewport-h" inputMode="numeric" value={oneTime?.viewportHeight ?? 720} onChange={(event) => setOneTime({ viewportHeight: Number(event.target.value) || 720 })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="te-evidence">Evidence level</Label>
                  <Select value={oneTime?.evidenceLevel ?? "on_failure"} onValueChange={(value) => setOneTime({ evidenceLevel: value as OneTimeEnvironmentState["evidenceLevel"] })}>
                    <SelectTrigger id="te-evidence">
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
                  <Label htmlFor="te-timeout">Action timeout (ms)</Label>
                  <Input id="te-timeout" inputMode="numeric" value={oneTime?.defaultTimeoutMs ?? 10_000} onChange={(event) => setOneTime({ defaultTimeoutMs: Number(event.target.value) || 10_000 })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="te-nav-timeout">Navigation timeout (ms)</Label>
                  <Input id="te-nav-timeout" inputMode="numeric" value={oneTime?.navigationTimeoutMs ?? 30_000} onChange={(event) => setOneTime({ navigationTimeoutMs: Number(event.target.value) || 30_000 })} />
                </div>
                <div className="flex items-center gap-2 pt-6">
                  <Checkbox id="te-headless" checked={oneTime?.headless ?? true} onCheckedChange={(checked) => setOneTime({ headless: checked === true })} />
                  <Label htmlFor="te-headless" className="font-normal">Headless browser</Label>
                </div>
              </div>
            ) : null}
          </div>

          {oneTime ? (
            <div className="flex flex-wrap items-end gap-2 border-t pt-3">
              <div className="space-y-1.5">
                <Label htmlFor="te-profile-name">Save as environment profile</Label>
                <Input id="te-profile-name" value={profileName} placeholder="e.g. Staging" onChange={(event) => setProfileName(event.target.value)} className="w-56" />
              </div>
              <Button
                variant="outline"
                disabled={saving || !profileName.trim() || !oneTime.initialUrl}
                onClick={() => {
                  if (!validateUrls(oneTime)) return;
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

      <div className="flex justify-end">
        <Button disabled={!readyToContinue} onClick={onContinue}>
          Continue to Test Scope
        </Button>
      </div>
    </div>
  );
}

function SecretListEditor({
  secrets,
  onChange,
}: {
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
            <Label htmlFor={`te-secret-title-${index}`}>Title</Label>
            <Input id={`te-secret-title-${index}`} value={secret.title} placeholder="Admin password" onChange={(event) => update(index, { title: event.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`te-secret-name-${index}`}>Name (used as {"{{secret:NAME}}"})</Label>
            <Input
              id={`te-secret-name-${index}`}
              value={secret.secretName}
              placeholder="ADMIN_PASSWORD"
              onChange={(event) => update(index, { secretName: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`te-secret-value-${index}`}>Value (encrypted at rest)</Label>
            <div className="flex gap-1">
              <Input
                id={`te-secret-value-${index}`}
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
  users,
  secretNames,
  onChange,
}: {
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
            <Label htmlFor={`te-user-handle-${index}`}>Handle (used in steps)</Label>
            <Input
              id={`te-user-handle-${index}`}
              value={user.handle}
              maxLength={64}
              placeholder="expired_user"
              onChange={(event) => update(index, { handle: sanitizeHandle(event.target.value) })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`te-user-username-${index}`}>Username / email</Label>
            <Input
              id={`te-user-username-${index}`}
              value={user.username}
              placeholder="expired@example.com"
              onChange={(event) => update(index, { username: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`te-user-secret-${index}`}>Password secret</Label>
            <Select
              value={user.passwordSecretName ?? NO_USER_SECRET}
              onValueChange={(value) => update(index, { passwordSecretName: value === NO_USER_SECRET ? null : value })}
            >
              <SelectTrigger id={`te-user-secret-${index}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_USER_SECRET}>DEFAULT_PASSWORD (fallback)</SelectItem>
                {secretNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`te-user-notes-${index}`}>Notes for the AI</Label>
            <Input
              id={`te-user-notes-${index}`}
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
