# Integration Providers

This document describes the integration provider boundary for iTestFlow. Azure DevOps and Jira Cloud are registered work-management providers. Jira projects select one test-artifact backend: Plain Jira, Xray Cloud, or Zephyr Scale Cloud.

## Status

- Existing Azure routes, stored scopes, PAT flows, and compatibility result fields remain in place.
- Azure DevOps implements the generic work-management and test-management ports; Jira Cloud implements work management and uses a selected artifact backend for test-case publication.
- Jira API-token onboarding, trusted site/project selection, mappings, backend configuration, sync/conflict status, trace links, and disconnect are exposed through provider-aware login, header, and Settings surfaces.
- Provider identity is persisted on `workspaces.provider_id` and `projects.provider_id`, both defaulting to `azure-devops`.
- Jira API-token and backend secrets are encrypted; client responses expose status and redacted metadata only.

## Source Map

- Core contracts: `src/modules/integrations/core/`
- Provider registry: `src/modules/integrations/provider-registry.ts`
- Azure DevOps facade interface: `src/modules/integrations/azure-devops/azure-devops-adapter.ts`
- Azure DevOps REST implementation: `src/modules/integrations/azure-devops/azure-devops-client.ts`
- Azure DevOps descriptor and error wrapper: `src/modules/integrations/azure-devops/azure-devops-descriptor.ts`, `azure-devops-error.ts`
- Jira Cloud adapter and descriptor: `src/modules/integrations/jira-cloud/jira-cloud-adapter.ts`, `jira-cloud-descriptor.ts`
- Jira Cloud HTTP, reconciliation, and polling runtime: `src/modules/integrations/jira-cloud/jira-http.ts`, `jira-reconciliation.service.ts`, `jira-sync-runtime.service.ts`
- Jira artifact backends: `src/modules/integrations/jira-cloud/plain-jira-artifact-backend.ts`, `xray-cloud-backend.ts`, `zephyr-scale-backend.ts`
- Jira authentication and provisioning: `src/modules/auth/jira-token-auth.service.ts`, `jira-oauth.ts`, `jira-provisioning.service.ts`
- Jira project mapping: `src/modules/projects/jira-project-mapping.service.ts`
- Request-time construction: `src/modules/credentials/scoped-resolution.service.ts`
- Worker construction: `src/modules/jobs/workspace-sync.handler.ts`

## Dependency Rules

- `src/modules/integrations/core/` must not import provider packages.
- Provider packages may import core contracts and shared utilities.
- `provider-registry.ts` is the composition point that knows concrete provider classes.
- Route handlers and workflow services should depend on existing accessors or provider interfaces, not concrete client classes.

## Contracts

`ProviderConnection` contains shared connection/profile/project reads:

- `testConnection`
- `fetchAuthenticatedUser`
- `fetchProjects`

`WorkManagementProvider` contains work-item and metadata operations:

- classification metadata, project users, work-item fields
- work item fetches, linked work item fetches, revisions
- comments, bugs, child tasks, attachments, web URLs

`TestManagementProvider` contains test-plan and traceability operations:

- plans, suites, suite trees, points, runs, results
- suite creation/deletion, test case publishing, point updates
- linked test case reads and requirement-to-test linking

`AzureDevOpsAdapter` remains as the compatibility interface:

```ts
export interface AzureDevOpsAdapter extends WorkManagementProvider, TestManagementProvider {}
```

This lets the existing routes and services keep their imports while newer seams can type against the neutral ports.

## Types And Naming

Provider-neutral DTOs live in `core/integration-types.ts`. `azure-devops-types.ts` re-exports the old Azure-prefixed names as aliases so existing imports compile unchanged.

Known naming warts are intentionally deferred:

- route paths under `/api/azure-devops/*`
- function names such as `getUserAzureAdapter`
- result fields such as `azureTestCaseId`, `azureBugId`, and `azureTaskId`
- `ProjectScope` fields such as `azureProjectId`
- RAG and storage names that still mention Azure DevOps

These names are part of current runtime contracts across routes, UI, and persisted data.

## Capabilities

Capabilities are method names derived from the provider ports. There is no second capability vocabulary.

