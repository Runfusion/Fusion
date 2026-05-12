# Research

[← Docs index](./README.md)

Fusion Research lets you create bounded research runs that search, fetch, and synthesize information with built-in web tools by default, then turn structured findings into actionable tasks — all from the dashboard, CLI, or agent sessions.

---

## Overview

A **research run** is a persisted workflow that moves through orchestration phases:

```
planning → searching → fetching → synthesizing → finalizing
```

Each run produces:
- **Findings** — structured results with headings, content, and source citations
- **Citations** — referenced URLs and sources
- **Summary** — synthesized output combining all discovered information
- **Events** — timestamped lifecycle log for auditability

Runs are persisted in the project database and can be listed, searched, exported, and converted into tasks.

## When to use Research

- Explore a technology, library, or API before writing implementation tasks
- Compare approaches (e.g., "SQLite WAL vs rollback journal") with cited sources
- Gather context from web search, GitHub, and local docs in a single structured run
- Let AI agents supplement task planning with real-time information

Research is **not** a replacement for reading source code or local docs — use it when repository-local context is insufficient for the question at hand.

---

## Prerequisites

Research requires the experimental feature flag. Web search works out of the box using built-in agent tools, and external provider setup is optional advanced configuration.

### 1. Enable the feature flag

The Research view is gated behind an experimental feature flag. Set in global settings:

```json
{
  "experimentalFeatures": {
    "researchView": true
  }
}
```

This also reveals the **Research Defaults** and **Research** settings sections in the dashboard Settings modal, and enables agent/CLI research tools (`fn_research_*`).

### 2. Built-in web search is the default

By default, `researchGlobalWebSearchProvider` resolves to `"builtin"`. Search and fetch run through the agent runtime's native `WebSearch` and `WebFetch` tools, so no API key is required for baseline usage, and web search stays enabled even if older persisted settings still contain `enabledSources.webSearch: false`.

### 3. Optional: external search backends

You can opt into external providers in global settings:

| Provider | Required settings |
|---|---|
| `"builtin"` | No API key required (default) |
| `"searxng"` | `researchGlobalSearxngUrl` — URL of your SearXNG instance |
| `"brave"` | `researchGlobalBraveApiKey` — Brave Search API key |
| `"google"` | `researchGlobalGoogleSearchApiKey` + `researchGlobalGoogleSearchCx` — Google Custom Search credentials |
| `"tavily"` | `researchGlobalTavilyApiKey` — Tavily API key |

API keys are stored through Fusion's auth credential pipeline (`/api/auth/api-key`), not in settings JSON directly.

### 4. (Optional) Configure synthesis model

If LLM synthesis is enabled (default: on), set a synthesis provider and model:

```json
{
  "researchGlobalDefaults": {
    "synthesisProvider": "anthropic",
    "synthesisModelId": "claude-sonnet-4-5"
  }
}
```

If no synthesis model is configured, Research falls back to the global default model lane. If no global default model is resolvable, synthesis may fail with a `PROVIDER_UNAVAILABLE` error.

### Settings hierarchy

Research settings resolve through `resolveResearchSettings()` with this precedence:

1. **Project override** (`researchSettings.*`)
2. **Global default** (`researchGlobalDefaults.*`)
3. **Hardcoded fallback defaults**

See [Settings Reference → Research](./settings-reference.md) for the complete key listing.

---

## Dashboard Usage

### Navigation

The Research view is accessible from:
- **Desktop:** Header → **More views** overflow menu → Research
- **Mobile:** **More** sheet in the mobile navigation bar

Research is intentionally not shown in the primary board/list/agents/missions/chat toggle row.

### Creating a run

1. Open the Research view
2. Enter your query in the text area
3. Select which providers to use (Web Search, Page Fetch, GitHub, Local Docs, LLM Synthesis)
4. Click **Create Run**

The run enters the `queued` status and progresses through orchestration phases as the engine processes it.

### Viewing results

Select a run from the history sidebar to see:
- **Status dot and label** — current run status
- **Summary** — synthesized overview
- **Findings** — individual structured results, each with a heading and content
- **Citations** — linked source URLs
- **Run history** — expandable event log (click "Run history")

### Run lifecycle controls

