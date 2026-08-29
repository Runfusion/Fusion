# pi-autoresearch Analysis for Fusion Port (FN-2990)

## Table of Contents
- [1. Scope and Method](#1-scope-and-method)
- [2. Upstream Repository Overview](#2-upstream-repository-overview)
- [3. Architecture and Orchestration Flow](#3-architecture-and-orchestration-flow)
- [4. Data Model and Persistence](#4-data-model-and-persistence)
- [5. Provider/Capability Catalog](#5-providercapability-catalog)
- [6. License and Attribution Review](#6-license-and-attribution-review)
- [7. Fusion Integration Mapping](#7-fusion-integration-mapping)
- [8. Porting Plan (FN-2991 → FN-3002)](#8-porting-plan-fn-2991--fn-3002)
- [9. Risks, Unknowns, and Recommendations](#9-risks-unknowns-and-recommendations)

## 1. Scope and Method

This spike analyzes `https://github.com/davebcn87/pi-autoresearch` (cloned locally to `/tmp/pi-autoresearch-FN-2990`) and maps it to Fusion-native architecture.

Primary upstream files reviewed:
- `README.md`
- `LICENSE`
- `package.json`
- `extensions/pi-autoresearch/index.ts`
- `extensions/pi-autoresearch/hooks.ts`
- `extensions/pi-autoresearch/jsonl.ts`
- `extensions/pi-autoresearch/compaction.ts`
- tests under `tests/*.test.mjs`

Fusion references used:
- `docs/storage.md`
- `packages/core/src/types.ts` (GlobalSettings / ProjectSettings)
- `packages/core/src/db.ts`
- `packages/cli/src/extension.ts`
- `packages/dashboard/app/App.tsx`

## 2. Upstream Repository Overview

### 2.1 Top-level structure

- `extensions/pi-autoresearch/`: core extension runtime (tools, command, widget, dashboard export)
- `skills/`: onboarding/finalization/hook-authoring skills
- `assets/`: dashboard HTML template + logo
- `tests/`: node tests for helpers
- `package.json`: ESM package, Node >= 22, no build step

### 2.2 Build/test/tooling model

- Type: pure ESM package (`"type": "module"`)
- Runtime dependencies are mostly pi ecosystem peer deps:
  - `@earendil-works/pi-ai`
  - `@earendil-works/pi-coding-agent`
  - `@earendil-works/pi-tui`
  - `@sinclair/typebox`
- Script: `node --experimental-strip-types --test tests/*.test.mjs`

### 2.3 Entry points and responsibilities

- `extensions/pi-autoresearch/index.ts`
  - Registers tools: `init_experiment`, `run_experiment`, `log_experiment`
  - Registers command: `/autoresearch`
  - Registers keyboard shortcuts (`ctrl+shift+t`, `ctrl+shift+f`)
  - Owns runtime session state and widget rendering
  - Hosts local live export server (SSE)
- `hooks.ts`: optional before/after hook execution + steering message bridging
- `jsonl.ts`: parse/reconstruct append-only JSONL state
- `compaction.ts`: deterministic compaction summary generation

## 3. Architecture and Orchestration Flow

### 3.1 Runtime architecture

`index.ts` acts as a monolithic orchestrator around a per-session runtime store:
- Session-scoped `AutoresearchRuntime` object (mode, counters, pending resume timer, last run checks, UI state)
- Persistent experiment state (`ExperimentState`) reconstructed from disk (`autoresearch.jsonl`) at session start/switch
- Tool-driven control loop (`init_experiment` → `run_experiment` → `log_experiment`)

### 3.2 Core loop

1. **Session init**
   - Reconstructs prior runs from JSONL (or legacy branch history fallback).
2. **`init_experiment`**
   - Writes/append config header `{type:"config", ...}` to JSONL.
   - Starts a new segment for re-initialization.
3. **`run_experiment`**
   - Executes benchmark command via spawned shell.
   - Streams periodic updates.
   - Parses structured `METRIC name=value` lines.
   - Optionally runs `autoresearch.checks.sh` on benchmark pass.
4. **`log_experiment`**
   - Validates result consistency.
   - Appends run record to JSONL.
   - Auto-commits `keep`; auto-reverts non-keep while preserving `autoresearch.*` artifacts.
   - Computes confidence score (MAD-based).
5. **Auto-resume**
   - Extension posts follow-up prompts to continue loop (bounded by `MAX_AUTORESUME_TURNS`).

### 3.3 Compaction/recovery model

- Implements deterministic compaction summaries (`compaction.ts`) instead of relying on model-written summaries.
- Summary includes: session meta, rules (`autoresearch.md`), ideas backlog, recent runs.
- During compaction, extension injects this summary to rehydrate from durable state.

### 3.4 Event/logging model

The extension responds to lifecycle events:
- `session_start`, `session_tree`, `session_shutdown`, `session_before_compact`, `session_compact`, `agent_start`, `agent_end`, `before_agent_start`.

Progress is represented through:
- In-memory runtime state
- JSONL append log (`autoresearch.jsonl`)
- UI widget/dashboard updates
- Optional hook log entries (`type: "hook"`) in JSONL when config headers are present

## 4. Data Model and Persistence

### 4.1 Primary entities

- **ExperimentState**: session envelope (`name`, metric definition, direction, segment, maxExperiments, results, confidence)
- **ExperimentResult**: one run (`commit`, primary metric, secondary metrics, status, description, timestamp, segment, confidence, optional ASI)
- **Config entry** (`type: "config"`): session/segment header
- **Hook entry** (`type: "hook"`): optional operational metadata for hook runs
- **ASI**: free-form structured diagnostics payload attached to run entries

### 4.2 Persistence model

- **Primary durable store:** append-only `autoresearch.jsonl` (filesystem)
- **Companion files:**
  - `autoresearch.md` (rules/objective)
  - `autoresearch.ideas.md` (backlog)
  - `autoresearch.checks.sh` (post-benchmark checks)
  - `autoresearch.hooks/before.sh|after.sh` (optional)
  - `autoresearch.config.json` (workingDir/maxIterations)

No database is used upstream.

### 4.3 Relationships

- One **session** has many **segments** (new `config` line increments segment)
- One **segment** has many **run** records
- One **run** may include many secondary metrics and optional ASI
- Hooks are side-channel records linked by temporal order rather than explicit run IDs

## 5. Capability Catalog (and Provider Reality Check)

Upstream `pi-autoresearch` has no provider abstraction layer. It is a shell-experiment orchestrator with durable JSONL state.

### 5.1 Capabilities present upstream

- **Session initialization** (`init_experiment`): metric definition + segment config persistence.
- **Experiment execution** (`run_experiment`): command execution, timeout handling, streaming status updates, output truncation with temp-file fallback.
- **Structured metric parsing**: `METRIC name=value` line parser with denylist for prototype-pollution keys.
- **Backpressure checks**: optional `autoresearch.checks.sh` execution after benchmark success.
- **Result logging** (`log_experiment`): schema checks for secondary metrics, ASI capture, confidence scoring.
- **Git automation**: commit-on-keep and revert-on-non-keep policy.
- **Hook scripting**: `before.sh` / `after.sh` with timeout and steer-message integration.
- **Compaction resilience**: deterministic summary generation from durable artifacts.
- **Observability/UI**: TUI widget + fullscreen dashboard + local SSE browser export.

### 5.2 Configuration model

- `autoresearch.config.json`
  - `workingDir`: where experiments execute and files are read/written.
  - `maxIterations`: per-segment hard cap.
- Session artifacts:
  - `autoresearch.jsonl`, `autoresearch.md`, `autoresearch.ideas.md`, `autoresearch.sh`, optional checks/hooks.

### 5.3 External provider and credential behavior (upstream)

- **API keys:** none.
- **Rate limiting:** none implemented at provider layer (only timeout/iteration limits).
- **Provider selection per run:** none.

### 5.4 Failure modes and quirks

- Enforces `autoresearch.sh` execution if script exists (custom commands blocked).
- Checks can fail independently from benchmark pass (`checks_failed` status).
- Hook failures/timeouts do not crash core loop.
- JSONL write failures are surfaced in tool output as warnings.

### 5.5 Fusion-native enhancements (not upstream parity)

Fusion can add true provider architecture as an extension beyond upstream parity:
- search providers (web/github/docs)
- fetch/extraction providers
- synthesis providers
- provider auth in settings hierarchy

## 6. License and Attribution Review

### 6.1 Upstream license

- Upstream `LICENSE`: **MIT License**.
- Verification source during this spike: local clone `/tmp/pi-autoresearch-FN-2990/LICENSE` (HEAD `376ccc62d88345e84d524486699378eaf006f838`) and `package.json` `"license": "MIT"`.
- Includes standard grant: use/copy/modify/merge/publish/distribute/sublicense/sell.
- Obligations: preserve copyright + license notice in copies/substantial portions.
- No copyleft requirement.

### 6.2 Fusion license compatibility

- Fusion root project license is MIT-compatible for incorporating/adapting MIT-licensed logic.
- **Compatibility verdict:** compatible.

### 6.3 Porting strategy decision

- **Allowed:** substantial adaptation and selective code reuse with attribution.
- **Preferred:** reimplement architecture patterns in Fusion style (types, DB, API, dashboard patterns) while referencing upstream behavior/spec.
- **Attribution requirement if code is copied/adapted:**
  - retain MIT license notice in relevant source headers or third-party notices,
  - ensure repository-level licensing docs include upstream notice when substantial portions are included.

## 7. Fusion Integration Mapping

### 7.1 Concept mapping

- Upstream `ExperimentState`/`ExperimentResult` → Fusion SQLite tables (`research_runs`, `research_run_results`, etc.)
- JSONL append stream → SQLite event table + filesystem artifacts for prompts/reports
- `autoresearch.config.json` → Global/Project settings split (`GlobalSettings` + `ProjectSettings` patterns)
- TUI widget/export → Dashboard Research view + API endpoints + optional CLI streaming command

| Upstream concept | Fusion target |
|---|---|
| session runtime map | engine-managed run state + store layer |
| config headers/segments | `run_segments` relational model |
| tool triad (`init/run/log`) | API + CLI + extension toolset |
| hook steer messages | task/run event log + optional agent steer system |
| local SSE export | dashboard server push channel |

### 7.2 Storage mapping to Fusion hybrid model

Following `docs/storage.md` patterns:
- Structured metadata to SQLite (`.fusion/fusion.db`)
- Large textual artifacts to filesystem (`.fusion/research/{runId}/`), e.g. raw outputs/snapshots/exports
- WAL-safe writes and migration-based schema evolution in `packages/core/src/db.ts`

### 7.3 Settings mapping

- Global defaults (provider/model choices, retry/timeout defaults) in `GlobalSettings`
- Project overrides (concurrency, run limits, enablement, command defaults) in `ProjectSettings`
- Keep consistent with Fusion model lane precedence pattern already used for execution/planning/validator

### 7.4 Engine integration requirements

Per AGENTS.md engine constraints:
- use async subprocess execution for user commands (`promisify(exec)` / non-blocking process APIs)
- enforce timeout bounds and output caps
- avoid event-loop blocking paths
- emit structured run-audit events for db/fs/git mutations

### 7.5 Dashboard integration

- Add lazy-loaded `ResearchView` in `App.tsx` and prefetch pipeline
- Keep CSS component-local (`ResearchView.css`) with tokenized styles
- Include live run table, run details, confidence trend, and event stream

### 7.6 CLI and pi extension integration

- CLI commands likely under `packages/cli/src/commands/research-*`:
  - `fn research run`
  - `fn research list`
  - `fn research show`
  - `fn research cancel`
- pi extension tool additions in `packages/cli/src/extension.ts`:
  - create run
  - append measurement/event
  - query run status/results

## 8. Porting Plan (FN-2991 → FN-3002)

> This breakdown assumes twelve downstream tasks implement Fusion-native auto-research while preserving core upstream behavior.

1. **FN-2991 — Core domain model + types**
   - Apply: upstream state/result semantics, segment concept, confidence fields.
   - Rewrite: idiomatic Fusion types, validation, status enums.

2. **FN-2992 — SQLite schema + migrations**
   - Apply: append-event and run-result structure.
   - Rewrite: normalized relational schema, migrations, indices.

3. **FN-2993 — Research store/service layer**
   - Apply: reconstruct-state logic patterns from JSONL model.
   - Rewrite: DB-backed repository + filesystem artifact bridge.

4. **FN-2994 — Engine executor integration**
   - Apply: run loop state machine, timeout/check phases.
   - Rewrite: async non-blocking execution, engine lifecycle hooks.

5. **FN-2995 — Metric parser + confidence module**
   - Apply: METRIC line grammar, MAD confidence strategy.
   - Rewrite: tested utility package with Fusion error handling.

6. **FN-2996 — Hook/check pipeline**
   - Apply: before/after hook contract and checks semantics.
   - Rewrite: secure execution boundaries + richer event capture.

7. **FN-2997 — API routes**
   - Apply: dashboard export/update semantics.
   - Rewrite: REST endpoints + SSE/websocket for run updates.

8. **FN-2998 — Dashboard ResearchView**
   - Apply: upstream UX concepts (compact/expanded/progress).
   - Rewrite: React lazy-loaded view, tokenized CSS, mobile behaviors.

9. **FN-2999 — CLI research commands**
   - Apply: command surface idea (`start/stop/clear/export` analogs).
   - Rewrite: Fusion CLI command conventions and output formatting.

10. **FN-3000 — pi extension tools**
   - Apply: tool triad concept (`init/run/log`).
   - Rewrite: Fusion tool naming/contracts and task-store integration.

11. **FN-3001 — Provider system (Fusion-native extension)**
   - Apply: none directly from upstream (net-new).
   - Rewrite/new: search/fetch/synthesis provider registry, auth, selection precedence.

12. **FN-3002 — Finalization, docs, migration helpers**
   - Apply: upstream session artifact concepts.
   - Rewrite: operational docs, upgrade guides, safeguards.

### 8.1 Dependencies and ordering constraints

Recommended order:
1. FN-2991 → FN-2993 (types/schema/store) as foundation
2. FN-2994/FN-2995/FN-2996 (executor + metrics + hooks/checks)
3. FN-2997 (API), FN-2998 (dashboard), FN-2999 (CLI), FN-3000 (extension)
4. FN-3001 (provider expansion) after parity loop is stable
5. FN-3002 finalization/docs hardening

### 8.2 Adapt vs reimplement guidance

Safe to adapt conceptually (and partially in code with attribution):
- METRIC parser grammar and confidence math approach
- Segment/config-header semantics
- Hook timeout/steer patterns

Must be reimplemented for Fusion conventions:
- Runtime/session event wiring (pi-specific)
- UI widgets/shortcuts/fullscreen TUI flows
- Export server plumbing tied to pi extension APIs
- Git automation policies (must align with Fusion task/run governance)

### 8.3 Package adoption recommendations

Adoptable from upstream ideas (not necessarily direct package imports):
- TypeBox schema patterns for tool parameters.

Should be replaced with Fusion-native equivalents:
- pi-specific UI/event APIs (`@earendil-works/*`) — not portable.
- Direct TUI widget code — translate to dashboard React + CLI outputs.

## 9. Risks, Unknowns, and Recommendations

### Key risks

- **Scope creep risk:** adding provider architecture (FN-3001) can overshadow parity scope.
- **Execution safety risk:** shell command orchestration needs strict guards/timeouts/sandbox policy.
- **Data volume risk:** run outputs can be large; must cap + offload blobs.
- **UX fragmentation risk:** CLI/dashboard/tooling entrypoints must share a single run state model.

### Open questions

- Should Fusion support git auto-commit/revert semantics by default, or behind explicit policy controls?
- Should research runs bind to tasks, missions, or stand-alone entities?
- Is provider architecture mandatory for V1, or staged after parity loop?

### Recommendations

1. Land parity loop first (run/log/confidence/checks/hooks) before provider expansion.
2. Keep DB as source of truth; use filesystem only for oversized artifacts.
3. Build a single orchestrator service used by API, CLI, and extension tools.
4. Add explicit attribution notes if any upstream code is directly copied.

## 10. Addendum (FN-3012): Planned target vs current landed state

This document captures the original porting plan. As of FN-3012 preflight, the repository now has a landed research subsystem in concrete files including:
- `packages/core/src/research-types.ts`, `research-store.ts`, `research-settings.ts`
- `packages/dashboard/src/research-routes.ts` and `packages/dashboard/app/components/ResearchView.tsx`
- `packages/engine/src/research-orchestrator.ts` and `research-step-runner.ts`
- `packages/cli/src/commands/research.ts` and extension tools `fn_research_*`

Important boundary clarification:
- The research subsystem and the insights subsystem are both present and remain separate/parallel (`research_runs`/`research_exports` vs `project_insights`/`project_insight_runs`).
- Follow-on hardening tasks should target current landed files, not the historical placeholder path examples in the original FN-299x chain.

## 11. Addendum (FN-3015): Landed insights-backed regression coverage

FN-3015 hardened regression coverage on the currently shipped insights persistence/API surface (not speculative research-only paths):
- Core store coverage (`packages/core/src/__tests__/insight-store.test.ts`) now locks non-empty run metadata round-trips (`inputMetadata`/`outputMetadata`), terminal `cancelled` semantics, `completedAt` persistence behavior, combined run filter behavior, and `upsertRun` handling for running vs terminal prior runs.
- Route coverage (`packages/dashboard/src/__tests__/insights-routes.test.ts`) now exercises real persistence-backed behavior for `/api/insights` and `/api/insights/runs`, including project-scoped store resolution via `projectId`, filters (`category`, `status`, `runId`, `trigger`), pagination (`limit`/`offset`), invalid input rejection, run failure persistence, and `/api/insights/:id/create-task` payload contracts.
- `/api/insights/runs` now supports validated query filtering (`status`, `trigger`, `limit`, `offset`) in `packages/dashboard/src/insights-routes.ts` so route behavior matches the new regression assertions.

Roadmap-only note:
- This task intentionally did not add or invent new research-runner/retry/export behavior beyond the current landed insights API contracts.
