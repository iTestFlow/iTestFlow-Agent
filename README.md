# iTestFlow

<p align="center">
  <img src="public/brand/itestflow-logo-full.png" alt="iTestFlow - AI-Powered Software Testing Lifecycle" width="760" />
</p>

<p align="center">
Workspace-scoped test intelligence for Azure DevOps, grounded in project knowledge and controlled by human review.
</p>

iTestFlow brings requirement analysis, test design, coverage review, execution planning, defect reporting, and test-suite operations into authenticated QA workspaces. It connects to real Azure DevOps and LLM provider APIs while keeping credentials, indexed context, audit history, jobs, and workflow records in PostgreSQL.

## Contents

- [Architecture](#architecture)
- [Capabilities](#capabilities)
- [Quick Start](#quick-start)
- [App Links](#app-links)
- [Configuration](#configuration)
- [First-Run Workflow](#first-run-workflow)
- [Data and Security](#data-and-security)
- [Development](#development)
- [Project Documentation](#project-documentation)

## Architecture

<p align="center">
  <img src="public/brand/itestflow-architecture.png" alt="iTestFlow architecture and AI-powered software testing lifecycle" width="1200" />
</p>

The browser communicates only with Next.js API routes. Server-side domain modules own workflow logic, PostgreSQL access, Azure DevOps calls, LLM provider calls, workspace authorization, and project isolation.

For module boundaries and the living source map, see [PROJECT_ARCHITECTURE.md](PROJECT_ARCHITECTURE.md).

## Capabilities

### Knowledge and Context

- **Knowledge Hub** indexes filtered Azure DevOps work items, builds compiled project knowledge, monitors knowledge health, and exports a Markdown wiki.
- **Business Owner Assistant** answers questions using retrieved project context and saved knowledge, with source citations.
- **Automatic context selection** grounds supported AI workflows in relevant project information.
- **Scheduled context updates** can refresh a configured project scope using a cron expression.

### Testing Lifecycle

- **Requirements Analysis** finds ambiguities, risks, omissions, and testability concerns, then publishes reviewed comments to Azure DevOps.
- **Test Case Design** generates editable positive, negative, boundary, and edge-case scenarios and publishes approved cases to Azure Test Plans.
- **Test Gap Analysis** maps requirement details and acceptance criteria to linked test cases, identifies missing coverage, and creates selected additions.
- **Test Execution Effort** estimates manual execution time, assumptions, complexity, risks, and recommendations for linked test cases.
- **Report Bug** converts QA notes into reviewed Azure DevOps Bug work items with fields, relationships, and attachments.

### Utilities and Governance

- **Suite Migration** previews and runs same-project Test Suite copy or move operations while preserving the latest matching test-point outcomes.
- **Bulk Task Creation** defines multiple Azure DevOps Tasks once and creates each task under every selected User Story.
- **Dashboards** combine current Azure Test Plan outcomes, bugs, requirement-to-test coverage, release blockers, and live execution/defect history into a project-scoped QA leadership view.
- **Activity Log** provides a traceable history of generated outputs, publishing operations, and user actions.
- **Human review gates** keep AI-generated analysis and artifacts editable before any Azure DevOps write.
- **Project isolation** validates Azure DevOps resources against the active project before project-scoped reads or writes.

## Quick Start

### Prerequisites

- Node.js 24 or newer
- npm
- PostgreSQL 16, either from `docker compose up -d postgres` or a native/server instance
- An Azure DevOps organization URL, such as `https://dev.azure.com/YOUR_ORG`
- An Azure DevOps Personal Access Token with the permissions needed for work items, comments, Test Plans, Test Suites, test cases, and links
- One LLM provider: OpenAI, Gemini, or Anthropic

### Install and Run

```bash
npm install
cp .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Set `APP_ENCRYPTION_KEY`, `SESSION_SECRET`, `BOOTSTRAP_OWNER_EMAIL`, and `BOOTSTRAP_OWNER_AZURE_ORG` in `.env` before using hosted workspace mode. Start at [Login](http://127.0.0.1:3000/login), sign in with an Azure DevOps PAT for the enabled organization, add personal LLM credentials in Settings if needed, and select a project from the top bar. iTestFlow then opens the [Dashboards](http://127.0.0.1:3000/dashboards) workspace.

Run the background worker in a second terminal when testing scheduled sync or workspace jobs:

```bash
npm run worker:dev
```

## App Links

These links work while the local development or production server is running on port `3000`.

| Area | Page | Description |
| --- | --- | --- |
| Overview | [Dashboards](http://127.0.0.1:3000/dashboards) | Testing progress, bug health, coverage, blockers, trends, and release readiness |
| Knowledge | [Knowledge Hub](http://127.0.0.1:3000/knowledge-hub) | Index context, compile knowledge, and review health |
| Knowledge | [Business Owner Assistant](http://127.0.0.1:3000/business-owner-assistant) | Ask grounded questions about the active project |
| Testing | [Requirements Analysis](http://127.0.0.1:3000/requirements-analysis) | Analyze a real Azure DevOps requirement |
| Testing | [Test Case Design](http://127.0.0.1:3000/test-case-design) | Generate, review, and publish test cases |
| Testing | [Test Gap Analysis](http://127.0.0.1:3000/test-gap-analysis) | Review traceability and missing coverage |
| Testing | [Test Execution Effort](http://127.0.0.1:3000/test-execution-effort) | Estimate manual QA execution effort |
| Testing | [Report Bug](http://127.0.0.1:3000/report-bug) | Generate and post Azure DevOps bugs |
| Utilities | [Suite Migration](http://127.0.0.1:3000/suite-migration) | Preview and execute Test Suite copy or move |
| Utilities | [Bulk Task Creation](http://127.0.0.1:3000/bulk-task-creation) | Create multiple tasks across selected User Stories |
| Administration | [Settings](http://127.0.0.1:3000/settings) | Manage integrations, models, context, and behavior |
| Administration | [Activity Log](http://127.0.0.1:3000/activity-log) | Review system and user activity |

## Configuration

### UI Configuration

The recommended setup path is [http://127.0.0.1:3000/login](http://127.0.0.1:3000/login), followed by [Settings](http://127.0.0.1:3000/settings). In hosted mode, each user configures private credentials from Settings:

- Azure DevOps organization URL and Personal Access Token
- LLM provider and model
- Provider API key
- Maximum output token cap and transient-failure retry count
- Project-context retrieval count
- Optional automatic context-update schedule and filters owned by the workspace

Models are loaded from the selected provider's model-list API where supported. The top bar displays the authenticated Azure DevOps profile and lets you choose the active project; the server persists and verifies the project row before project-scoped API routes can use it.

### Environment

Start from [.env.example](.env.example). Required values for normal hosted mode:

```bash
DATABASE_URL=postgresql://itestflow:itestflow@localhost:5432/itestflow
APP_MODE=hosted
SESSION_SECRET=replace-me
BOOTSTRAP_OWNER_EMAIL=owner@example.com
BOOTSTRAP_OWNER_AZURE_ORG=https://dev.azure.com/YOUR_ORG
APP_ENCRYPTION_KEY=base64-32-byte-key
```

Generate the encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Single-user/dev credential variables remain available for legacy local development:

```bash
AZURE_DEVOPS_ORG_URL=https://dev.azure.com/YOUR_ORG
AZURE_DEVOPS_PAT=YOUR_AZURE_DEVOPS_PAT
DEFAULT_LLM_PROVIDER=openai
OPENAI_API_KEY=YOUR_OPENAI_KEY
OPENAI_MODEL=YOUR_MODEL_ID
```

## First-Run Workflow

1. Start PostgreSQL, apply migrations, and run the web app.
2. Sign in from `/login` with a PAT for the bootstrapped Azure DevOps organization.
3. Add or verify private Azure DevOps and LLM credentials from `/settings`.
4. Select the active Azure DevOps project in the top bar.
5. Open `/knowledge-hub`, choose work-item filters, and index project context.
6. Build the compiled knowledge base if you want richer grounding and assistant answers.
7. Enter a real Azure DevOps work-item ID in Requirements Analysis, Test Case Design, Test Gap Analysis, or Test Execution Effort.
8. Review and edit every AI-generated result.
9. Publish only approved comments, test cases, suggested additions, bugs, or tasks.
10. Use Dashboards and Activity Log to review outcomes and trace recent actions.

## Data and Security

- User Azure DevOps and LLM credentials are encrypted with AES-256-GCM using `APP_ENCRYPTION_KEY`.
- Workspace data, project anchors, indexed context, knowledge, audit records, workflow analytics, and jobs are stored in PostgreSQL.
- Azure DevOps and LLM requests are made server-side; credentials are not sent directly from browser components to external providers.
- Project selection is persisted server-side and project-scoped API routes resolve a trusted workspace/project scope before reading or writing.
- Background workers heartbeat running jobs and stale worker locks are requeued automatically.

Treat the database and environment secrets as sensitive application state.

## Development

The UI uses Next.js App Router, React, TypeScript, Tailwind CSS, shadcn/Radix primitives, Lucide icons, and Recharts.

### Verification

```bash
npm run db:migrate
npm run typecheck
npm test
npm run build
```

### Production Build

```bash
npm run build
npm start -- --hostname 127.0.0.1 --port 3000
```

Run the worker as a separate process:

```bash
npm run worker
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The root route redirects to `/dashboards`.

Docker is required only if you use the provided local PostgreSQL service.

## Project Documentation

- [Project Architecture](PROJECT_ARCHITECTURE.md) - routes, modules, integrations, storage, and architecture decisions
- [Deployment Guide](docs/deployment.md) - private hosted runtime, environment, workers, backups, and migrations
- [Knowledge Wiki and RAG Enhancement](docs/knowledge-wiki-rag-enhancement.md) - compiled knowledge and wiki design
- [Environment Variable Template](.env.example) - supported bootstrap configuration

The `docs/` directory is still useful for durable reference material such as deployment and RAG/knowledge design. Historical plan documents can be removed once their accepted decisions are represented in the architecture and deployment docs.
