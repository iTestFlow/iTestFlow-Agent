import "server-only";

import { z } from "zod";
import { DEFAULT_CONTEXT_STATES, DEFAULT_CONTEXT_WORK_ITEM_TYPES } from "@/lib/project-context-defaults";
import { DEFAULT_AUTO_UPDATE_CRON_EXPRESSION } from "./cron-expression";
import { RuntimeSettingsInputSchema, type RuntimeSettings, type RuntimeSettingsInput, type RuntimeSettingsSummary } from "./runtime-settings.schema";

type CryptoModule = typeof import("crypto");
type FsModule = typeof import("fs");
type PathModule = typeof import("path");

const settingsPath = () => getPath().join(process.cwd(), "data", "runtime-settings.json");
const keyPath = () => getPath().join(process.cwd(), "data", ".runtime-settings-key");

type PersistedSettings = {
  version: 1;
  savedAt: string;
  encryptedPayload: string;
};

const RuntimeSettingsSchema = RuntimeSettingsInputSchema.extend({
  savedAt: z.string(),
});

export function saveRuntimeSettings(input: RuntimeSettingsInput): RuntimeSettingsSummary {
  const parsed = RuntimeSettingsInputSchema.parse(input);
  const settings: RuntimeSettings = {
    ...parsed,
    savedAt: new Date().toISOString(),
  };
  const path = settingsPath();
  const fs = getFs();
  const pathModule = getPath();
  fs.mkdirSync(pathModule.dirname(path), { recursive: true });
  fs.writeFileSync(
    path,
    JSON.stringify(
      {
        version: 1,
        savedAt: settings.savedAt,
        encryptedPayload: encrypt(JSON.stringify(settings)),
      } satisfies PersistedSettings,
      null,
      2,
    ),
    "utf8",
  );

  return summarizeRuntimeSettings(settings);
}

export function getRuntimeSettings(): RuntimeSettings | null {
  const path = settingsPath();
  const fs = getFs();
  if (!fs.existsSync(path)) return null;

  try {
    const persisted = JSON.parse(fs.readFileSync(path, "utf8")) as PersistedSettings;
    const decrypted = decrypt(persisted.encryptedPayload);
    return RuntimeSettingsSchema.parse(JSON.parse(decrypted));
  } catch {
    return null;
  }
}

export function getRuntimeSettingsSummary(): RuntimeSettingsSummary {
  const settings = getRuntimeSettings();
  if (!settings) {
    return summarizeEnvSettings();
  }
  return summarizeRuntimeSettings(settings);
}

export function getEffectiveRuntimeSettings(): RuntimeSettings | null {
  return getRuntimeSettings() ?? getSettingsFromEnv();
}

function summarizeRuntimeSettings(settings: RuntimeSettings): RuntimeSettingsSummary {
  return {
    configured: true,
    savedAt: settings.savedAt,
    azureDevOps: {
      organizationUrl: settings.azureDevOps.organizationUrl,
      hasPersonalAccessToken: Boolean(settings.azureDevOps.personalAccessToken),
    },
    llm: {
      provider: settings.llm.provider,
      model: settings.llm.model,
      baseUrl: settings.llm.baseUrl,
      hasApiKey: Boolean(settings.llm.apiKey),
      temperature: settings.llm.temperature,
      maxTokens: settings.llm.maxTokens,
      retryAttempts: settings.llm.retryAttempts,
    },
    context: {
      retrievalTopK: settings.context.retrievalTopK,
      autoUpdate: {
        enabled: settings.context.autoUpdate.enabled,
        cronExpression: settings.context.autoUpdate.cronExpression,
        projectScope: settings.context.autoUpdate.projectScope,
        workItemTypes: settings.context.autoUpdate.workItemTypes,
        states: settings.context.autoUpdate.states,
      },
    },
  };
}

function summarizeEnvSettings(): RuntimeSettingsSummary {
  const settings = getSettingsFromEnv();
  if (!settings) return { configured: false };
  return summarizeRuntimeSettings(settings);
}

function getSettingsFromEnv(): RuntimeSettings | null {
  const provider = process.env.DEFAULT_LLM_PROVIDER;
  if (!process.env.AZURE_DEVOPS_ORG_URL || !process.env.AZURE_DEVOPS_PAT || !provider) return null;
  if (!["openai", "gemini", "anthropic"].includes(provider)) return null;

  const apiKey =
    provider === "openai"
      ? process.env.OPENAI_API_KEY
      : provider === "gemini"
        ? process.env.GEMINI_API_KEY
      : process.env.ANTHROPIC_API_KEY;

  const model =
    provider === "openai"
      ? process.env.OPENAI_MODEL
      : provider === "gemini"
        ? process.env.GEMINI_MODEL
      : process.env.ANTHROPIC_MODEL;

  if (!model) return null;

  const parsed = RuntimeSettingsInputSchema.safeParse({
    azureDevOps: {
      organizationUrl: process.env.AZURE_DEVOPS_ORG_URL,
      personalAccessToken: process.env.AZURE_DEVOPS_PAT,
    },
    llm: {
      provider,
      model,
      apiKey,
      baseUrl: undefined,
      temperature: Number(process.env.LLM_TEMPERATURE ?? "0.2"),
      maxTokens: Number(process.env.LLM_MAX_TOKENS ?? "4000"),
      retryAttempts: Number(process.env.LLM_RETRY_ATTEMPTS ?? "1"),
    },
    context: {
      retrievalTopK: Number(process.env.PROJECT_CONTEXT_TOP_K ?? "8"),
      autoUpdate: {
        enabled: false,
        cronExpression: DEFAULT_AUTO_UPDATE_CRON_EXPRESSION,
        projectScope: null,
        workItemTypes: DEFAULT_CONTEXT_WORK_ITEM_TYPES,
        states: DEFAULT_CONTEXT_STATES,
      },
    },
  });

  if (!parsed.success) return null;
  return {
    ...parsed.data,
    savedAt: "env",
  };
}

function getOrCreateKey() {
  const path = keyPath();
  const fs = getFs();
  const pathModule = getPath();
  fs.mkdirSync(pathModule.dirname(path), { recursive: true });
  if (fs.existsSync(path)) return Buffer.from(fs.readFileSync(path, "utf8"), "base64");
  const key = getCrypto().randomBytes(32);
  fs.writeFileSync(path, key.toString("base64"), "utf8");
  return key;
}

function encrypt(value: string) {
  const { createCipheriv, randomBytes } = getCrypto();
  const key = getOrCreateKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(value: string) {
  const { createDecipheriv } = getCrypto();
  const payload = Buffer.from(value, "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getOrCreateKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function getCrypto() {
  return nativeRequire("crypto") as CryptoModule;
}

function getFs() {
  return nativeRequire("fs") as FsModule;
}

function getPath() {
  return nativeRequire("path") as PathModule;
}

function nativeRequire(specifier: string): unknown {
  const requireFunction = eval("require") as NodeRequire;
  return requireFunction(specifier);
}
