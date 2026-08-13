"use client";

import { useRef, useState, type ReactNode } from "react";
import { Braces, ChevronDown, Database, Eye, EyeOff, Monitor, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  API_CONNECTION_SECRET_NAMES,
  CONNECTION_SECRET_NAMES,
  DATABASE_PASSWORD_SECRET,
  RESERVED_SECRET_NAMES,
  apiAuthSecretName,
  buildConnectionSecrets,
  buildEnvironmentParts,
  clampEnvironmentLimits,
  connectionSecretNamesForConfig,
  databaseDefaultPort,
  defaultApiEnvironment,
  defaultDatabaseEnvironment,
  environmentReadinessIssue,
  environmentTargetLabels,
  environmentPartsLimitIssue,
  sanitizeHandle,
  splitDefaultUser,
  unknownStepSecrets,
  type ApiAuthConfig,
  type ApiEnvironmentConfig,
  type DatabaseEnvironmentConfig,
  type SecretPurpose,
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
  api: ApiEnvironmentConfig | null;
  database: DatabaseEnvironmentConfig | null;
  users: TestUserDraft[];
  secrets: { secretName: string; title: string; maskedPreview: string; purpose?: SecretPurpose }[];
  sessionCapturedAt: string | null;
  /** Version token compared at run creation — the profile the user reviewed. */
  updatedAt: string;
};

export type OneTimeEnvironmentState = {
  /** UI stays an explicit draft toggle; the legacy wire contract uses empty URLs when disabled. */
  uiEnabled: boolean;
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
  api: ApiEnvironmentConfig | null;
  /** Write-only and React-memory-only. It is moved into a purpose-scoped secret on submit. */
  apiSecret: string;
  database: DatabaseEnvironmentConfig | null;
  /** Write-only and React-memory-only. */
  databasePassword: string;
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
    uiEnabled: true,
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
    api: null,
    apiSecret: "",
    database: null,
    databasePassword: "",
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
    defaultUsername: config.uiEnabled ? config.defaultUsername : "",
    defaultPassword: config.uiEnabled ? config.defaultPassword : "",
    defaultOtp: config.uiEnabled ? config.defaultOtp : "",
    extras: config.secrets,
    users: config.uiEnabled ? config.users : [],
  });
}

/** Engine-facing secret names available for the current selection. */
export function environmentSecretNames(selection: EnvironmentSelection | null): string[] {
  if (!selection) return [];
  return selection.mode === "profile"
    ? selection.profile.secrets
        .filter((secret) => isAgentSecret(secret) && (selection.profile.initialUrl || !RESERVED_SECRET_NAMES.has(secret.secretName)))
        .map((secret) => secret.secretName)
    : oneTimeParts(selection.config).validSecretNames;
}

/** Friendly credential labels for hints ("Default password", "Admin API key"). */
export function environmentCredentialTitles(selection: EnvironmentSelection | null): string[] {
  if (!selection) return [];
  if (selection.mode === "profile") {
    return selection.profile.secrets
      .filter((secret) => isAgentSecret(secret) && (selection.profile.initialUrl || !RESERVED_SECRET_NAMES.has(secret.secretName)))
      .map((secret) => secret.title || secret.secretName);
  }
  return oneTimeParts(selection.config).secrets.map((secret) => secret.title);
}

export function environmentAllowedOrigin(selection: EnvironmentSelection | null): string {
  if (!selection) return "";
  if (selection.mode === "profile") return selection.profile.allowedOrigin;
  return selection.config.uiEnabled
    ? selection.config.allowedOrigin || safeOrigin(selection.config.initialUrl)
    : "";
}

export function environmentTargets(selection: EnvironmentSelection | null): Array<"UI" | "API" | "DB"> {
  if (!selection) return [];
  const target = selection.mode === "profile" ? selection.profile : selection.config;
  return environmentTargetLabels({
    initialUrl: selection.mode === "one_time" && !selection.config.uiEnabled ? "" : target.initialUrl,
    api: target.api,
    database: target.database,
  });
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
    api: ApiEnvironmentConfig | null;
    database: DatabaseEnvironmentConfig | null;
    users: TestUserDraft[];
  };
  upsertSecrets: { secretName: string; title: string; value: string; purpose?: SecretPurpose }[];
  removeSecretNames: string[];
};

