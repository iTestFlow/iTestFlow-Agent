import { z } from "zod";
import { CONNECTION_ALIAS_PATTERN, MAX_EXECUTION_CONNECTIONS } from "./execution-connections.shared";

const SecretSchema = z.object({
  value: z.string().min(1).max(8192).optional(),
  fromRunId: z.string().min(1).optional(),
  fromProfileId: z.string().min(1).optional(),
  sourceAlias: z.string().min(1).optional(),
  sourceField: z.string().min(1).optional(),
}).strict();

const Shared = {
  alias: z.string().regex(CONNECTION_ALIAS_PATTERN, "Use a lowercase connection alias starting with a letter; letters, digits, and hyphens only."),
  allowWrites: z.boolean().default(false),
  credentials: z.record(SecretSchema).optional(),
};

const ApiAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("bearer") }).strict(),
  z.object({ type: z.literal("basic"), username: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("apiKey"), name: z.string().min(1).max(200), in: z.enum(["header", "query"]) }).strict(),
  z.object({ type: z.literal("oauth2ClientCredentials"), tokenUrl: z.string().url().max(2048), clientId: z.string().min(1).max(500), scopes: z.array(z.string().min(1).max(200)).max(20).optional() }).strict(),
]);

export const ConnectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("api"), ...Shared,
    baseUrl: z.string().url().max(2048),
    auth: ApiAuthSchema,
    openApiUrl: z.string().url().max(2048).nullish(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
  }).strict(),
  z.object({
    kind: z.literal("database"), ...Shared,
    engine: z.enum(["postgres", "sqlserver", "mysql"]),
    host: z.string().min(1).max(253).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    database: z.string().min(1).max(255).optional(),
    username: z.string().min(1).max(255).optional(),
    ssl: z.boolean().optional(),
    tlsMode: z.enum(["verify-full", "require", "disable"]).optional(),
  }).strict(),
]);

export const ConnectionsSchema = z.array(ConnectionSchema).max(MAX_EXECUTION_CONNECTIONS).default([])
  .superRefine((connections, ctx) => {
    const seen = new Set<string>();
    connections.forEach((connection, index) => {
      const alias = connection.alias.toLowerCase();
      if (seen.has(alias)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "alias"], message: `Connection alias "${connection.alias}" is used more than once.` });
      seen.add(alias);
    });
  });
