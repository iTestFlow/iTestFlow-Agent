"use client";

import { useRef, useState, type ReactNode } from "react";
import { ChevronDown, Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { NaturalPlan, NaturalStep } from "@/modules/test-execution/action-schema";

import {
  DEFAULT_OTP_SECRET,
  DEFAULT_PASSWORD_SECRET,
  RESERVED_SECRET_NAMES,
  buildEnvironmentParts,
  clampEnvironmentLimits,
  environmentPartsLimitIssue,
  sanitizeHandle,
  splitDefaultUser,
  unknownStepSecrets,
  type TestUserDraft,
} from "../lib/environment-payload";
import { buildNaturalPlan } from "../lib/manual-step-form";
import { TextStepEditor } from "./text-step-editor";

/**
 * Environment step: pick a saved profile, edit one, or configure a one-time
 * run. Credentials use a friendly model — Sign-in details (username /
 * password / optional OTP) plus Label+Value extras; the engine's secret
 * names are derived and never shown. The same EnvironmentConfigFields form
 * serves the one-time and edit-profile modes. Secret values are write-only:
 * saved ones render masked previews, and replacing means typing a new value.
 */

export type { TestUserDraft };

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
  /** Sign-in details — blank fields contribute nothing. */
  defaultUsername: string;
  defaultPassword: string;
  defaultOtp: string;
  /** Visible test-user rows (the reserved default user lives in the fields above). */
  users: TestUserDraft[];
  /** Extra credentials as friendly Label + Value rows; names are derived on submit. */
  secrets: { title: string; value: string }[];
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
    defaultUsername: "",
    defaultPassword: "",
    defaultOtp: "",
    users: [],
    secrets: [],
  };
}

export type EnvironmentSelection =
  | { mode: "profile"; profile: EnvironmentProfileSummary }
  | { mode: "one_time"; config: OneTimeEnvironmentState };

function oneTimeParts(config: OneTimeEnvironmentState) {
  return buildEnvironmentParts({
    defaultUsername: config.defaultUsername,
    defaultPassword: config.defaultPassword,
    defaultOtp: config.defaultOtp,
    extras: config.secrets,
    users: config.users,
  });
}

/** Engine-facing secret names available for the current selection. */
export function environmentSecretNames(selection: EnvironmentSelection | null): string[] {
  if (!selection) return [];
  return selection.mode === "profile"
    ? selection.profile.secrets.map((secret) => secret.secretName)
    : oneTimeParts(selection.config).validSecretNames;
}

/** Friendly credential labels for hints ("Default password", "Admin API key"). */
export function environmentCredentialTitles(selection: EnvironmentSelection | null): string[] {
  if (!selection) return [];
  if (selection.mode === "profile") {
    return selection.profile.secrets.map((secret) => secret.title || secret.secretName);
  }
  return oneTimeParts(selection.config).secrets.map((secret) => secret.title);
}

export function environmentAllowedOrigin(selection: EnvironmentSelection | null): string {
  if (!selection) return "";
  return selection.mode === "profile" ? selection.profile.allowedOrigin : selection.config.allowedOrigin;
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
  const { defaultUsername, otherUsers } = splitDefaultUser(profile.users);
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
    defaultUsername,
    defaultPassword: "",
    defaultOtp: "",
    users: otherUsers.map((user) => ({ ...user })),
    secrets: [],
  };
}