function profileToDraft(profile: EnvironmentProfileSummary): OneTimeEnvironmentState {
  const { defaultUsername, otherUsers } = splitDefaultUser(profile.users);
  return {
    uiEnabled: Boolean(profile.initialUrl),
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
    api: profile.api,
    apiSecret: "",
    database: profile.database,
    databasePassword: "",
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
  capabilitiesPanel,
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
  capabilitiesPanel?: ReactNode;
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
    setUrlError(null);
    onSelectionChange({ mode: "one_time", config: { ...base, ...patch } });
  };

  const setEditDraft = (patch: Partial<OneTimeEnvironmentState>) => {
    setEditUrlError(null);
    setEditing((previous) => (previous ? { ...previous, draft: { ...previous.draft, ...patch } } : previous));
  };

  const validateTargets = (
    config: OneTimeEnvironmentState,
    report: (message: string | null) => void,
    profile?: EnvironmentProfileSummary,
    removedNames: string[] = [],
  ): boolean => {
    const activeApiSecret = config.api ? apiAuthSecretName(config.api.auth) : null;
    const issue = environmentReadinessIssue({
      initialUrl: config.uiEnabled ? config.initialUrl : "",
      allowedOrigin: config.uiEnabled ? config.allowedOrigin : "",
      api: config.api,
      apiSecret: config.apiSecret,
      apiSecretSaved: Boolean(
        activeApiSecret &&
          profile?.secrets.some(
            (secret) => secret.secretName === activeApiSecret && !removedNames.includes(secret.secretName),
          ),
      ),
      database: config.database,
      databasePassword: config.databasePassword,
      databasePasswordSaved: Boolean(
        profile?.secrets.some(
          (secret) => secret.secretName === DATABASE_PASSWORD_SECRET && !removedNames.includes(secret.secretName),
        ),
      ),
    });
    report(issue);
    return issue === null;
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
    state.profile.secrets.filter(
      (secret) => isAgentSecret(secret) && !RESERVED_SECRET_NAMES.has(secret.secretName),
    );

  /** Names that survive this edit (kept existing, before new additions). */
  const editKeptExistingNames = (state: ProfileEditState) =>
    state.profile.secrets
      .filter(isAgentSecret)
      .map((secret) => secret.secretName)
      .filter((name) => state.draft.uiEnabled || !RESERVED_SECRET_NAMES.has(name))
      .filter((name) => !state.removeSecretNames.includes(name));

  const editParts = (state: ProfileEditState) =>
    buildEnvironmentParts({
      defaultUsername: state.draft.uiEnabled ? state.draft.defaultUsername : "",
      defaultPassword: state.draft.uiEnabled ? state.draft.defaultPassword : "",
      defaultOtp: state.draft.uiEnabled ? state.draft.defaultOtp : "",
      extras: state.draft.secrets,
      users: state.draft.uiEnabled ? state.draft.users : [],
      existingSecretNames: editKeptExistingNames(state),
      defaultUserSeed: state.defaultUserSeed,
    });

  const saveProfileEdits = async () => {
    if (!editing) return;
    const draft = clampEnvironmentLimits(editing.draft);
    if (!validateTargets(draft, setEditUrlError, editing.profile, editing.removeSecretNames)) return;
    const state = { ...editing, draft };
    const parts = editParts(state);
    // A removal marked in the UI must win over any value still sitting in a
    // field — never send the same name as both an upsert and a removal.
    const partsSecrets = parts.secrets.filter((secret) => !editing.removeSecretNames.includes(secret.secretName));
    const connectionUpserts = buildConnectionSecrets(draft);
    const requiredConnectionNames = new Set(connectionSecretNamesForConfig(draft));
    const implicitConnectionRemovals = CONNECTION_SECRET_NAMES.filter(
      (name) =>
        editing.profile.secrets.some((secret) => secret.secretName === name) && !requiredConnectionNames.has(name),
    );
    const implicitUiCredentialRemovals = draft.uiEnabled
      ? []
      : editing.profile.secrets
          .map((secret) => secret.secretName)
          .filter((name) => RESERVED_SECRET_NAMES.has(name));
    const removeSecretNames = [
      ...new Set([...editing.removeSecretNames, ...implicitConnectionRemovals, ...implicitUiCredentialRemovals]),
    ];
    const keptExistingNames = editing.profile.secrets
      .map((secret) => secret.secretName)
      .filter((name) => !removeSecretNames.includes(name));
    const limitIssue = environmentPartsLimitIssue(
      { ...parts, secrets: [...partsSecrets, ...connectionUpserts] },
      keptExistingNames,
    );
    if (limitIssue) {
      toast.error(limitIssue);
      return;
    }
    const unknownTokens = draft.uiEnabled ? unknownStepSecrets(draft.loginSteps, parts.validSecretNames) : [];
    if (unknownTokens.length > 0) {
      toast.warning(
        `The login sequence mentions credential(s) that will not exist after saving: ${unknownTokens.join(", ")}. Runs may block at login.`,
      );
    }
    const existingTitles = new Map(editing.profile.secrets.map((secret) => [secret.secretName, secret.title]));
    const replacementUpserts = Object.entries(editing.replacements)
      .filter(([name, value]) => value && !editing.removeSecretNames.includes(name))
      .map(([name, value]) => ({ secretName: name, title: existingTitles.get(name) || name, value }));
    const upsertNames = new Set(connectionUpserts.map((secret) => secret.secretName));
    const saved = await onUpdateProfile(editing.profile.id, {
      config: {
        name: editing.name.trim(),
        initialUrl: draft.uiEnabled ? draft.initialUrl : "",
        allowedOrigin: draft.uiEnabled ? draft.allowedOrigin || safeOrigin(draft.initialUrl) : "",
        viewportWidth: draft.viewportWidth,
        viewportHeight: draft.viewportHeight,
        headless: draft.headless,
        defaultTimeoutMs: draft.defaultTimeoutMs,
        navigationTimeoutMs: draft.navigationTimeoutMs,
        evidenceLevel: draft.evidenceLevel,
        loginPlan: draft.uiEnabled ? buildNaturalPlan(draft.loginSteps) : null,
        loginMode: draft.loginMode,
        loggedInText: draft.loggedInText.trim(),
        executionNotes: draft.executionNotes.trim(),
        api: draft.api,
        database: draft.database,
        users: parts.users,
      },
      upsertSecrets: [...partsSecrets, ...replacementUpserts, ...connectionUpserts],
      removeSecretNames: removeSecretNames.filter((name) => !upsertNames.has(name)),
    });
    if (saved) {
      setEditing(null);
      setEditUrlError(null);
    }
  };

  const readyToContinue =
    selection?.mode === "profile" ||
    (oneTime !== null &&
      environmentReadinessIssue({
        initialUrl: oneTime.uiEnabled ? oneTime.initialUrl : "",
        allowedOrigin: oneTime.uiEnabled ? oneTime.allowedOrigin : "",
        api: oneTime.api,
        apiSecret: oneTime.apiSecret,
        database: oneTime.database,
        databasePassword: oneTime.databasePassword,
      }) === null);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Saved environment profiles</CardTitle>
          <CardDescription>
            Keep the web app, API, and database for a deployment together so every layer of a test reaches the same data.
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
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{profile.name}</span>
                        {environmentTargetLabels(profile).map((target) => (
                          <Badge key={target} variant="outline" className="h-4 px-1.5 text-[10px]">{target}</Badge>
                        ))}
                      </span>
                      <p className="truncate text-xs text-muted-foreground">{profileTargetSummary(profile)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {profile.secrets.length} encrypted credential(s) · {profile.loginPlan ? "login sequence" : "no login"} · evidence: {profile.evidenceLevel.replace(/_/g, " ")}
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
          {selection?.mode === "profile" && selection.profile.initialUrl && selection.profile.sessionCapturedAt ? (
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
              onValidateTargets={() =>
                validateTargets(editing.draft, setEditUrlError, editing.profile, editing.removeSecretNames)
              }
              savedConnectionSecretNames={editing.profile.secrets.map((secret) => secret.secretName)}
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
                disabled={updatingProfile || !editing.name.trim()}
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
              onValidateTargets={() =>
                oneTime &&
                validateTargets(
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
                  disabled={saving || !profileName.trim() || !readyToContinue}
                  onClick={() => {
                    if (!validateTargets(oneTime, setUrlError)) return;
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

      {capabilitiesPanel}

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
  onValidateTargets,
  savedConnectionSecretNames = [],
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
  onValidateTargets: () => void;
  /** Names only, never values; used to render safe "saved" placeholders. */
  savedConnectionSecretNames?: string[];
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
  const lastApiRef = useRef<ApiEnvironmentConfig>(config.api ?? defaultApiEnvironment());
  const lastDatabaseRef = useRef<DatabaseEnvironmentConfig>(config.database ?? defaultDatabaseEnvironment());
  if (config.api) lastApiRef.current = config.api;
  if (config.database) lastDatabaseRef.current = config.database;
  const savedConnectionNames = new Set(savedConnectionSecretNames);
  const extrasCount = config.secrets.length + (existingCredentialsSlot ? 1 : 0);
  const extrasOpen = showExtras ?? extrasCount > 0;
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Execution targets</legend>
        <p className="text-xs text-muted-foreground">Enable any combination. One test step can switch layers when its work requires it.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <TargetToggle
            id={`${idPrefix}-target-ui`}
            icon={<Monitor className="h-4 w-4" aria-hidden />}
            label="Web application"
            description="Browser and UI actions"
            checked={config.uiEnabled}
            onCheckedChange={(checked) => onPatch({ uiEnabled: checked })}
          />
          <TargetToggle
            id={`${idPrefix}-target-api`}
            icon={<Braces className="h-4 w-4" aria-hidden />}
            label="API"
            description="HTTP requests and contracts"
            checked={config.api !== null}
            onCheckedChange={(checked) => onPatch({ api: checked ? lastApiRef.current : null, apiSecret: "" })}
          />
          <TargetToggle
            id={`${idPrefix}-target-db`}
            icon={<Database className="h-4 w-4" aria-hidden />}
            label="Database"
            description="Queries and approved DML"
            checked={config.database !== null}
            onCheckedChange={(checked) =>
              onPatch({ database: checked ? lastDatabaseRef.current : null, databasePassword: "" })
            }
          />
        </div>
      </fieldset>

      {config.uiEnabled ? (
        <section className="space-y-3 rounded-lg border p-3" aria-labelledby={`${idPrefix}-ui-heading`}>
          <div>
            <h3 id={`${idPrefix}-ui-heading`} className="flex items-center gap-2 text-sm font-medium">
              <Monitor className="h-4 w-4" aria-hidden /> Web application
            </h3>
            <p className="text-xs text-muted-foreground">The browser remains inside the allowed origin.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-initial-url`}>Initial URL</Label>
              <Input
                id={`${idPrefix}-initial-url`}
                value={config.initialUrl}
                placeholder="https://app.example.com/login"
                onChange={(event) => onPatch({ initialUrl: event.target.value })}
                onBlur={onValidateTargets}
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
                onBlur={onValidateTargets}
              />
              <p className="text-xs text-muted-foreground">Navigation outside this origin is blocked at run time.</p>
            </div>
          </div>
        </section>
      ) : null}

      {config.api ? (
        <ApiTargetFields
          idPrefix={idPrefix}
          value={config.api}
          secretValue={config.apiSecret}
          secretSaved={Boolean(apiAuthSecretName(config.api.auth) && savedConnectionNames.has(apiAuthSecretName(config.api.auth)!))}
          onChange={(api) => onPatch({ api })}
          onSecretChange={(apiSecret) => onPatch({ apiSecret })}
          onBlur={onValidateTargets}
        />
      ) : null}

      {config.database ? (
        <DatabaseTargetFields
          idPrefix={idPrefix}
          value={config.database}
          password={config.databasePassword}
          passwordSaved={savedConnectionNames.has(DATABASE_PASSWORD_SECRET)}
          onChange={(database) => onPatch({ database })}
          onPasswordChange={(databasePassword) => onPatch({ databasePassword })}
          onBlur={onValidateTargets}
        />
      ) : null}

      {urlError ? (
        <p className="text-sm text-destructive" role="alert">{urlError}</p>
      ) : null}

      {config.uiEnabled ? (
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
      ) : null}

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
              Agent-visible test values such as a second account password or fixed reference ID. API and database
              connection credentials belong in their protected target fields above.
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

      {config.uiEnabled ? (
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
      ) : null}

      {config.uiEnabled ? (
      <div className="space-y-2">
        <p className="text-sm font-medium">Login sequence (runs once per run, before any test case)</p>
        <TextStepEditor
          steps={config.loginSteps}
          onChange={(loginSteps) => onPatch({ loginSteps })}
          availableCredentialTitles={credentialTitles}
          idPrefix={`${idPrefix}-login`}
          showLayerHint={false}
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
      ) : null}

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
            {config.uiEnabled ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-viewport-w`}>Viewport width</Label>
                  <Input id={`${idPrefix}-viewport-w`} inputMode="numeric" value={config.viewportWidth} onChange={(event) => onPatch({ viewportWidth: Number(event.target.value) || 1280 })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-viewport-h`}>Viewport height</Label>
                  <Input id={`${idPrefix}-viewport-h`} inputMode="numeric" value={config.viewportHeight} onChange={(event) => onPatch({ viewportHeight: Number(event.target.value) || 720 })} />
                </div>
              </>
            ) : null}
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
            {config.uiEnabled ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-timeout`}>Browser action timeout (ms)</Label>
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
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TargetToggle({
  id,
  icon,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string;
  icon: ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 transition-colors ${
        checked ? "border-primary bg-primary/5" : "hover:bg-muted/50"
      }`}
    >
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 font-medium">{icon}{label}</span>
        <span className="block text-xs font-normal text-muted-foreground">{description}</span>
      </span>
    </Label>
  );
}

function ApiTargetFields({
  idPrefix,
  value,
  secretValue,
  secretSaved,
  onChange,
  onSecretChange,
  onBlur,
}: {
  idPrefix: string;
  value: ApiEnvironmentConfig;
  secretValue: string;
  secretSaved: boolean;
  onChange: (value: ApiEnvironmentConfig) => void;
  onSecretChange: (value: string) => void;
  onBlur: () => void;
}) {
  const [showSecret, setShowSecret] = useState(false);
  const authSecretName = apiAuthSecretName(value.auth);
  const apiKeyAuth = value.auth.type === "api_key" ? value.auth : null;
  const basicAuth = value.auth.type === "basic" ? value.auth : null;
  const oauthAuth = value.auth.type === "oauth2_client_credentials" ? value.auth : null;
  const setAuthType = (type: ApiAuthConfig["type"]) => {
    const auth: ApiAuthConfig =
      type === "none"
        ? { type: "none" }
        : type === "bearer"
          ? { type: "bearer" }
          : type === "api_key"
            ? { type: "api_key", location: "header", name: "X-API-Key" }
            : type === "basic"
              ? { type: "basic", username: "" }
              : { type: "oauth2_client_credentials", tokenUrl: "", clientId: "", scopes: [] };
    onSecretChange("");
    onChange({ ...value, auth });
  };
  const contractKind = value.contract?.kind ?? "none";

  return (
    <section className="space-y-3 rounded-lg border p-3" aria-labelledby={`${idPrefix}-api-heading`}>
      <div>
        <h3 id={`${idPrefix}-api-heading`} className="flex items-center gap-2 text-sm font-medium">
          <Braces className="h-4 w-4" aria-hidden /> API connection
        </h3>
        <p className="text-xs text-muted-foreground">Requests use relative paths under this base URL. Credentials never enter the AI prompt.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-api-base-url`}>Base URL</Label>
          <Input
            id={`${idPrefix}-api-base-url`}
            value={value.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => onChange({ ...value, baseUrl: event.target.value })}
            onBlur={onBlur}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-api-auth`}>Authentication</Label>
          <Select value={value.auth.type} onValueChange={(type) => setAuthType(type as ApiAuthConfig["type"])}>
            <SelectTrigger id={`${idPrefix}-api-auth`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="bearer">Bearer token</SelectItem>
              <SelectItem value="api_key">API key</SelectItem>
              <SelectItem value="basic">Basic authentication</SelectItem>
              <SelectItem value="oauth2_client_credentials">OAuth 2 client credentials</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {apiKeyAuth ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-api-key-name`}>Key name</Label>
              <Input
                id={`${idPrefix}-api-key-name`}
                value={apiKeyAuth.name}
                placeholder="X-API-Key"
                onChange={(event) => onChange({ ...value, auth: { ...apiKeyAuth, name: event.target.value } })}
                onBlur={onBlur}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-api-key-location`}>Send key in</Label>
              <Select
                value={apiKeyAuth.location}
                onValueChange={(location) =>
                  onChange({ ...value, auth: { ...apiKeyAuth, location: location as "header" | "query" } })
                }
              >
                <SelectTrigger id={`${idPrefix}-api-key-location`}><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="header">Header</SelectItem><SelectItem value="query">Query parameter</SelectItem></SelectContent>
              </Select>
            </div>
          </>
        ) : null}

        {basicAuth ? (
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-api-basic-user`}>API username</Label>
            <Input
              id={`${idPrefix}-api-basic-user`}
              value={basicAuth.username}
              autoComplete="off"
              onChange={(event) => onChange({ ...value, auth: { ...basicAuth, username: event.target.value } })}
              onBlur={onBlur}
            />
          </div>
        ) : null}

        {oauthAuth ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-api-oauth-token-url`}>Token URL</Label>
              <Input
                id={`${idPrefix}-api-oauth-token-url`}
                value={oauthAuth.tokenUrl}
                placeholder="https://identity.example.com/oauth/token"
                onChange={(event) => onChange({ ...value, auth: { ...oauthAuth, tokenUrl: event.target.value } })}
                onBlur={onBlur}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-api-oauth-client-id`}>Client ID</Label>
              <Input
                id={`${idPrefix}-api-oauth-client-id`}
                value={oauthAuth.clientId}
                autoComplete="off"
                onChange={(event) => onChange({ ...value, auth: { ...oauthAuth, clientId: event.target.value } })}
                onBlur={onBlur}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-api-oauth-scopes`}>Scopes</Label>
              <Input
                id={`${idPrefix}-api-oauth-scopes`}
                value={oauthAuth.scopes.join(" ")}
                placeholder="orders.read orders.write"
                onChange={(event) =>
                  onChange({ ...value, auth: { ...oauthAuth, scopes: splitList(event.target.value) } })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-api-oauth-audience`}>Audience (optional)</Label>
              <Input
                id={`${idPrefix}-api-oauth-audience`}
                value={oauthAuth.audience ?? ""}
                onChange={(event) =>
                  onChange({ ...value, auth: { ...oauthAuth, audience: event.target.value || undefined } })
                }
              />
            </div>
          </>
        ) : null}

        {authSecretName ? (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${idPrefix}-api-secret`}>{apiSecretFieldLabel(value.auth)}</Label>
            <div className="flex gap-1 sm:max-w-md">
              <Input
                id={`${idPrefix}-api-secret`}
                type={showSecret ? "text" : "password"}
                autoComplete="new-password"
                value={secretValue}
                placeholder={secretSaved ? "Saved — type to replace" : "Required"}
                onChange={(event) => onSecretChange(event.target.value)}
                onBlur={onBlur}
              />
              <Button type="button" variant="ghost" size="icon" aria-label={showSecret ? "Hide API credential" : "Show API credential"} onClick={() => setShowSecret((current) => !current)}>
                {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Encrypted and passed directly to the API executor; never exposed as an agent credential.</p>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-api-contract`}>API definition</Label>
          <p className="text-xs text-muted-foreground">Add a Swagger or OpenAPI JSON URL to discover documented API endpoints for this run.</p>
          <Select
            value={contractKind}
            onValueChange={(kind) =>
              onChange({
                ...value,
                contract:
                  kind === "none"
                    ? null
                    : kind === "revision"
                      ? value.contract?.kind === "revision" ? value.contract : { kind: "revision", revisionId: "" }
                      : { kind: "same_origin_url", url: "" },
              })
            }
          >
            <SelectTrigger id={`${idPrefix}-api-contract`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No API definition</SelectItem>
              <SelectItem value="same_origin_url">Swagger / OpenAPI URL</SelectItem>
              {contractKind === "revision" ? <SelectItem value="revision">Approved revision</SelectItem> : null}
            </SelectContent>
          </Select>
        </div>
        {value.contract?.kind === "same_origin_url" ? (
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-api-contract-url`}>Swagger / OpenAPI URL</Label>
            <Input
              id={`${idPrefix}-api-contract-url`}
              value={value.contract.url}
              placeholder="https://api.example.com/openapi.json"
              onChange={(event) => onChange({ ...value, contract: { kind: "same_origin_url", url: event.target.value } })}
              onBlur={onBlur}
            />
            <p className="text-xs text-muted-foreground">For example: https://api.example.com/openapi.json. It must use the same origin as the API base URL.</p>
          </div>
        ) : value.contract?.kind === "revision" ? (
          <div className="space-y-1.5">
            <Label>Approved revision</Label>
            <Input value={value.contract.revisionId} disabled aria-label="Approved API contract revision" />
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-api-timeout`}>Request timeout (ms)</Label>
          <Input
            id={`${idPrefix}-api-timeout`}
            inputMode="numeric"
            value={value.requestTimeoutMs}
            onChange={(event) => onChange({ ...value, requestTimeoutMs: Number(event.target.value) || 30_000 })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-api-mutations`}>Mutation access</Label>
          <Select
            value={value.mutationMode}
            onValueChange={(mutationMode) =>
              onChange({ ...value, mutationMode: mutationMode as ApiEnvironmentConfig["mutationMode"] })
            }
          >
            <SelectTrigger id={`${idPrefix}-api-mutations`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="disabled">Read operations only</SelectItem>
              <SelectItem value="approved_catalog">Approved catalog mutations</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </section>
  );
}

function DatabaseTargetFields({
  idPrefix,
  value,
  password,
  passwordSaved,
  onChange,
  onPasswordChange,
  onBlur,
}: {
  idPrefix: string;
  value: DatabaseEnvironmentConfig;
  password: string;
  passwordSaved: boolean;
  onChange: (value: DatabaseEnvironmentConfig) => void;
  onPasswordChange: (value: string) => void;
  onBlur: () => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const setDriver = (driver: DatabaseEnvironmentConfig["driver"]) => {
    const defaults = defaultDatabaseEnvironment(driver);
    onChange({ ...value, driver, port: databaseDefaultPort(driver), schemas: defaults.schemas });
  };
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-labelledby={`${idPrefix}-db-heading`}>
      <div>
        <h3 id={`${idPrefix}-db-heading`} className="flex items-center gap-2 text-sm font-medium">
          <Database className="h-4 w-4" aria-hidden /> Database connection
        </h3>
        <p className="text-xs text-muted-foreground">Use a dedicated least-privilege test account. DDL and multi-statement SQL are always blocked.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-db-driver`}>Driver</Label>
          <Select value={value.driver} onValueChange={(driver) => setDriver(driver as DatabaseEnvironmentConfig["driver"])}>
            <SelectTrigger id={`${idPrefix}-db-driver`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="postgres">PostgreSQL</SelectItem>
              <SelectItem value="sqlserver">SQL Server</SelectItem>
              <SelectItem value="mysql">MySQL</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 lg:col-span-2">
          <Label htmlFor={`${idPrefix}-db-host`}>Host or IP address</Label>
          <Input
            id={`${idPrefix}-db-host`}
            value={value.host}
            placeholder="db.staging.internal"
            onChange={(event) => onChange({ ...value, host: event.target.value })}
            onBlur={onBlur}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-db-port`}>Port</Label>
          <Input
            id={`${idPrefix}-db-port`}
            inputMode="numeric"
            value={value.port}
            onChange={(event) => onChange({ ...value, port: Number(event.target.value) || 0 })}
            onBlur={onBlur}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-db-name`}>Database name</Label>
          <Input
            id={`${idPrefix}-db-name`}
            value={value.databaseName}
            placeholder="itestflow_qa"
            onChange={(event) => {
              const databaseName = event.target.value;
              const tracksMysqlDatabase = value.driver === "mysql" &&
                (value.schemas.length === 0 || (value.schemas.length === 1 && value.schemas[0] === value.databaseName));
              onChange({ ...value, databaseName, schemas: tracksMysqlDatabase && databaseName ? [databaseName] : value.schemas });
            }}
            onBlur={onBlur}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-db-user`}>Username</Label>
          <Input
            id={`${idPrefix}-db-user`}
            value={value.username}
            autoComplete="off"
            onChange={(event) => onChange({ ...value, username: event.target.value })}
            onBlur={onBlur}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
          <Label htmlFor={`${idPrefix}-db-password`}>Password</Label>
          <div className="flex gap-1 sm:max-w-md">
            <Input
              id={`${idPrefix}-db-password`}
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              value={password}
              placeholder={passwordSaved ? "Saved — type to replace" : "Required"}
              onChange={(event) => onPasswordChange(event.target.value)}
              onBlur={onBlur}
            />
            <Button type="button" variant="ghost" size="icon" aria-label={showPassword ? "Hide database password" : "Show database password"} onClick={() => setShowPassword((current) => !current)}>
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Encrypted and passed directly to the database driver; never shown to the AI.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-db-tls`}>TLS</Label>
          <Select value={value.tlsMode} onValueChange={(tlsMode) => onChange({ ...value, tlsMode: tlsMode as DatabaseEnvironmentConfig["tlsMode"] })}>
            <SelectTrigger id={`${idPrefix}-db-tls`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="verify-full">Verify certificate and host</SelectItem>
              <SelectItem value="require">Require encryption</SelectItem>
              <SelectItem value="disable">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-db-access`}>Query access</Label>
          <Select value={value.accessMode} onValueChange={(accessMode) => onChange({ ...value, accessMode: accessMode as DatabaseEnvironmentConfig["accessMode"] })}>
            <SelectTrigger id={`${idPrefix}-db-access`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="read_only">Read-only</SelectItem>
              <SelectItem value="cataloged_dml">Approved catalog DML</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-db-schemas`}>Allowed schemas</Label>
          <Input
            id={`${idPrefix}-db-schemas`}
            value={value.schemas.join(", ")}
            placeholder={value.driver === "sqlserver" ? "dbo" : value.driver === "postgres" ? "public" : "Defaults to database name"}
            onChange={(event) => onChange({ ...value, schemas: splitList(event.target.value) })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-db-connect-timeout`}>Connect timeout (ms)</Label>
          <Input id={`${idPrefix}-db-connect-timeout`} inputMode="numeric" value={value.connectTimeoutMs} onChange={(event) => onChange({ ...value, connectTimeoutMs: Number(event.target.value) || 10_000 })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-db-statement-timeout`}>Statement timeout (ms)</Label>
          <Input id={`${idPrefix}-db-statement-timeout`} inputMode="numeric" value={value.statementTimeoutMs} onChange={(event) => onChange({ ...value, statementTimeoutMs: Number(event.target.value) || 30_000 })} />
        </div>
      </div>
    </section>
  );
}

function apiSecretFieldLabel(auth: ApiAuthConfig): string {
  return auth.type === "bearer"
    ? "Bearer token"
    : auth.type === "api_key"
      ? "API key value"
      : auth.type === "basic"
        ? "API password"
        : "OAuth client secret";
}

function splitList(value: string): string[] {
  return value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
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

function isAgentSecret(secret: { secretName: string; purpose?: SecretPurpose }): boolean {
  return (secret.purpose ?? "agent_value") === "agent_value" &&
    !API_CONNECTION_SECRET_NAMES.includes(secret.secretName as (typeof API_CONNECTION_SECRET_NAMES)[number]) &&
    secret.secretName !== DATABASE_PASSWORD_SECRET;
}

function profileTargetSummary(profile: EnvironmentProfileSummary): string {
  const targets = [
    profile.initialUrl,
    profile.api?.baseUrl,
    profile.database ? `${profile.database.driver}://${profile.database.host}:${profile.database.port}/${profile.database.databaseName}` : null,
  ].filter((value): value is string => Boolean(value));
  return targets.join(" · ") || "No configured target";
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