| Action | Description |
|---|---|
| **Cancel** | Requests cancellation for an active run |
| **Retry** | Creates a new retry run from a failed/cancelled/timed-out run |
| **Refresh** | Reloads run data from the server |
| **Export MD** | Downloads results as a Markdown file |
| **Export JSON** | Downloads results as a JSON file |
| **Export HTML** | Downloads results as an HTML file |

### Converting findings to tasks

Each finding has two task-facing actions:

- **Create Task** — Opens a modal to create a new task from the finding, with pre-populated title, description, and priority. The finding content is attached as a task document (key: `research-{runId}`) and optionally as a Markdown attachment.
- **Enrich Task** — Attaches the finding content to an existing task as a document and/or attachment.

### Status indicators

| Status | Meaning |
|---|---|
| `queued` | Run created, waiting for engine pickup |
| `running` | Actively executing orchestration phases |
| `cancelling` | Cancellation requested, waiting for graceful shutdown |
| `retry_waiting` | Retry run created, waiting to re-enter the queue |
| `completed` | Run finished successfully with results |
| `failed` | Run encountered an unrecoverable error |
| `cancelled` | Run was cancelled by user |
| `timed_out` | Run exceeded the configured duration limit |
| `retry_exhausted` | All retry attempts exhausted |

---

## CLI Usage

The `fn research` command provides full research run management from the terminal.

### Commands

```bash
# Create a research run
fn research create --query "Compare sqlite WAL vs rollback journal"

# Create and wait for completion (up to 90 seconds)
fn research create --query "Rust async runtime trade-offs" --wait --max-wait-ms 120000

# List recent runs
fn research list
fn research list --status failed --limit 20

# Show run details
fn research show RR-001

# Export run results
fn research export RR-001 --format json --output ./artifacts/research-RR-001.json
fn research export RR-001 --format markdown

# Cancel an active run
fn research cancel RR-001

# Retry a failed run
fn research retry RR-001 --json
```

All commands support `--json` for machine-readable output.

### Error codes

| Code | Meaning | Recovery |
|---|---|---|
| `FEATURE_DISABLED` | Research is disabled in settings | Enable project or global research settings |
| `MISSING_CREDENTIALS` | No API key for the configured provider | Add provider credentials in Settings |
| `PROVIDER_UNAVAILABLE` | No configured provider or provider down | Configure a search provider |
| `RATE_LIMITED` | Provider rate limit hit | Retry after cooldown period |
| `PROVIDER_TIMEOUT` | Provider request timed out | Increase timeout or retry |
| `RUN_CANCELLED` | Run was cancelled by user | Retry if needed |
| `RETRY_EXHAUSTED` | All retry attempts used | Create a new run |
| `INVALID_TRANSITION` | Illegal status change | Check current run status |
| `NON_RETRYABLE_PROVIDER_ERROR` | Provider returned a permanent error | Check provider configuration |
| `INTERNAL_ERROR` | Unexpected internal error | Check engine logs |

See [CLI Reference → `fn research`](./cli-reference.md) for the full command reference.

---

## API Reference

All research endpoints are under `/api/research`. The router is registered in `packages/dashboard/src/routes/register-integrated-routers.ts`.

### Runs

| Method | Path | Description |
|---|---|---|
| `GET` | `/research/runs` | List runs (query params: `status`, `q`, `limit`) |
| `POST` | `/research/runs` | Create a new run (body: `query`, `providers`, etc.) |
| `GET` | `/research/runs/:id` | Get run details with findings and citations |
| `PATCH` | `/research/runs/:id` | Update run fields |
| `DELETE` | `/research/runs/:id` | Delete a run |
| `POST` | `/research/runs/:id/cancel` | Request cancellation |
| `POST` | `/research/runs/:id/retry` | Create a retry run |
| `PATCH` | `/research/runs/:id/status` | Update run status |
| `POST` | `/research/runs/:id/events` | Append an event |
| `POST` | `/research/runs/:id/sources` | Add a source |
| `PATCH` | `/research/runs/:id/sources/:sourceId` | Update a source |
| `PUT` | `/research/runs/:id/results` | Set run results |

### Exports

| Method | Path | Description |
|---|---|---|
| `GET` | `/research/runs/:id/export` | Export run (query param: `format` = `markdown`, `json`, `html`) |
| `POST` | `/research/runs/:id/exports` | Create an export record |
| `GET` | `/research/runs/:id/exports` | List exports for a run |
| `GET` | `/research/exports/:exportId` | Download/get a specific persisted export |