type ProfileEditState = {
  profile: EnvironmentProfileSummary;
  name: string;
  draft: OneTimeEnvironmentState;
  removeSecretNames: string[];
  /** New values for existing extra credentials, keyed by their secret name. */
  replacements: Record<string, string>;
  /** The legacy default user's own password link/notes — preserved verbatim. */
  defaultUserSeed: { passwordSecretName: string | null; notes: string } | null;
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
  // Switching to a profile card must not destroy a half-typed one-time
  // config — keep the latest copy so editing resumes where the user left off.
  const lastOneTimeRef = useRef<OneTimeEnvironmentState | null>(null);
  if (oneTime) lastOneTimeRef.current = oneTime;
  const setOneTime = (patch: Partial<OneTimeEnvironmentState>) => {
    const base = oneTime ?? lastOneTimeRef.current ?? defaultOneTimeEnvironment();
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
    const { defaultUser } = splitDefaultUser(profile.users);
    setEditing({
      profile,
      name: profile.name,
      draft: profileToDraft(profile),
      removeSecretNames: [],
      replacements: {},
      defaultUserSeed: defaultUser
        ? { passwordSecretName: defaultUser.passwordSecretName, notes: defaultUser.notes }
        : null,
    });
    setEditUrlError(null);
  };

  /** Existing non-reserved credentials shown in the edit card. */
  const editExistingExtras = (state: ProfileEditState) =>
    state.profile.secrets.filter((secret) => !RESERVED_SECRET_NAMES.has(secret.secretName));

  /** Names that survive this edit (kept existing, before new additions). */
  const editKeptExistingNames = (state: ProfileEditState) =>
    state.profile.secrets
      .map((secret) => secret.secretName)
      .filter((name) => !state.removeSecretNames.includes(name));

  const editParts = (state: ProfileEditState) =>
    buildEnvironmentParts({
      defaultUsername: state.draft.defaultUsername,
      defaultPassword: state.draft.defaultPassword,
      defaultOtp: state.draft.defaultOtp,
      extras: state.draft.secrets,
      users: state.draft.users,
      existingSecretNames: editKeptExistingNames(state),
      defaultUserSeed: state.defaultUserSeed,
    });

  const saveProfileEdits = async () => {
    if (!editing) return;
    const draft = clampEnvironmentLimits(editing.draft);
    if (!validateUrls(draft, setEditUrlError)) return;
    const state = { ...editing, draft };
    const parts = editParts(state);
    // A removal marked in the UI must win over any value still sitting in a
    // field — never send the same name as both an upsert and a removal.
    const partsSecrets = parts.secrets.filter((secret) => !editing.removeSecretNames.includes(secret.secretName));
    const limitIssue = environmentPartsLimitIssue(
      { ...parts, secrets: partsSecrets },
      editKeptExistingNames(state).length,
    );
    if (limitIssue) {
      toast.error(limitIssue);
      return;
    }
    const unknownTokens = unknownStepSecrets(draft.loginSteps, parts.validSecretNames);
    if (unknownTokens.length > 0) {
      toast.warning(
        `The login sequence mentions credential(s) that will not exist after saving: ${unknownTokens.join(", ")}. Runs may block at login.`,
      );
    }
    const existingTitles = new Map(editing.profile.secrets.map((secret) => [secret.secretName, secret.title]));
    const replacementUpserts = Object.entries(editing.replacements)
      .filter(([name, value]) => value && !editing.removeSecretNames.includes(name))
      .map(([name, value]) => ({ secretName: name, title: existingTitles.get(name) || name, value }));
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
        users: parts.users,
      },
      upsertSecrets: [...partsSecrets, ...replacementUpserts],
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
                const visibleUsers = splitDefaultUser(profile.users).otherUsers.length;
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
                        {profile.secrets.length} credential(s) · {profile.loginPlan ? "login sequence" : "no login"} · evidence: {profile.evidenceLevel.replace(/_/g, " ")}
                        {visibleUsers > 0 ? ` · ${visibleUsers} test user(s)` : ""}
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
              Changes apply to future runs. Saved values stay encrypted — type a new value to replace one.
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
              secretOptions={editParts(editing)
                .secrets.filter((secret) => !RESERVED_SECRET_NAMES.has(secret.secretName))
                .map((secret) => ({ name: secret.secretName, title: secret.title }))
                .concat(
                  editExistingExtras(editing)
                    .filter((secret) => !editing.removeSecretNames.includes(secret.secretName))
                    .map((secret) => ({ name: secret.secretName, title: secret.title || secret.secretName })),
                )}
              credentialTitles={[
                ...new Set([
                  ...editParts(editing).secrets.map((secret) => secret.title),
                  ...(editKeptExistingNames(editing).includes(DEFAULT_PASSWORD_SECRET) ? ["Default password"] : []),
                  ...(editKeptExistingNames(editing).includes(DEFAULT_OTP_SECRET) ? ["Default one-time code"] : []),
                  ...editExistingExtras(editing)
                    .filter((secret) => !editing.removeSecretNames.includes(secret.secretName))
                    .map((secret) => secret.title || secret.secretName),
                ]),
              ]}
              urlError={editUrlError}
              onValidateUrls={() => validateUrls(editing.draft, setEditUrlError)}
              signInStatus={{
                passwordSaved: editing.profile.secrets.some((secret) => secret.secretName === DEFAULT_PASSWORD_SECRET),
                otpSaved: editing.profile.secrets.some((secret) => secret.secretName === DEFAULT_OTP_SECRET),
                otpRemoved: editing.removeSecretNames.includes(DEFAULT_OTP_SECRET),
                onToggleRemoveOtp: () =>
                  setEditing((previous) => {
                    if (!previous) return previous;
                    const removing = !previous.removeSecretNames.includes(DEFAULT_OTP_SECRET);
                    return {
                      ...previous,
                      removeSecretNames: removing
                        ? [...previous.removeSecretNames, DEFAULT_OTP_SECRET]
                        : previous.removeSecretNames.filter((name) => name !== DEFAULT_OTP_SECRET),
                      // Removal wins: a value typed before clicking Remove
                      // must not resurrect the code on save.
                      draft: removing ? { ...previous.draft, defaultOtp: "" } : previous.draft,
                    };
                  }),
              }}
              existingCredentialsSlot={
                editExistingExtras(editing).length > 0 ? (
                  <ul className="space-y-1.5">
                    {editExistingExtras(editing).map((secret) => {
                      const removed = editing.removeSecretNames.includes(secret.secretName);
                      return (
                        <li
                          key={secret.secretName}
                          className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
                        >
                          <span className={`min-w-0 flex-1 truncate ${removed ? "line-through opacity-60" : ""}`}>
                            {secret.title || secret.secretName}
                            <span className="ml-2 text-xs text-muted-foreground">{secret.maskedPreview}</span>
                          </span>
                          {!removed ? (
                            <Input
                              type="password"
                              autoComplete="new-password"
                              className="h-8 w-44"
                              placeholder="New value (optional)"
                              value={editing.replacements[secret.secretName] ?? ""}
                              onChange={(event) =>
                                setEditing((previous) =>
                                  previous
                                    ? {
                                        ...previous,
                                        replacements: {
                                          ...previous.replacements,
                                          [secret.secretName]: event.target.value,
                                        },
                                      }
                                    : previous,
                                )
                              }
                              aria-label={`New value for ${secret.title || secret.secretName}`}
                            />
                          ) : null}
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
                ) : null
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
              secretOptions={
                oneTime
                  ? oneTimeParts(oneTime)
                      .secrets.filter((secret) => !RESERVED_SECRET_NAMES.has(secret.secretName))
                      .map((secret) => ({ name: secret.secretName, title: secret.title }))
                  : []
              }
              credentialTitles={oneTime ? oneTimeParts(oneTime).secrets.map((secret) => secret.title) : []}
              urlError={urlError}
              onValidateUrls={() =>
                oneTime &&
                validateUrls(
                  { ...oneTime, allowedOrigin: oneTime.allowedOrigin || safeOrigin(oneTime.initialUrl) },
                  setUrlError,
                )
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
 * and the edit-profile card render the same fields. Edit mode additionally
 * passes signInStatus (saved password/OTP indicators) and a slot listing
 * existing credentials.
 */
function EnvironmentConfigFields({
  config,
  onPatch,
  idPrefix,
  secretOptions,
  credentialTitles,
  urlError,
  onValidateUrls,
  signInStatus,
  existingCredentialsSlot,
}: {
  config: OneTimeEnvironmentState;
  onPatch: (patch: Partial<OneTimeEnvironmentState>) => void;
  idPrefix: string;
  /** Non-reserved credentials assignable to test users. */
  secretOptions: { name: string; title: string }[];
  /** Friendly labels for the step-editor hint. */
  credentialTitles: string[];
  urlError: string | null;
  onValidateUrls: () => void;
  signInStatus?: {
    passwordSaved: boolean;
    otpSaved: boolean;
    otpRemoved: boolean;
    onToggleRemoveOtp: () => void;
  };
  existingCredentialsSlot?: ReactNode;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  // null = "no explicit choice yet": open automatically while rows exist.
  const [showExtras, setShowExtras] = useState<boolean | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const extrasCount = config.secrets.length + (existingCredentialsSlot ? 1 : 0);
  const extrasOpen = showExtras ?? extrasCount > 0;
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

      <div className="space-y-2">
        <p className="text-sm font-medium">Sign-in details</p>
        <p className="text-xs text-muted-foreground">
          The AI uses these when a step logs in. Leave blank if the app has no login.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-signin-username`}>Username or email</Label>
            <Input
              id={`${idPrefix}-signin-username`}
              value={config.defaultUsername}
              maxLength={200}
              placeholder="admin@example.com"
              autoComplete="off"
              onChange={(event) => onPatch({ defaultUsername: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-signin-password`}>Password</Label>
            <div className="flex gap-1">
              <Input
                id={`${idPrefix}-signin-password`}
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={config.defaultPassword}
                placeholder={signInStatus?.passwordSaved ? "Saved — type to replace" : ""}
                onChange={(event) => onPatch({ defaultPassword: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((previous) => !previous)}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Encrypted — never shown to the AI or in reports.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-signin-otp`}>One-time code (optional)</Label>
            <Input
              id={`${idPrefix}-signin-otp`}
              type="password"
              autoComplete="off"
              value={config.defaultOtp}
              disabled={signInStatus?.otpRemoved}
              placeholder={
                signInStatus?.otpSaved && !signInStatus.otpRemoved ? "Saved — type to replace" : "e.g. a fixed staging OTP"
              }
              onChange={(event) => onPatch({ defaultOtp: event.target.value })}
            />
            {signInStatus?.otpSaved ? (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={signInStatus.onToggleRemoveOtp}
              >
                {signInStatus.otpRemoved ? "Keep the saved code" : "Remove the saved code"}
              </button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Only for apps with a fixed test code — real MFA blocks the run.
              </p>
            )}
          </div>
        </div>
      </div>

      <div>
        <button
          type="button"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setShowExtras(!extrasOpen)}
          aria-expanded={extrasOpen}
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${extrasOpen ? "rotate-180" : ""}`} aria-hidden />
          More credentials (optional){config.secrets.length > 0 ? ` — ${config.secrets.length} added` : ""}
        </button>
        {extrasOpen ? (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              Anything else the AI may need — an API key, a second password. Just give it a label; steps can mention it by
              that label.
            </p>
            {existingCredentialsSlot}
            <ExtraCredentialEditor
              idPrefix={idPrefix}
              secrets={config.secrets}
              onChange={(secrets) => onPatch({ secrets })}
            />
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Test users (optional)</p>
        <p className="text-xs text-muted-foreground">
          Extra accounts steps can name — e.g. &quot;Login as expired_user&quot;. Each uses the default password unless you
          pick another credential.
        </p>
        <TestUserListEditor
          idPrefix={idPrefix}
          users={config.users}
          secretOptions={secretOptions}
          onChange={(users) => onPatch({ users })}
        />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Login sequence (runs once per run, before any test case)</p>
        <TextStepEditor
          steps={config.loginSteps}
          onChange={(loginSteps) => onPatch({ loginSteps })}
          availableCredentialTitles={credentialTitles}
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

function ExtraCredentialEditor({
  idPrefix,
  secrets,
  onChange,
}: {
  idPrefix: string;
  secrets: { title: string; value: string }[];
  onChange: (secrets: { title: string; value: string }[]) => void;
}) {
  const [visible, setVisible] = useState<Record<number, boolean>>({});
  const update = (index: number, patch: Partial<{ title: string; value: string }>) => {
    onChange(secrets.map((secret, i) => (i === index ? { ...secret, ...patch } : secret)));
  };
  return (
    <div className="space-y-2">
      {secrets.map((secret, index) => (
        <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-extra-title-${index}`}>Label</Label>
            <Input
              id={`${idPrefix}-extra-title-${index}`}
              value={secret.title}
              maxLength={120}
              placeholder="e.g. Admin API key"
              onChange={(event) => update(index, { title: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-extra-value-${index}`}>Value (encrypted)</Label>
            <div className="flex gap-1">
              <Input
                id={`${idPrefix}-extra-value-${index}`}
                type={visible[index] ? "text" : "password"}
                autoComplete="new-password"
                value={secret.value}
                onChange={(event) => update(index, { value: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={visible[index] ? "Hide value" : "Show value"}
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
            aria-label={`Remove credential ${secret.title || index + 1}`}
            onClick={() => {
              // Visibility is index-keyed — reset it so deleting a row never
              // reveals the next row's value in cleartext.
              setVisible({});
              onChange(secrets.filter((_, i) => i !== index));
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...secrets, { title: "", value: "" }])}
      >
        <Plus className="mr-1 h-4 w-4" /> Add credential
      </Button>
    </div>
  );
}

const NO_USER_SECRET = "__default__";

function TestUserListEditor({
  idPrefix,
  users,
  secretOptions,
  onChange,
}: {
  idPrefix: string;
  users: TestUserDraft[];
  secretOptions: { name: string; title: string }[];
  onChange: (users: TestUserDraft[]) => void;
}) {
  const update = (index: number, patch: Partial<TestUserDraft>) => {
    onChange(users.map((user, i) => (i === index ? { ...user, ...patch } : user)));
  };
  const optionNames = new Set(secretOptions.map((option) => option.name));
  return (
    <div className="space-y-2">
      {users.map((user, index) => (
        <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-user-handle-${index}`}>Name used in steps</Label>
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
            <Label htmlFor={`${idPrefix}-user-secret-${index}`}>Password</Label>
            <Select
              value={user.passwordSecretName ?? NO_USER_SECRET}
              onValueChange={(value) => update(index, { passwordSecretName: value === NO_USER_SECRET ? null : value })}
            >
              <SelectTrigger id={`${idPrefix}-user-secret-${index}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_USER_SECRET}>Same as the default password</SelectItem>
                {secretOptions.map((option) => (
                  <SelectItem key={option.name} value={option.name}>
                    {option.title}
                  </SelectItem>
                ))}
                {user.passwordSecretName &&
                !optionNames.has(user.passwordSecretName) &&
                RESERVED_SECRET_NAMES.has(user.passwordSecretName) ? (
                  // A legacy pin to the reserved secrets is VALID — show it
                  // friendly, never as broken.
                  <SelectItem value={user.passwordSecretName}>
                    {user.passwordSecretName === DEFAULT_OTP_SECRET
                      ? "Default one-time code"
                      : "Default password (pinned)"}
                  </SelectItem>
                ) : null}
                {user.passwordSecretName &&
                !optionNames.has(user.passwordSecretName) &&
                !RESERVED_SECRET_NAMES.has(user.passwordSecretName) ? (
                  // Dangling reference stays VISIBLE (never silently cleared);
                  // save falls back to the default password unless re-linked.
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
