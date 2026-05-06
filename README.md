# iTestFlow

Local-first test intelligence command center for Azure DevOps requirement analysis, RAG-assisted context selection, test case design, existing linked test case review, coverage validation, and reviewed publishing back to Azure Test Plans.

The MVP runs locally with real Azure DevOps and LLM provider APIs. Runtime configuration is initiated from the UI, can be edited later from Settings, and `.env.local` is optional as a bootstrap fallback.

The UI foundation uses Next.js App Router, React, TypeScript, Tailwind CSS, shadcn/ui, Radix-powered shadcn components, and lucide-react icons.

For the living source map and module boundaries, see [PROJECT_ARCHITECTURE.md](PROJECT_ARCHITECTURE.md).

## Prerequisites

- Node.js 24 or newer
- npm
- Azure DevOps organization URL, for example `https://dev.azure.com/YOUR_ORG`
- Azure DevOps PAT with permissions for work items, comments, Test Plans, Test Suites, Test Case creation, and work item links
- One LLM provider: OpenAI, Gemini, or Anthropic/Claude

The Azure DevOps PAT authenticates requests. The organization URL is still required because it tells the app which Azure DevOps organization endpoint to call before project selection scopes actions.

## 1. Install Dependencies

```bash
npm install
```

## 2. Run in Development

```bash
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Open the app:

[http://127.0.0.1:3000/setup](http://127.0.0.1:3000/setup)

## 3. Configure from the UI

On the Initial Configuration screen, enter:

- Azure DevOps organization URL, for example `https://dev.azure.com/YOUR_ORG`
- Azure DevOps PAT
- LLM provider
- LLM model, loaded from the selected provider's real model-list API
- LLM API token
- LLM retry attempts for transient provider failures

Then:

1. Click `Test Connections`.
2. Confirm Azure DevOps and LLM both validate.
3. Click `Continue`.
4. The app saves settings locally and redirects to the dashboard.

Saved UI configuration is stored locally under `data/runtime-settings.json` using AES-256-GCM encryption. The local encryption key is stored under `data/.runtime-settings-key`. Both files are ignored by git.

You can view and edit saved configuration anytime from:

[http://127.0.0.1:3000/settings](http://127.0.0.1:3000/settings)

## 4. Optional `.env.local` Bootstrap

You can still preseed configuration with `.env.local`. The UI-saved runtime settings take priority. Environment variables are used only when no UI-saved settings exist.

```bash
AZURE_DEVOPS_ORG_URL=https://dev.azure.com/YOUR_ORG
AZURE_DEVOPS_PAT=YOUR_AZURE_DEVOPS_PAT

DEFAULT_LLM_PROVIDER=openai
NEXT_PUBLIC_LLM_PROVIDER_LABEL=OpenAI
OPENAI_API_KEY=YOUR_OPENAI_KEY
OPENAI_MODEL=MODEL_ID_RETURNED_BY_OPENAI_MODELS_API
LLM_RETRY_ATTEMPTS=1
```

Other supported providers:

```bash
DEFAULT_LLM_PROVIDER=gemini
GEMINI_API_KEY=YOUR_GEMINI_KEY
GEMINI_MODEL=MODEL_ID_RETURNED_BY_GEMINI_MODELS_API
```

```bash
DEFAULT_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_KEY
ANTHROPIC_MODEL=MODEL_ID_RETURNED_BY_ANTHROPIC_MODELS_API
```

## 5. Build for Production

```bash
npm run build
```

## 6. Start the Built App

```bash
npm start -- --hostname 127.0.0.1 --port 3000
```

Open after starting the built app:

[http://127.0.0.1:3000/setup](http://127.0.0.1:3000/setup)

After configuration, open:

[http://127.0.0.1:3000/dashboard](http://127.0.0.1:3000/dashboard)

## 7. First-Run Workflow

1. Configure and test connections from `/setup`.
2. Select an Azure DevOps project in the header selector.
3. Fetch and index filtered project context from `/context` when you want RAG-assisted suggestions.
4. Enter a real Azure DevOps work item ID in Requirement Analysis or Test Case Design.
5. Run context suggestion, analysis, generation, or existing linked test case review.
6. Review and edit AI output before pushing comments or publishing test cases.
7. Publish selected test cases to a fetched Azure Test Plan and Test Suite.
8. Check Audit Logs for local execution history.

The header displays the authenticated Azure DevOps user from the configured PAT through the live Azure DevOps profile endpoint. It does not use a mocked local user profile.

## Verification

```bash
npm run typecheck
npm run build
```

Docker is not required.