> Note: CLI/core export formats and server export endpoint formats are intentionally not identical today. CLI/core accept `pdf`, while the server run export endpoint documents `markdown`, `json`, and `html`.

### Task Integration

| Method | Path | Description |
|---|---|---|
| `POST` | `/research/runs/:runId/findings/:findingId/task` | Create a task from a finding |
| `POST` | `/research/runs/:runId/findings/:findingId/tasks/:taskId/enrich` | Attach finding to existing task |

Both endpoints support `attachExport: boolean` in the request body to include a Markdown attachment.

### Search & Stats

| Method | Path | Description |
|---|---|---|
| `GET` | `/research/search?q=<text>` | Full-text search across runs |
| `GET` | `/research/stats` | Aggregate run counts by status |

### Availability

List and detail endpoints include an `availability` object:

```json
{
  "available": true,
  "supportedProviders": ["web-search", "page-fetch", "github", "local-docs", "llm-synthesis"],
  "supportedExportFormats": ["markdown", "json", "html"]
}
```

When `available` is `false`, the response includes `reason` and `setupInstructions` fields for graceful degradation.

---

## Agent Integration

AI agents (triage, executor, and custom roles) can use research tools during planning and execution sessions. These tools are registered in the pi extension (`packages/cli/src/extension.ts`).

Additionally, planning-mode sessions and the LLM synthesis agent can opt into runtime builtin `WebSearch`/`WebFetch` tools (when the selected runtime supports them), complementing configured research providers.

### Available tools

| Tool | Description |
|---|---|
| `fn_research_run` | Start a bounded research run. Parameters: `query`, `wait_for_completion`, `max_wait_ms` |
| `fn_research_list` | List recent runs. Parameters: `status`, `limit` |
| `fn_research_get` | Get a run's structured findings. Parameters: `id` |
| `fn_research_cancel` | Cancel an active run. Parameters: `id` |
| `fn_research_retry` | Retry a failed/timed-out run when retryable. Parameters: `id` |

### Tool responses

All tools return:
- **Text content** — concise human-readable summary
- **Structured details** — machine-readable metadata (`runId`, `status`, `summary`, `findings`, `citations`, `error`, `setup`)

### Availability checks

Before creating runs, `fn_research_run` checks:
1. Research is enabled in settings
2. Web search is available (`"builtin"` by default, or an explicitly configured external backend)
3. Required API keys are present for external providers

If a check fails, the tool returns an actionable error with setup guidance instead of crashing. In practice, with the default `"builtin"` backend, provider-setup errors are mostly limited to explicit external-provider selections.

### Best practices for agents

- Use research **only when repository/local context is insufficient** for the question
- Keep queries **narrow and task-scoped** — avoid open-ended exploration
- Persist durable conclusions with `fn_task_document_write` (e.g., `key="research"`)
- Check tool availability before relying on research in automated flows

See [Agents → Research Tools](./agents.md) for more details.

---

## Storage

Research data is persisted in the project SQLite database (`.fusion/fusion.db`) using three tables:

### `research_runs`

Primary table for research run state.

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | Run identifier (format: `RR-{timestamp}-{random}`) |
| `query` | TEXT NOT NULL | Research query text |
| `topic` | TEXT | Optional topic/label |
| `status` | TEXT | Current run status |
| `projectId` | TEXT | Optional project scope |
| `trigger` | TEXT | Optional trigger source |
| `providerConfig` | TEXT (JSON) | Provider configuration used |
| `sources` | TEXT (JSON) | Array of research sources |
| `events` | TEXT (JSON) | Array of run events |
| `results` | TEXT (JSON) | Research results (findings, summary, citations) |
| `error` | TEXT | Error message if failed |
| `tokenUsage` | TEXT (JSON) | Token usage metrics |
| `tags` | TEXT (JSON) | String array of tags |
| `metadata` | TEXT (JSON) | Arbitrary metadata |
| `lifecycle` | TEXT (JSON) | Lifecycle details (attempts, retry info, failure class) |
| `createdAt` | TEXT | ISO timestamp |
| `updatedAt` | TEXT | ISO timestamp |
| `startedAt` | TEXT | When execution began |
| `completedAt` | TEXT | When execution ended |
| `cancelledAt` | TEXT | When cancellation took effect |

Indexes: `status`, `createdAt`, `updatedAt`, `(projectId, trigger, status)`

