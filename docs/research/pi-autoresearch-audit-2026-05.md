# pi-autoresearch Audit vs Fusion Research (2026-05)

Date: 2026-05-12  
Task: FN-4136

## Verdict

Fusion's current research subsystem is **not** an autonomous experiment-loop port of upstream `pi-autoresearch`. It is primarily a **provider-driven web/local-docs research pipeline** with optional LLM synthesis, plus a few naming overlaps (`run`, `confidence`, `export`) that make it look closer to upstream than it is. Based on the current types, store, orchestrator, dashboard, CLI, and extension surfaces, this is not a bounded parity gap; **a fundamental redesign is needed** if Fusion intends to support the upstream try-measure-keep-revert workflow rather than generic cited research runs.

## Upstream snapshot

### Snapshot provenance

- Upstream repository: <https://github.com/davebcn87/pi-autoresearch>
- Fetch date: 2026-05-12
- Head commit on `main`: `84232861a09e753f63bceda46852f0ddbb4c9afd`
- Commit date: 2026-05-06T14:06:16Z
- Commit subject: `release: v1.4.0`
- Repository page also showed latest release `v1.4.0` on 2026-05-06.

### What upstream currently is

Upstream still describes itself as an **"Autonomous experiment loop for pi"**. The contract remains centered on a coding agent repeatedly trying code changes, measuring a benchmark, and deciding whether to keep or discard each iteration.

Current upstream surface from the live README/repo page:

- Tool triad:
  - `init_experiment`
  - `run_experiment`
  - `log_experiment`
- `/autoresearch` command family:
  - `/autoresearch <text>`
  - `/autoresearch off`
  - `/autoresearch clear`
  - `/autoresearch export`
- Session artifacts:
  - `autoresearch.jsonl`
  - `autoresearch.md`
  - `autoresearch.sh`
  - `autoresearch.checks.sh`
  - `autoresearch.hooks/before.sh`
  - `autoresearch.hooks/after.sh`
  - `autoresearch.config.json`
  - `autoresearch.ideas.md`
- Loop semantics:
  - edit → commit → `run_experiment` → `log_experiment` → keep or revert → repeat
  - git auto-commit on keep
  - git auto-revert on discard/regression while preserving `autoresearch.*` artifacts
- Measurement semantics:
  - parses `METRIC name=value` lines from benchmark output
  - optional post-benchmark correctness gate via `autoresearch.checks.sh`
  - explicit `checks_failed` status distinct from crashes/regressions
- Statistical semantics:
  - MAD-based confidence score after 3+ experiments
  - confidence is advisory, not an auto-discard policy
- Resume/compaction semantics:
  - append-only JSONL is the durable source of truth
  - deterministic compaction summary rehydrates the loop after context compaction
  - loop re-prompts the agent to re-read `autoresearch.md`, `autoresearch.jsonl`, `autoresearch.ideas.md`, and git log
- Hook semantics:
  - `before.sh` / `after.sh`
  - JSON on stdin
  - stdout becomes steer text to the agent
  - hook fires are appended into `autoresearch.jsonl`
- Loop bounds / controls:
  - `maxIterations` hard cap in `autoresearch.config.json`
  - keyboard shortcuts for dashboard expansion/fullscreen
  - `/autoresearch export` opens a live browser dashboard with auto-updating export
- Finalization semantics:
  - `autoresearch-finalize` splits a noisy branch into reviewable per-change branches from merge-base

### Deltas vs the historical FN-2990 spike document

The historical spike in `docs/research/pi-autoresearch-analysis.md` is directionally accurate about upstream's core identity, but the live upstream README now makes a few changes more explicit:

1. **Shortcut override config is now documented as a shipped feature** (`<agent-dir>/extensions/pi-autoresearch.json` with `toggleDashboard` / `fullscreenDashboard` override-or-null support).
2. **`autoresearch-hooks` is a first-class optional skill** with ten example scripts called out in the README.
3. **Release state has advanced to `v1.4.0`**; the historical spike cited an older head (`376ccc62...`).
4. **The live README is even more explicit that upstream is an optimization loop, not a generic search/synthesis subsystem.**