- `hasCapability(descriptor, capability)` checks support.
- `assertCapability(descriptor, capability)` throws `IntegrationError` with `integration_unsupported_capability`.
- The Azure DevOps descriptor declares its work-management and test-management capabilities. The Jira Cloud descriptor declares work-management capabilities; its test-management methods fail closed with `integration_unsupported_capability`.
- Jira test-case publication is deliberately outside `TestManagementProvider`: Plain Jira, Xray Cloud, and Zephyr Scale Cloud backends own the provider-specific artifact contract, with one backend selected per Jira project.

The provider registry is used by request-time and worker construction. Capability checks and provider-specific artifact selection keep unsupported Jira test-plan operations explicit instead of silently mapping them to Azure semantics.

## Error Contract

`IntegrationError` adds provider metadata without changing user-visible messages. It has:

- `providerId`
- `code`
- `statusCode`
- `message`

It deliberately has no `userMessage` field. The shared AppError guard is duck-typed on `message`, `userMessage`, and AppError codes; adding `userMessage` would route integration failures through the AppError branch and change responses.

Azure DevOps HTTP failures are wrapped by `azureDevOpsIntegrationError(status, body, path)`. The message remains the output of `formatAzureDevOpsError(...)`.

Status mapping:

- `401` -> `integration_auth_failed`
- `403` -> `integration_permission_denied`
- `404` -> `integration_not_found`
- `429` -> `integration_rate_limited`
- `408` and `5xx` -> `integration_unavailable`
- `400`, `409`, `422` -> `integration_validation`
- all other statuses -> `integration_unknown`

Non-JSON and malformed JSON client response failures use `integration_invalid_response` with the exact previous message text.

## Resolution And Construction

Request-time flows call:

- `requireWorkflowContext`
- `getUserAzureAdapter`
- `getUserAzureAdapterOrgLevel`
- optional neutral delegates `getUserWorkManagementProvider` and `getUserTestManagementProvider`

These accessors resolve the user PAT, read `ctx.workspace.providerId`, and call `createIntegrationProvider`.

The worker sync path reads the trusted project row, including `projects.provider_id`, resolves the workspace sync PAT, and builds the provider through the same registry.

`pat-auth-provider.ts` intentionally still constructs the Azure DevOps REST adapter directly. It is already behind the `AuthProvider` port and validates login PATs for Azure DevOps organizations. Jira token and OAuth login use the Jira-specific auth services.

## Adding A Provider

1. Add the provider id to `ProviderId`.
2. Implement the needed provider contract methods in a provider package under `src/modules/integrations/<provider>/`.
3. Add a descriptor with categories and exhaustive capabilities.
4. Register the descriptor and construction branch in `provider-registry.ts`.
5. Add tests for descriptor coverage, unsupported providers, and constructor argument pass-through.
6. Decide how credentials and workspace/project settings are represented before exposing any UI.
7. Add migrations for any provider-specific persisted settings.
8. Keep route paths and existing Azure-facing contracts unchanged until a separate compatibility migration is planned.

Examples for future providers:

- A future work-management provider can implement metadata, item reads, comments, attachments, and web URLs while leaving test management unsupported.
- A future split-provider composition could let one provider own work items while another owns test cases, plans, runs, results, and traceability links.
- Azure Boards plus TestRail: Boards owns requirements/bugs/tasks; TestRail owns test suites, runs, results, and requirement-to-test associations.

Generic split-provider orchestration is deferred. Jira's artifact backends are a deliberate provider-specific composition, while the current registry still returns one registered work-management provider per workspace.

## Testing Conventions

- Type contracts live in `provider-contracts.test.ts`.
- Error transparency is tested by comparing `IntegrationError` responses with plain `Error` responses that have the same message.
- New logic files should be added to `GATED_INCLUDE` in `vitest.coverage-manifest.ts`.
- Pure port/type files should be excluded with exact paths or by the existing `*-types.ts` exclusion.
- DB-backed provider identity behavior belongs in migration/integration tests when `DATABASE_URL` is available.

## Deferred Decisions

This provider boundary is ADR-11 in practice, although no separate ADR file exists yet. Still deferred for compatibility:

- Rename Azure-branded routes, accessors, fields, and local storage shapes.
- Split `AzureDevOpsRestAdapter` into work and test classes.
- Rename the legacy `/api/azure-devops/*` compatibility routes after clients migrate to neutral paths.
- Replace Azure-specific string heuristics in response classification with code-driven integration handling.
- Generalize bootstrap configuration beyond provider-specific variables.
- Generalize credential type checks as additional providers are added.