### `research_exports`

Persisted export records.

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | Export identifier |
| `runId` | TEXT FK → `research_runs(id)` | Parent run |
| `format` | TEXT NOT NULL | Export format (`json`, `markdown`, `pdf`) |
| `content` | TEXT NOT NULL | Export content |
| `filePath` | TEXT | Optional file path if saved to disk |
| `createdAt` | TEXT NOT NULL | ISO timestamp |

### `research_run_events`

Append-only event log for run lifecycle tracking.

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | Event identifier |
| `runId` | TEXT FK → `research_runs(id)` | Parent run |
| `seq` | INTEGER NOT NULL | Sequence number within run |
| `type` | TEXT | Event type (info, warning, error, progress, etc.) |
| `message` | TEXT | Human-readable message |
| `status` | TEXT | Run status at event time |
| `classification` | TEXT | Failure classification if applicable |
| `metadata` | TEXT (JSON) | Arbitrary metadata |
| `createdAt` | TEXT NOT NULL | ISO timestamp |

Index: `(runId, seq)` for ordered retrieval.

See [Storage](./storage.md) for the full storage architecture.

---

## Architecture

The research subsystem spans four packages:

| Package | Module | Responsibility |
|---|---|---|
| `@fusion/core` | `research-store.ts` | Run CRUD, status transitions, event/source management, exports |
| `@fusion/core` | `research-types.ts` | Type definitions: statuses, events, sources, findings, orchestration |
| `@fusion/core` | `research-settings.ts` | Settings resolution with project/global/fallback hierarchy |
| `@fusion/engine` | `research-orchestrator.ts` | Phase lifecycle management, concurrency control, cancellation |
| `@fusion/engine` | `research-step-runner.ts` | Provider execution: search, fetch, synthesis with timeout/abort |
| `@fusion/engine` | `research/` | Provider implementations and registry |
| `@fusion/dashboard` | `research-routes.ts` | Express router for `/api/research` endpoints |
| `@fusion/dashboard` | `ResearchView.tsx` | Dashboard UI for research runs |
| `@fusion/dashboard` | `ResearchTaskActionModal.tsx` | Create/enrich task modal for findings |
| `@runfusion/fusion` | `commands/research.ts` | CLI subcommands for research management |
| `@runfusion/fusion` | `extension.ts` | Agent tool definitions for research |

### Orchestration phases

```
planning → searching → fetching → synthesizing → finalizing → completed
```

1. **Planning** — Validates configuration and creates an execution plan
2. **Searching** — Queries configured providers for relevant sources
3. **Fetching** — Retrieves full content for discovered sources
4. **Synthesizing** — Runs LLM synthesis over fetched content (configurable rounds)
5. **Finalizing** — Writes structured results (findings, summary, citations)

Each phase emits events (`phase-changed`, `step-started`, `step-completed`, `step-failed`) for real-time progress tracking.

### Concurrency

Runs are processed through an `AgentSemaphore` with configurable `maxConcurrentRuns` (default: 3). The engine processes pending runs from the queue as slots become available.

### Retry behavior

Failed or timed-out runs can be retried. The system tracks:
- **Attempt count** and **max attempts** (default: 3)
- **Root run ID** — chains retries back to the original run
- **Failure class** — determines retryability (`retryable_transient` vs `non_retryable`)

When all retries are exhausted, the run transitions to `retry_exhausted`.

---

## Troubleshooting

| Symptom | Cause | Resolution |
|---|---|---|
| "Research is disabled in settings" | `researchGlobalEnabled` or `researchSettings.enabled` is `false` | Enable in Settings → Research |
| "Research provider is not configured" | External provider setup is incomplete | Switch back to builtin search or finish configuring your selected external provider in Settings |
| "Missing API key for {provider}" | Auth credential not found | Configure provider credentials in Settings → Authentication |
| Run stuck in `queued` | Engine not running or no available concurrency slots | Start the project engine; check `maxConcurrentRuns` |
| Run times out | Provider slow or `maxDurationMs` too low | Increase timeout in project research settings |
| All retries exhausted | Persistent provider error | Check provider status; create a fresh run |
| Research view not visible in dashboard | Feature flag disabled | Set `experimentalFeatures.researchView` to `true` |
| Settings modal missing Research sections | Feature flag disabled | Enable `researchView` feature flag first |