## Capability mapping

| Upstream concept | Upstream behavior | Fusion equivalent (file:symbol) | Status | Notes |
|---|---|---|---|---|
| Experiment session model | Named optimization session with metric/unit/direction, baseline, best run, segments, keep/discard history | `packages/core/src/research-types.ts:ResearchRun`, `ResearchResult`, `ResearchSource` | missing | Fusion run model is query/sources/findings/citations oriented. No metric/unit/direction/baseline/best-result/keep-discard/session-goal contract exists. |
| Segmented append log | `autoresearch.jsonl` append-only stream with config headers, run rows, hook rows, segment resets | `packages/core/src/research-store.ts`, `research_run_events` table, `research_runs.events` JSON snapshot | partial | Fusion has lifecycle/event logging, but not append-only experiment records, config headers, segment boundaries, or per-iteration measurement rows. |
| `init_experiment` | One-time config of metric semantics and session identity | not present | missing | No API/CLI/tool surface for metric/unit/direction/session initialization. |
| `run_experiment` | Runs workload command, captures output, measures runtime, parses metrics | not present | missing | `ResearchOrchestrator` only searches/fetches/synthesizes (`packages/engine/src/research-orchestrator.ts`). No shell benchmark execution path exists. |
| `log_experiment` | Logs iteration result, status, description/ASI, keep/discard decision, git action | not present | missing | Fusion finalizes a single synthesis result via `runFinalizing()`; there is no iteration logging contract. |
| METRIC parser | Structured `METRIC name=value` extraction from experiment output | not present | missing | No parser or metric-oriented type exists under `packages/core/src/research-*` or `packages/engine/src/research*`. |
| MAD confidence scoring | Robust noise-floor confidence from repeated metric observations | `packages/core/src/research-types.ts:ResearchFinding.confidence`, `packages/engine/src/research/providers/llm-synthesis-provider.ts:extractConfidence()` | divergent-by-design | Fusion's `confidence` is just whatever a synthesis response emits/regex-matches. Same word, completely different semantics. |
| Backpressure checks | Optional `autoresearch.checks.sh` runs after a passing benchmark; can produce `checks_failed` | not present | missing | No checks pipeline, no checks status, no benchmark-vs-correctness split. |
| Hook before/after contract | Executable `before.sh` / `after.sh`, JSON stdin, stdout steer, hook rows in JSONL | not present | missing | No hook files, no hook execution, no steer-message bridge in the research subsystem. |
| Auto-commit / auto-revert policy | Keep improvements, discard regressions, preserve session artifacts | not present | missing | No git mutation policy exists in current research code. |
| Compaction-resilient resume | Rehydrate loop from durable artifacts after compaction/reset | `packages/core/src/research-store.ts` persistence only | missing | Fusion persists runs, but there is no experiment-loop resume protocol, no rehydration summary, and no artifact bundle equivalent to `autoresearch.md` + JSONL tail + ideas + git log. |
| `maxIterations` hard cap | Stops loop after configured experiment count until re-init | rough analog only: `packages/core/src/research-settings.ts` limits and `ResearchOrchestrationConfig.maxSources/maxSynthesisRounds` | divergent-by-design | Fusion caps sources/rounds/duration, not experiment iterations. Same category of “bound” but not the same product behavior. |
| Dashboard live updates | Inline widget/fullscreen TUI plus `/autoresearch export` live browser dashboard | `packages/dashboard/app/components/ResearchView.tsx`, `packages/dashboard/app/hooks/useResearch.ts`, `packages/dashboard/src/sse.ts` | partial | Fusion has a standalone dashboard view with SSE refresh for run rows, but no inline loop widget, no terminal overlay, and no live browser export/share-card equivalent. |
| Finalize-into-branches workflow | `autoresearch-finalize` groups kept changes into clean branches from merge-base | not present | missing | No finalize/group/split workflow exists in dashboard, CLI, extension, or engine research code. |
| Session artifacts | `autoresearch.md`, `autoresearch.sh`, `autoresearch.checks.sh`, hooks dir, config file, ideas file | none in research subsystem; nearest durable output is DB rows + optional exports/documents | missing | Fusion stores structured rows/exports instead of experiment files; there is no script/rules artifact bundle for a fresh agent to resume. |
| Providers / credentials | none; upstream is shell+git oriented | `packages/engine/src/research/provider-registry.ts`, provider implementations, `packages/core/src/research-settings.ts` | divergent-by-design | This is the defining Fusion addition. It expands generic information-gathering ability, but also shifts the subsystem away from upstream parity. |
| CLI parity | upstream `/autoresearch`, `off`, `clear`, `export`; skill-driven create/finalize flow | `packages/cli/src/commands/research.ts` | divergent-by-design | Fusion CLI is CRUD around cited research runs (`create/list/show/export/cancel/retry`), not an experiment-loop controller. |
| pi-extension tool parity | upstream exposes experiment tools (`init_experiment`/`run_experiment`/`log_experiment`) | `packages/cli/src/extension.ts` `fn_research_*` tools | missing | Extension tools manage persisted research runs, but none expose experiment init/run/log semantics. |
| Surface execution consistency | one upstream loop model across tools/command/dashboard | `packages/dashboard/src/research-routes.ts`, `packages/cli/src/extension.ts`, `packages/cli/src/commands/research.ts`, `packages/engine/src/agent-tools.ts` | divergent-by-design | Surfaces with the same research vocabulary do different things: dashboard queues runs, CLI executes locally, extension only creates pending rows, engine agent tools execute directly. |
| Queued-run processing model | `/autoresearch` actually starts/continues the live loop | `packages/dashboard/src/research-routes.ts:POST /runs`, `packages/cli/src/extension.ts:fn_research_run`, `packages/engine/src/project-engine.ts` | partial | Dashboard/extension create queued runs, and the extension tells users to start the engine to process them, but `ProjectEngine` currently constructs `new ResearchStepRunner()` with no provider registry and there is no discovered queued-run pickup loop. |

## Key findings

### 1. Several upstream concepts are structurally impossible on the current schema/contracts

The current core contract (`packages/core/src/research-types.ts`) is centered on:

- query text
- discovered sources
- fetched content
- synthesized findings/citations
- lifecycle/error metadata

That makes these upstream concepts structurally absent rather than merely unimplemented:

- metric definition (`name`, `unit`, `direction`)
- baseline vs best experiment tracking
- keep/discard state per iteration
- benchmark command/script linkage
- experiment segments/config headers
- hook rows
- checks-specific statuses
- git action outcomes
- finalize/group/split metadata

Those are not missing buttons on top of the current schema; they would require **new domain types/store contracts**.

### 2. Fusion has several false-friend names

The biggest false-friend risks are:

- **`confidence`** exists in Fusion, but it is not MAD confidence. It is synthesis-output confidence (`llm-synthesis-provider.ts:extractConfidence()`), which is semantically different from upstream's repeated-measurement noise-floor score.
- **`fn_research_run`** exists in multiple places, but the semantics differ by surface. In `packages/cli/src/extension.ts` it only creates a persisted run and tells the user to start the engine later; in `packages/engine/src/agent-tools.ts` it actually constructs providers and starts the orchestrator immediately.
- **`run` / `retry` / `export`** sound similar to upstream experiment vocabulary, but in Fusion they refer to a search/fetch/synthesize pipeline, not a measured optimization iteration loop.

### 3. Dashboard / CLI / extension are out of sync with each other

Current surface split:

- **Dashboard route** (`packages/dashboard/src/research-routes.ts`) creates rows in the store but does not start orchestration.
- **CLI command** (`packages/cli/src/commands/research.ts`) creates an orchestrator and starts execution directly.
- **pi extension tools** (`packages/cli/src/extension.ts`) create/list/get/cancel/retry store rows but do not start execution; `fn_research_run` explicitly says "Start the project engine to process pending runs".
- **Engine agent tools** (`packages/engine/src/agent-tools.ts`) do start execution directly and are the closest thing to a working end-to-end runtime.
- **Project engine startup** (`packages/engine/src/project-engine.ts`) instantiates `ResearchOrchestrator` with `new ResearchStepRunner()` and no populated provider registry, and no queued-run dispatcher was found during this audit.

So even before comparing Fusion to upstream, Fusion is not presenting one coherent research execution contract to its own users.

## Recommendation

**Recommendation: fundamental redesign needed.**

If Fusion wants upstream parity, the cleanest path is to treat the current provider-based cited-research system and the upstream autoresearch experiment loop as **different products** that may share infrastructure but should not share a misleading single contract. A bounded hardening pass can improve today's subsystem, but it will not make the current `research_runs + sources + synthesis` model faithfully represent upstream's try-measure-keep-revert workflow.

## Follow-up inventory before filing

Known related cards called out in the task prompt:

- `FN-4134` — ResearchView rendering
- `FN-4135` — web search not enabled by default

Board lookup during this audit did not return resolvable task records for `FN-4134` or `FN-4135` in this worktree context, so they could not be used as concrete dedupe targets here. In any case, both are narrow UI/config fixes and do **not** cover the architectural parity gaps documented in this audit.

## Follow-ups filed

| Gap / grouped gaps | Follow-up task | Notes |
|---|---|---|
| Experiment session model, append log, metric fields, segment semantics | `FN-4218` | Schema/contracts task; prerequisite for true upstream parity. |
| init/run/log tool triad, experiment executor loop, METRIC parsing | `FN-4219` | Covers the core missing execution surface. |
| MAD confidence, checks pipeline, hooks, keep/revert git policy, compaction-resume, `maxIterations` | `FN-4220` | Groups the loop-hardening behaviors that depend on a real experiment runtime. |
| Surface alignment across dashboard/CLI/extension/engine; queued-run processing mismatch; browser/live execution handoff | `FN-4221` | Includes the current queued-run pickup inconsistency. |
| Finalize-into-branches workflow | `FN-4222` | Upstream `autoresearch-finalize` parity. |
| Product naming/docs split between cited-provider research and autoresearch parity | `FN-4223` | Addresses false-friend naming and product-boundary drift. |

## Gap-to-task mapping

| Upstream concept | Status | Follow-up |
|---|---|---|
| Experiment session model | missing | `FN-4218` |
| Segmented append log | partial | `FN-4218` |
| `init_experiment` | missing | `FN-4219` |
| `run_experiment` | missing | `FN-4219` |
| `log_experiment` | missing | `FN-4219` |
| METRIC parser | missing | `FN-4219` |
| MAD confidence scoring | divergent-by-design | `FN-4220` |
| Backpressure checks | missing | `FN-4220` |
| Hook before/after contract | missing | `FN-4220` |
| Auto-commit / auto-revert policy | missing | `FN-4220` |
| Compaction-resilient resume | missing | `FN-4220` |
| `maxIterations` hard cap | divergent-by-design | `FN-4220` |
| Dashboard live updates / browser export parity | partial | `FN-4221` |
| Finalize-into-branches workflow | missing | `FN-4222` |
| Session artifacts | missing | `FN-4220` |
| CLI parity | divergent-by-design | `FN-4221` |
| pi-extension tool parity | missing | `FN-4221` |
| Surface execution consistency | divergent-by-design | `FN-4221` |
| Queued-run processing model | partial | `FN-4221` |
