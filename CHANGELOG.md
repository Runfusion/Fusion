# Fusion changelog

User-facing release notes aggregated across all packages. This file is auto-synced from each `packages/*/CHANGELOG.md` by `scripts/release.mjs` — do not edit by hand.

## 0.18.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.18.1
- @fusion/engine@0.18.1
- @fusion-plugin-examples/dependency-graph@0.1.7
- @fusion-plugin-examples/droid-runtime@0.1.2
- @fusion-plugin-examples/hermes-runtime@0.2.26
- @fusion-plugin-examples/openclaw-runtime@0.2.26
- @fusion-plugin-examples/paperclip-runtime@0.2.26

### @fusion/engine

#### Patch Changes

- @fusion/core@0.18.1
- @fusion/pi-claude-cli@0.18.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.18.1

### @runfusion/fusion

#### Patch Changes

- 89401cd: Fix `npx runfusion.ai` failing with `ERR_MODULE_NOT_FOUND: Cannot find package 'dockerode'` by declaring `dockerode` as a runtime dependency of the published CLI package (#33).
- 89401cd: Allow the dashboard task-detail footer action to manually drive PR-first completion when `mergeStrategy` is `pull-request` and `autoMerge` is disabled.

### runfusion.ai

#### Patch Changes

- Updated dependencies [89401cd]
- Updated dependencies [89401cd]
  - @runfusion/fusion@0.18.1

## 0.18.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.18.0
- @fusion/engine@0.18.0
- @fusion-plugin-examples/dependency-graph@0.1.6
- @fusion-plugin-examples/droid-runtime@0.1.1
- @fusion-plugin-examples/hermes-runtime@0.2.25
- @fusion-plugin-examples/openclaw-runtime@0.2.25
- @fusion-plugin-examples/paperclip-runtime@0.2.25

### @fusion/engine

#### Patch Changes

- @fusion/core@0.18.0
- @fusion/pi-claude-cli@0.18.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.18.0

### @runfusion/fusion

#### Minor Changes

- cc5c8c6: Extend dashboard node management with managed Docker node status UI, Docker-specific detail sections, and Docker node status/logs API routes.

#### Patch Changes

- 986a928: Fix dashboard task deletion failing with "still referenced as a dependency" even after the user confirms removing dependency references. The `useTasks` hook's `deleteTask` was dropping its `options` argument, so the `removeDependencyReferences` flag from the confirmation flow never reached the API.
- c00b018: Fix mobile bottom nav bar overlapping the iOS home indicator in installed PWAs and the visible gap between the nav bar and the executor status bar. The nav bar now extends its surface into the safe-area inset so icons sit above the home indicator and the bar meets the status bar flush.
- 66f85da: Treat OpenAI-compatible `finish_reason: repeat` (raised by Moonshot/Kimi when its server-side repetition detector trips) as a soft stop in the engine heartbeat instead of a fatal error, so agent runs survive the truncation and can continue on the next tick.
- 3afb62b: Fix skill name matching between Fusion's two-segment names (e.g. `web-research/SKILL.md`) and pi-coding-agent's bare directory names (e.g. `web-research`). Patterns and requested skill names now strip the `/SKILL.md` suffix before comparison, eliminating spurious "not found in discovered skills" warnings.
- 08d655a: Fix a mobile dashboard regression where closing Planning Mode after keyboard/visualViewport changes could leave board/list content shifted or clipped. Planning Mode now performs mobile viewport teardown (blur + top snap) on close so control returns cleanly to the dashboard.
- d761ea8: Hardened CLI packaging against native module build regressions by asserting `dockerode`/`ssh2`/`cpu-features` remain externalized in tsup bundle config, preventing native `.node` artifact strings from being inlined into the bundle, and declaring `dockerode` as a runtime dependency for published installs.
- 2b102af: Retrying failed `in-review` tasks now keeps them in `in-review` and only clears retry/error state so auto-merge can re-attempt without resetting task worktree state.
- 8cb8055: Agent pause now automatically pauses all assigned tasks; manual pause controls are blocked/hidden for agent-assigned tasks; tasks now show a "paused by agent" indicator.

### runfusion.ai

#### Patch Changes

- Updated dependencies [986a928]
- Updated dependencies [c00b018]
- Updated dependencies [66f85da]
- Updated dependencies [3afb62b]
- Updated dependencies [cc5c8c6]
- Updated dependencies [08d655a]
- Updated dependencies [d761ea8]
- Updated dependencies [2b102af]
- Updated dependencies [8cb8055]
  - @runfusion/fusion@0.18.0

## 0.17.2

### @fusion/core

#### Patch Changes

- 17a6634: Fix pre-merge workflow steps stalling on tasks with no relevant changes (FN-3327 post-mortem).

  - **`@fusion/engine`**: `executeWorkflowStep` now computes the diff scope (`git diff --name-only` plus `--shortstat` against `task.baseCommitSha`) before spawning the reviewer agent and injects a "Diff Scope" block into the system prompt. The block lists every file the task actually changed and adds explicit scoping rules: review only those files, and if none match the step's category respond immediately with a short approval line and stop. Without this, an open-ended review prompt (e.g. WS-005 "Frontend UX Design") would drift into pre-existing files matching the task description's keywords, exhaust the 360 s timeout, and trigger the auto-revive → re-finalize → re-fail loop that had FN-3327 wedged in `in-review`. Both git calls are best-effort; failures degrade to a "no modified files detected" notice rather than blocking the step.
  - **`@fusion/core`**: The built-in `frontend-ux-design` workflow step template (WS-005) now opens with a FAST-BAIL rule telling the reviewer to inspect the Diff Scope first and return an immediate one-line approval when no UI/CSS/component files are present. New installs and freshly-materialized templates pick this up automatically; existing DB rows are unaffected but are still rescued by the executor-side scope injection above.

### @fusion/dashboard

#### Patch Changes

- Updated dependencies [17a6634]
  - @fusion/engine@0.17.2
  - @fusion/core@0.17.2
  - @fusion-plugin-examples/dependency-graph@0.1.5
  - @fusion-plugin-examples/hermes-runtime@0.2.24
  - @fusion-plugin-examples/openclaw-runtime@0.2.24
  - @fusion-plugin-examples/paperclip-runtime@0.2.24

### @fusion/engine

#### Patch Changes

- 17a6634: Fix pre-merge workflow steps stalling on tasks with no relevant changes (FN-3327 post-mortem).

  - **`@fusion/engine`**: `executeWorkflowStep` now computes the diff scope (`git diff --name-only` plus `--shortstat` against `task.baseCommitSha`) before spawning the reviewer agent and injects a "Diff Scope" block into the system prompt. The block lists every file the task actually changed and adds explicit scoping rules: review only those files, and if none match the step's category respond immediately with a short approval line and stop. Without this, an open-ended review prompt (e.g. WS-005 "Frontend UX Design") would drift into pre-existing files matching the task description's keywords, exhaust the 360 s timeout, and trigger the auto-revive → re-finalize → re-fail loop that had FN-3327 wedged in `in-review`. Both git calls are best-effort; failures degrade to a "no modified files detected" notice rather than blocking the step.
  - **`@fusion/core`**: The built-in `frontend-ux-design` workflow step template (WS-005) now opens with a FAST-BAIL rule telling the reviewer to inspect the Diff Scope first and return an immediate one-line approval when no UI/CSS/component files are present. New installs and freshly-materialized templates pick this up automatically; existing DB rows are unaffected but are still rescued by the executor-side scope injection above.

- Updated dependencies [17a6634]
  - @fusion/core@0.17.2
  - @fusion/pi-claude-cli@0.17.2

### @fusion/plugin-sdk

#### Patch Changes

- Updated dependencies [17a6634]
  - @fusion/core@0.17.2

### @runfusion/fusion

#### Patch Changes

- bacc103: Fix Codex auth interoperability, remote OAuth manual-code login flow, and chat fallback/error handling.

### runfusion.ai

#### Patch Changes

- Updated dependencies [bacc103]
  - @runfusion/fusion@0.17.2

## 0.17.1

### @fusion/dashboard

#### Patch Changes

- 08aa64e: Fix mobile keyboard regressions in the dashboard.

  - **Dashboard pushed up after closing a modal on mobile.** Adds a shared `useMobileScrollLock` hook that pins `body` with `position: fixed; top: -scrollY; width: 100%` while a fullscreen mobile overlay is open and restores scroll on cleanup — the same pattern Bootstrap, Headless UI, and Stripe Elements use to prevent iOS Safari from scrolling the document (and shifting `visualViewport.offsetTop`) when an input inside a `position: fixed` overlay is focused. Reference-counted so nested overlays don't release each other's locks. Wired into TodoModal, PlanningModeModal, TaskDetailModal, NewTaskModal, SettingsModal, MailboxModal, AddNodeModal, MissionInterviewModal, MilestoneSliceInterviewModal, SubtaskBreakdownModal, GitHubImportModal, AgentGenerationModal, AgentImportModal, ScriptsModal, ResearchTaskActionModal, and ChatView (replacing its inline body-overflow effect).
  - **Auto-reload prompt missed rebuilds.** Widens `computeBuildVersion` in `vite.config.ts` to hash the entire `app/` source tree (FN-3333 follow-up). The previous version only hashed `app/main.tsx` and `package.json`, so edits to any other component or stylesheet produced an identical build version and the version-check poll never noticed the rebuild.
  - **ChatView composer crawled down with iOS's keyboard-dismiss animation.** `useMobileKeyboard` now requires a focused input for `keyboardOpen=true`. The moment any input blurs, `keyboardOpen` flips to `false` instead of waiting for iOS's slow visualViewport animation to settle (hundreds of ms). This propagates to App-level `mobileKeyboardOpen` so the MobileNavBar reappears and `project-content` regains its nav-bar padding immediately — chat-thread, modals, and any other consumer all snap to their post-keyboard layout in one frame.

- Updated dependencies [c2f6dd3]
  - @fusion/engine@0.17.1
  - @fusion/core@0.17.1
  - @fusion-plugin-examples/dependency-graph@0.1.4
  - @fusion-plugin-examples/hermes-runtime@0.2.23
  - @fusion-plugin-examples/openclaw-runtime@0.2.23
  - @fusion-plugin-examples/paperclip-runtime@0.2.23

### @fusion/engine

#### Patch Changes

- c2f6dd3: Fix heartbeat and manual agent runs ignoring the agent's configured model. The dashboard saves `runtimeConfig.model` as a combined `"provider/modelId"` string, but heartbeat was reading non-existent split `modelProvider`/`modelId` fields, causing sessions to fall through to pi's default model (often `openai-codex`) and fail with "No API key for provider: openai-codex".
  - @fusion/core@0.17.1
  - @fusion/pi-claude-cli@0.17.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.17.1

### runfusion.ai

#### Patch Changes

- @runfusion/fusion@0.17.1

## 0.17.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.17.0
- @fusion/engine@0.17.0
- @fusion-plugin-examples/dependency-graph@0.1.3
- @fusion-plugin-examples/hermes-runtime@0.2.22
- @fusion-plugin-examples/openclaw-runtime@0.2.22
- @fusion-plugin-examples/paperclip-runtime@0.2.22

### @fusion/engine

#### Patch Changes

- @fusion/core@0.17.0
- @fusion/pi-claude-cli@0.17.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.17.0

### @runfusion/fusion

#### Minor Changes

- 6724cf5: Add `autoReloadOnVersionChange` global setting to make the dashboard's automatic reload on version changes optional. Users can disable auto-reload in Settings → General → Updates.
- 7f3fb77: Harden research subsystem with bounded rate/concurrency limits, cancellation safety, timeout handling, bounded retries, and graceful disabled/setup/error states across dashboard, API, CLI, and agent tooling.
- fca870f: Add Docker target connectivity support for local daemon, Docker contexts, and direct host/TLS configuration with dashboard API and UI selectors.
- d812427: Add mesh configuration generation service and API routes for Docker node provisioning (FN-3111). New exports from `@fusion/core`: `MeshConfigGenerator`, `MeshConfigGeneratorInput`, `FullProvisioningInput`, `MeshConnectionConfig`, `MeshConfigResult`.

#### Patch Changes

- ba893b8: Fix chat progress indicator on reload: show "Connecting…" indicator when dashboard reloads during active AI generation
- 5291a6f: Fix custom model providers (e.g., Kimi, LM Studio, Ollama) failing with "No API key" error. The auth storage proxy now reads API keys from models.json as a fallback, and a Proxy set trap ensures the ModelRegistry's fallback resolver works correctly through the proxy.
- 3db1752: Fix Planning Mode modal being pushed up when virtual keyboard opens on mobile. The modal now uses `useMobileKeyboard` to track viewport changes and adjusts its height via CSS variables instead of relying on `100dvh`.
- 85d02c8: Fix spurious "new version" reloads in the dashboard by making the build version deterministic based on git commit hash instead of a random token generated per build.
- ea5b7af: Fix mobile dashboard shifted state after closing Todo modal. The TodoModal now uses `useMobileKeyboard` to track visual viewport changes, preventing the underlying dashboard layout from becoming offset when the virtual keyboard opens and closes.
- a82c3dc: Fix project memory tools failing in fresh worktrees and bundled runtime contexts when an internal memory backend artifact is missing. `fn_memory_search` and `fn_memory_get` now resolve the backend through bundled runtime code instead of a fragile side-load import path.
- a47f319: Restore dashboard chat reply rendering for both full Chat and Quick Chat by fixing shared streaming response behavior and follow-up UX styling isolation regressions.
- 9309c8c: Fix planning mode reasoning visibility: AI thinking output is now preserved as expandable conversation history when transitioning from the loading state to the first question or summary, and when resuming persisted sessions.
- b9b5c08: Fix mobile dashboard layout offset after modal keyboard dismissal. Modal inputs no longer leak keyboard-open state into the underlying dashboard layout, preventing stale bottom-padding offsets.
- c76d138: Fix infinite todo↔in-review loop on tasks whose previous run exhausted their merge budget. The scheduler now resets `mergeRetries` to 0 when dispatching a task to in-progress, so each fresh execution gets a fresh merge budget. Without this, a task with `mergeRetries=MAX` and `status=null` would land back in in-review, the merger would refuse it (`canMergeTask` false), and the ghost-review fallback would bounce it to todo every 10 minutes — before the 30-minute merge-cooldown could elapse.
- 21504f6: Remove "install pi" references from user-facing docs and skill files. Fusion no longer requires pi as a prerequisite — all pi installation instructions and "pi extension" framing have been removed from README, docs, and AI skill files.
- a1a8d03: Fix skill and settings discovery when agent cwd is a worktree path. Previously, agents running in worktrees couldn't find skills, load project settings, or discover extensions because path resolution used the worktree directory directly instead of walking up to the project root.
- 63bb62f: Fix extension provider registration using wrong directory when project runs outside engine's working directory.
- de02fed: Improve merger verification-fix agent: detect stale/missing sibling-workspace `dist/` artifacts (e.g. `Failed to resolve import "./X.js"`, `ERR_MODULE_NOT_FOUND` into another package) and rebuild before assuming a code fix is needed. The agent may also modify files unrelated to the task's original change when needed to make pre-existing build/test breakage on the base branch pass.

### runfusion.ai

#### Patch Changes

- Updated dependencies [6724cf5]
- Updated dependencies [ba893b8]
- Updated dependencies [5291a6f]
- Updated dependencies [3db1752]
- Updated dependencies [85d02c8]
- Updated dependencies [ea5b7af]
- Updated dependencies [7f3fb77]
- Updated dependencies [fca870f]
- Updated dependencies [d812427]
- Updated dependencies [a82c3dc]
- Updated dependencies [a47f319]
- Updated dependencies [9309c8c]
- Updated dependencies [b9b5c08]
- Updated dependencies [c76d138]
- Updated dependencies [21504f6]
- Updated dependencies [a1a8d03]
- Updated dependencies [63bb62f]
- Updated dependencies [de02fed]
  - @runfusion/fusion@0.17.0

## 0.16.0

### @fusion/dashboard

#### Patch Changes

- c769444: Fix `git diff --no-index` calls treating exit code 1 as an error in the dashboard git-routes. `--no-index` exits 1 when files differ — that's the success case for synthetic untracked-file diffs. Switched to `spawn` so we accept exit 0 and 1 with stdout, independent of how callers wrap `execFile`/`promisify`.
  - @fusion/core@0.16.0
  - @fusion/engine@0.16.0
  - @fusion-plugin-examples/dependency-graph@0.1.2
  - @fusion-plugin-examples/hermes-runtime@0.2.21
  - @fusion-plugin-examples/openclaw-runtime@0.2.21
  - @fusion-plugin-examples/paperclip-runtime@0.2.21

### @fusion/engine

#### Patch Changes

- @fusion/core@0.16.0
- @fusion/pi-claude-cli@0.16.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.16.0

### @runfusion/fusion

#### Minor Changes

- 6ae7aef: Add a project-level `completionDocumentationMode` setting (`off`, `changeset`, `changelog`) and use it during triage prompt generation so new task specs automatically require the appropriate completion release-note artifact.

  Also expose the setting in Dashboard → Settings → Project → General and document it in the settings reference.

- 5ebccc4: Add `createAiSession` to `PluginContext` so plugins can create AI sessions through an engine-injected factory without importing `@fusion/engine` directly.
- 17f5d4a: Execute plugin `onSchemaInit` hooks during startup after plugins are loaded, so plugins can register idempotent tables and indexes with the runtime database.

#### Patch Changes

- 41bb6be: Cache the AgentStore SQLite connection per project so the dashboard no longer reopens the database, re-runs migrations, and re-executes `PRAGMA integrity_check` on every `/api/agents` request. On large project databases this turned a sub-100ms call into multi-second latency that bled into every dashboard view fetching the agent list.
- 9c45d24: Cap per-package Vitest worker fan-out to 6 (from `cpus().length - 1`) and lower the root `pnpm test` workspace concurrency from 4 to 2. On high-core developer machines this prevents `pnpm test` from spawning 100+ worker threads, which was saturating CPU and slowing the dashboard while agents ran tests. Override is still available via `VITEST_MAX_WORKERS`.
- 3bafc48: Fix periodic dashboard event-loop stalls caused by synchronous shell-outs and filesystem reads on hot request paths.

  Two distinct sources, both replaced with async equivalents:

  - **`pgrep -f vitest`** ran via `execSync` in `getVitestProcessIds` (`/api/system-stats`, `/api/kill-vitest`) and `killVitestProcesses` (TUI memory-pressure check). On a busy machine `pgrep` walking the process table can take 100ms+; `execSync` blocks the entire Node event loop for that duration, so every concurrent dashboard request hangs while pgrep runs. The TUI variant fired on every memory-pressure tick (every 2s when over threshold), the dashboard variant fired on every system-stats poll (every 5s while the modal is open). Both now use `execFile` with a callback wrapped in a Promise.
  - **`discoverDashboardPiExtensions`** (called from 3 `/api/settings/pi-extensions` routes) did 6+ blocking `existsSync`/`readFileSync` calls per invocation across legacy and fusion settings paths. Converted to `fs.promises.readFile`/`access` and parallelized via `Promise.all`.

- 1744534: Fix dashboard freezing for several seconds while a Fusion agent runs a long verification command (e.g. `pnpm test`).

  Root cause was in `runVerificationCommand`'s output capture (`packages/engine/src/run-verification-tool.ts`). The captured stdout/stderr buffers used a string-concat + re-encode pattern: once total output exceeded 200 KB, every subsequent line did `Buffer.from(buf.tail).subarray(...).toString("utf8")`, allocating and re-decoding the entire ~100 KB tail per line. A vitest run dumping 50k+ lines produced multiple GB of GC churn, which stalled the dashboard event loop in stop-the-world pauses (matching the symptom: occasional multi-second freezes with no CPU spike on the host).

  The buffer is now stored as a chunk array; tail compaction runs only when accumulated size grows past 2× the cap, making per-line append amortized O(1). All 12 existing `run-verification-command` tests pass unchanged.

  Two follow-on changes shipped in the same patch:

  - **Embedded terminal PTY ingestion** (`packages/dashboard/src/terminal-service.ts`) had the same anti-pattern: `outputBuffer.slice(0, 4096)` + `outputBuffer.slice(4096)` on every 4 ms flush tick. Switched to a chunk array with O(1) drain. Throttle bumped from 4 ms to 16 ms (60 fps) and per-flush cap from 4 KB to 64 KB. This was not the cause of the user-reported freeze, but the same O(N²) hazard would surface under any flood from a terminal pane.
  - **Vitest worker fan-out tightened**: per-package cap lowered from `min(6, cpus()-1)` to `min(4, cpus()-1)` in cli/dashboard/desktop/mobile/plugin-sdk/engine (engine had no cap before). Each config now explicitly pins `pool` (`forks` or `threads`) and only sets the matching `poolOptions`, removing the dual-pool declaration. Worst-case `pnpm test` fan-out: ~12 workers → ~8.

- 9619cd1: Speed up dashboard load and interaction for projects with 100+ tasks.

  Two cheap fixes that together cover the dominant hot paths:

  - **DB indexes on `tasks.column` and `tasks.updatedAt`** (migration 59 in `packages/core/src/db.ts`). `listTasks()` filters by `"column"` on every board load, and the SSE/refresh paths sort by `updatedAt`; neither column had an index, so each query did a full table scan plus a temp B-tree sort. With 100+ tasks this becomes the dominant cost on initial load.
  - **Debounce embedded detail-pane fetches** (`packages/dashboard/app/components/ListView.tsx`). `handleEmbeddedOpenDetail` previously fired a full `fetchTaskDetail` (which pulls log + comments) synchronously on every selection change, so rapid keyboard/mouse navigation through a long list would issue a burst of heavy requests. Fetches are now debounced to 200 ms and stale-target requests short-circuit before hitting the server and before applying state.

- 222e11c: Reduce dashboard stalls by clipping oversized agent tool log payloads, bounding the activity API default, and softening live WAL checkpoint behavior.
- 8ba8f63: Avoid nested `.fusion/.fusion` regressions by hardening project-root path handling and stop the CLI binary status probe from executing outdated global `fn` installs just to read their version.
- df04acd: Fix merge commits landing with the bare `feat(FN-XXXX): merge fusion/fn-xxxx` subject. Three fallback commit paths in the merger (auto-resolve-all-conflicts, `-X theirs/ours` side strategy, AI-agent-didn't-commit) now route through the same deterministic message builder as the happy path, so they pick up the AI-generated subject when available. When the AI subject summarizer returns null, the subject is now derived from the branch's first step-commit (with conventional-commit prefix stripped, plus `(+N more)` when multiple commits) instead of falling back to `merge <branch>`. Subject-summarizer timeout raised from 15s to 30s so slow-first-token providers complete instead of silently falling back.
- 2affc14: Fix planning draft sessions losing the user's typed text and model selection between draft create, sidebar reopen, and Start Planning. The agent now receives the freshest persisted `initialPlan` (not the truncated cache from when the draft was first auto-created), drafts that survive a backend restart can still be started, and the model override the user picked at draft time is restored when reopening from the sidebar and threaded through summarize. The sidebar shows the summarized title once available and falls back to a per-draft preview derived from `inputPayload` while the title is still the placeholder — so multiple drafts are distinguishable without leaking raw keystrokes into the persisted title. Titles get re-summarized on textarea blur and modal close so they reflect the final text rather than locking to the first blur snapshot, and the start path skips its own summarize when blur/close already produced a title for the same final text.
- bf7caf5: Fix planning modal final step rendering "Break into Tasks" button offscreen on mobile by stacking the summary action buttons vertically.
- 2769e4a: Fix startup sync errors for step-based automations (auto-summarize, memory dreams) by allowing empty `command` in `updateSchedule` when the schedule has steps.
- e1c1072: Add a dedicated `fallback-used` notification event that fires when Fusion recovers from a retryable model failure by switching to a configured fallback model, and expose it in global notification settings for ntfy/webhook filtering.
- 6b4f28a: Prevent malformed task titles derived from assistant/tool confirmation prose (for example, `Created task **FN-1234** ...`) from being persisted as task titles. The triage finalization/recovery flow now also prefers canonical prompt headings (`# Task: FN-XXXX - Title`) when they match the task ID, so approved specs restore the intended human-readable title in metadata.
- 44cc899: Preserve task step progress when moving tasks back to todo for recovery flows, and add dashboard confirmations that let users choose whether to keep or reset step progress during manual reset-to-todo/triage moves.
- 6bc2de9: Reordered the dashboard TUI Stats panel memory row to show memory usage percentage before absolute used/total values for faster operator scanning.
- 6c5146b: Auto-install the bundled dependency graph plugin on startup and ship its assets in CLI build artifacts so the graph view is available by default.
- 922782f: Bump `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` from 0.70.0 to 0.72.1 across cli, dashboard, and engine. This refreshes the built-in model catalog (`pi-ai/dist/models.generated.js`) that feeds Fusion's `ModelRegistry`, picking up the latest provider/model entries (Anthropic, OpenAI, Codex, Bedrock, etc.) generated from upstream `models.dev`. No Fusion-side API changes.
- adbc613: Group planning model selector and depth controls under a collapsible "Advanced planning settings" disclosure in the Planning Mode modal.
- 8f72eee: Remove the Agents page tree view mode and its associated state, hierarchy hook, and tree-specific styling. The view switcher now supports list, board, and org chart only, reducing maintenance overhead for an unused mode.
- d73070c: Fix triage finalization clobbering its own freshly-written PROMPT.md spec, and fix the older title/description-driven regen path silently dropping `## Review Level` / `## Frontend UX Criteria` and any other sections outside a fixed whitelist. Tasks have been shipping to `todo` (and through to `done`) with empty 70–200 byte specs while the executor agent only saw the original one-line user description; tasks that survived that bug could still come out of triage with their review level reset to 0 and frontend guidance dropped.

  **Root causes.**

  - FN-3056 (May 2) added `taskUpdates.title = promptDeclaredTitle` to `TriageProcessor.finalizeApprovedTask` and called `store.updateTask(task.id, taskUpdates)` while `task.column` was still `'triage'`. A pre-existing block in `TaskStore.updateTask` rewrote PROMPT.md to the bootstrap stub `# {id}: {title}\n\n{description}\n` whenever title/description changed on a triage-column task, overwriting the agent's just-written 6 KB spec with a 150-byte stub before `moveTask` ran.
  - The non-triage branch of the same regen block called `regeneratePrompt`, which rebuilt the file from a fixed section whitelist (`Dependencies`, `Steps`, `File Scope`, `Acceptance Criteria`, `Notifications`). Any section the triage prompt emits outside that whitelist — `## Review Level`, `## Frontend UX Criteria`, custom assessment scoring, anything ad-hoc — was silently dropped on every title or description edit.

  **Fixes.**

  - `packages/core/src/store.ts`: title/description sync is now wrapper-shape-exact, not content-inspecting. The bootstrap stub detector compares the on-disk file against the exact bytes `createTask` would have written for the _pre-update_ title/description (shared `buildBootstrapPrompt` helper), so it never inspects the description body. This is robust to imported issue bodies that contain `## Repro`, `**Created:**`, etc. — earlier heuristic checks (size caps, `##` header presence, `**Created:**` / `**Size:**` markers) misclassified those as real specs. Stub files keep getting fully rewritten so the displayed title/description stay in sync. Real specs get surgical edits only: title changes splice the leading `# ...` heading line and preserve the existing heading style (triage's `# Task: {id} - {title}` vs createTask's `# {id}: {title}`); description changes rewrite only the body of `## Mission`, leaving every other section verbatim. Description-only edits with no `## Mission` section are a no-op rather than a wholesale rebuild. The `regeneratePrompt` whitelist function is removed.
  - `packages/engine/src/triage.ts`: `finalizeApprovedTask` applies the prompt-declared title _after_ `moveTask("todo")` so the column transition happens before any title-driven regen could fire — defense in depth alongside the store-level guard. The `requirePlanApproval` branch folds the title into its existing `awaiting-approval` update.
  - New regression tests in `packages/core/src/__tests__/store.test.ts`: the original bug (real spec on a triage task survives a title change), the false-negative cases (long bootstrap stubs and stubs whose description body contains `##` markdown headings or `**Created:**` / `**Size:**` text are still detected and rewritten), the secondary regression (`## Review Level` and `## Frontend UX Criteria` survive a non-triage title edit), and an end-to-end test that mirrors the exact `TriageProcessor.finalizeApprovedTask` sequence (write spec → updateTask without title → moveTask("todo") → updateTask({title})) on a real `TaskStore` to catch any future regression along the actual finalize path.

### runfusion.ai

#### Patch Changes

- Updated dependencies [41bb6be]
- Updated dependencies [9c45d24]
- Updated dependencies [3bafc48]
- Updated dependencies [1744534]
- Updated dependencies [9619cd1]
- Updated dependencies [222e11c]
- Updated dependencies [8ba8f63]
- Updated dependencies [df04acd]
- Updated dependencies [2affc14]
- Updated dependencies [bf7caf5]
- Updated dependencies [2769e4a]
- Updated dependencies [e1c1072]
- Updated dependencies [6b4f28a]
- Updated dependencies [6ae7aef]
- Updated dependencies [5ebccc4]
- Updated dependencies [17f5d4a]
- Updated dependencies [44cc899]
- Updated dependencies [6bc2de9]
- Updated dependencies [6c5146b]
- Updated dependencies [922782f]
- Updated dependencies [adbc613]
- Updated dependencies [8f72eee]
- Updated dependencies [d73070c]
  - @runfusion/fusion@0.16.0

## 0.15.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.15.0
- @fusion/engine@0.15.0
- @fusion-plugin-examples/dependency-graph@0.1.1
- @fusion-plugin-examples/hermes-runtime@0.2.20
- @fusion-plugin-examples/openclaw-runtime@0.2.20
- @fusion-plugin-examples/paperclip-runtime@0.2.20

### @fusion/engine

#### Patch Changes

- @fusion/core@0.15.0
- @fusion/pi-claude-cli@0.15.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.15.0

### @runfusion/fusion

#### Minor Changes

- 9e52028: Add host support for plugin-registered top-level dashboard views and ship the first plugin-first Graph view surface for dependency visualization.

#### Patch Changes

- ed477f8: Fix recurring SQLite instability under heavy agent logging by tuning WAL pragmas, adding startup integrity detection with non-blocking corruption signaling, batching agent log writes in transactions, and reducing default maintenance cadence to checkpoint WAL more frequently.
- 9fc5fd9: Limit unregistered project detection to the exact current working directory.

### runfusion.ai

#### Patch Changes

- Updated dependencies [ed477f8]
- Updated dependencies [9fc5fd9]
- Updated dependencies [9e52028]
  - @runfusion/fusion@0.15.0

## 0.14.3

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.14.3
- @fusion/engine@0.14.3
- @fusion-plugin-examples/hermes-runtime@0.2.19
- @fusion-plugin-examples/openclaw-runtime@0.2.19
- @fusion-plugin-examples/paperclip-runtime@0.2.19

### @fusion/engine

#### Patch Changes

- @fusion/core@0.14.3
- @fusion/pi-claude-cli@0.14.3

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.14.3

### @runfusion/fusion

#### Patch Changes

- dd291db: Tokenize `isInProcessBackupCommand` so it accepts the full canonical zero-install form `npx -y runfusion.ai backup --create` (and other npx flag combinations such as `--yes`, `-p <pkg>`, `--package=<pkg>`) and refuses commands that embed shell continuations or redirections (`&&`, `||`, `|`, `;`, `>`, `<`, backticks, `$()`). The previous regex permitted only a bare `npx` prefix and silently swallowed any tail after `--create`, which meant `npx -y runfusion.ai backup --create` still hit the legacy shell-out and `fn backup --create && notify-send done` lost its trailing side effect when intercepted. The new matcher only intercepts when the entire command is a plain in-process backup invocation; anything else continues through the shell as authored.
- 3119537: Fix pause handling so restarted or paused engines do not resume work or move recovered tasks into review until execution is resumed, including workflow-step and completion handoff paths.
- 03d0fac: Fix agent run log streaming in the dashboard so latest-run logs load lazily and live log streams stay stable while runs refresh.
- 7fec762: Fix engine startup creating a spurious `.fusion/.fusion/fusion.db` under each project root. The in-process runtime was passing the project's `.fusion` directory to PluginStore, which internally appends `.fusion` again, producing a nested empty database alongside the real one. PluginStore now receives the project root, matching every other call site.
- 24b3ded: Add a global `fnBinaryCheckEnabled` setting that lets users opt out of the dashboard's `fn`/`fusion` CLI binary probe. Default remains true (probe runs as before). When set to false, `GET /system/fn-binary/status` returns `state: "skipped"` without spawning a subprocess, the install banner stays hidden, and `POST /system/fn-binary/install` rejects with HTTP 409. Useful when the running dev process is the source of truth and shelling out to whichever globally-installed `runfusion.ai` happens to be on PATH is unwanted.
- 36d623a: Add a defensive guard in `Database` constructor that throws when opening a database at a path whose last two segments are both `.fusion`. This catches caller bugs where a `.fusion` directory is passed in place of a project root (causing `.fusion/.fusion/fusion.db` to be silently created). Future regressions of this class of bug now fail loudly at the originating call site instead of leaving stray nested directories.
- 5a41ce4: Tighten the in-process backup matcher to the `backup --create` form only and run `fn`/`fusion`/`runfusion.ai` `--version` probes from a temp directory. Previously any subcommand starting with `fn backup` (e.g. `--list`, `--cleanup`, `--restore`) was intercepted by the in-process runner that only knows how to create backups, so a scheduled list/cleanup/restore would silently execute a create instead. The interception now also applies to step-based automations, not just the legacy single-command form. The `--version` probe used by the dashboard fn-binary status route now spawns with `cwd=tmpdir()` so an outdated globally-installed CLI cannot drop a stray `.fusion/.fusion/` tree in the parent project's directory while the probe is running.
- 3119537: Demote pi-claude-cli MCP config refresh log from stderr to debug-only so it no longer surfaces as an error.
- 8592472: Run the auto-backup automation in-process instead of shelling out to whatever fusion binary happens to be on `PATH`. The cron and routine runners now intercept commands matching `fn backup`, `fusion backup`, or `npx runfusion.ai backup` and call `runBackupCommand` directly through the engine's already-open `TaskStore`. This stops the auto-backup from launching an outdated globally-installed fusion binary that could re-introduce already-fixed bugs (most recently the `pluginStore` rootDir mistake that created a stray `.fusion/.fusion/` directory each time the schedule fired). New backup automations are also written with the simpler `fn backup --create` command — existing schedules using the old `npx runfusion.ai` form keep working because both forms hit the same in-process interception.
- 66a19b5: Add mouse-wheel scrolling to the dashboard TUI. Wheel scrolls the focused pane in the task detail logs, Git view (commits/branches/worktrees lists), and Files view (tree selection or preview viewport depending on focus). Uses xterm SGR mouse reporting (`?1000h` + `?1006h`) without motion tracking so Shift+drag native text selection still works.

### runfusion.ai

#### Patch Changes

- Updated dependencies [dd291db]
- Updated dependencies [3119537]
- Updated dependencies [03d0fac]
- Updated dependencies [7fec762]
- Updated dependencies [24b3ded]
- Updated dependencies [36d623a]
- Updated dependencies [5a41ce4]
- Updated dependencies [3119537]
- Updated dependencies [8592472]
- Updated dependencies [66a19b5]
  - @runfusion/fusion@0.14.3

## 0.14.2

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.14.2
- @fusion/engine@0.14.2
- @fusion-plugin-examples/hermes-runtime@0.2.18
- @fusion-plugin-examples/openclaw-runtime@0.2.18
- @fusion-plugin-examples/paperclip-runtime@0.2.18

### @fusion/engine

#### Patch Changes

- @fusion/core@0.14.2
- @fusion/pi-claude-cli@0.14.2

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.14.2

### @runfusion/fusion

#### Patch Changes

- 7ec394a: Keep chat and quick chat visibly in a connecting or thinking state during long Claude CLI responses, and repair missing spaces in some streamed sentence boundaries.
- b3e2b61: Hide deprecated Google Gemini CLI/Antigravity auth providers from dashboard onboarding and Settings while keeping supported Google/Gemini API-key, Google Generative AI, Vertex, and Cloud Code paths intact. Also documents the internal pi-coding-agent v0.71.x upgrade plan for follow-up dependency bump work.
- b3e2b61: Remove redundant `fn_identity` heartbeat tool and trim the inline Identity Snapshot to presence flags + content hashes. Full soul/instructions/memory content is already loaded in the system prompt's Custom Instructions section, so per-tick previews were duplicating multi-KB of context for no verification benefit. Saves prompt tokens on every heartbeat run.

### runfusion.ai

#### Patch Changes

- Updated dependencies [7ec394a]
- Updated dependencies [b3e2b61]
- Updated dependencies [b3e2b61]
  - @runfusion/fusion@0.14.2

## 0.14.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.14.1
- @fusion/engine@0.14.1
- @fusion-plugin-examples/hermes-runtime@0.2.17
- @fusion-plugin-examples/openclaw-runtime@0.2.17
- @fusion-plugin-examples/paperclip-runtime@0.2.17

### @fusion/engine

#### Patch Changes

- @fusion/core@0.14.1
- @fusion/pi-claude-cli@0.14.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.14.1

### @runfusion/fusion

#### Patch Changes

- cafe986: Fix readonly `createFnAgent` sessions to preserve caller-supplied engine custom tools while still excluding host extensions. This restores delegation and memory tools for no-task heartbeat/reviewer readonly sessions without reopening host extension tool injection in summarizer flows.

### runfusion.ai

#### Patch Changes

- Updated dependencies [cafe986]
  - @runfusion/fusion@0.14.1

## 0.14.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.14.0
- @fusion/engine@0.14.0
- @fusion-plugin-examples/hermes-runtime@0.2.16
- @fusion-plugin-examples/openclaw-runtime@0.2.16
- @fusion-plugin-examples/paperclip-runtime@0.2.16

### @fusion/engine

#### Patch Changes

- @fusion/core@0.14.0
- @fusion/pi-claude-cli@0.14.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.14.0

### @runfusion/fusion

#### Minor Changes

- e505bad: Make the `fn` / `fusion` global CLI install discoverable and self-serve from the dashboard.

  - Settings → General now has a **CLI Binary** panel showing whether `fn` (or `fusion`) is on PATH, the resolved version, and a one-click **Install with npm** button that runs `npm install -g runfusion.ai` server-side. The panel also surfaces copy-to-clipboard install commands (`npm install -g runfusion.ai` and `curl -fsSL https://runfusion.ai/install.sh | sh`) for users with non-default npm setups, and reports a permissions hint when `npm install -g` fails with `EACCES`.
  - A first-launch banner nudges users to install when the binary is missing; dismissal is permanent (per-browser localStorage).
  - Fixed scheduled **Database Backup** automations whose persisted command was `fn backup --create` — those failed every run on hosts where the global bin was never linked. A new schema migration (v58) rewrites legacy `fn`/`kb`/`fusion` backup commands to `npx runfusion.ai backup --create`, matching the canonical seed in `syncBackupAutomation`.
  - Added `detectFnBinary()` to `@fusion/core` so server-side code can resolve the right invocation prefix (`fn` > `fusion` > `npx -y runfusion.ai`) without baking a binary name into automations or generated commands.

- 1634ea3: Ship Droid CLI provider integration in the published Fusion CLI bundle by vendoring `@fusion/droid-cli` runtime extension files, so users can enable **Factory AI — via Droid CLI** from dashboard authentication once the `droid` binary is installed and authenticated locally.
- 4231c4a: Split the Star-on-GitHub toggle, CLI Binary panel, and update-check controls into a new **Global → General** settings pane (with an inline **Updates** subsection), separate from the project-scoped Project → General pane. All three are global by nature, and grouping them under Global avoids the impression that they apply only to the active project. The standalone Global → Updates entry has been folded into this pane.

  The CLI Binary panel also drops its own outlined card background and adopts the standard `padding: 0 var(--space-xl)` indent every other top-level child of `.settings-content` uses, so it sits flush with adjacent form groups instead of bleeding to the pane edges.

  Wire `--version` / `-v` in the `fn` / `fusion` bin so it prints the package version and exits before falling through to the default `dashboard` command. Without this, the dashboard's CLI Binary panel reported the installed version as "unknown" because its `<bin> --version` probe was booting the full server instead of getting a version string.

#### Patch Changes

- f0d0f8c: Fix two issues with question display in planning mode:

  - Questions sometimes stayed hidden behind the "thinking" view until the panel was closed and reopened. The live SSE `question` event could be missed (e.g. when the tab was throttled), and the only path that promoted the view was the live event. Add an 8s polling fallback that refetches the session while the view is in the `loading` state and transitions to `question`/`summary` if the server has already moved on, so a dropped event self-heals.
  - Clicking "New Session" and then typing into the textarea jumped the panel back to the previous session's questions. The "resume on open" effect listed `loadSession` in its deps; `loadSession` is recreated whenever `connectToPlanningStream` changes, and the latter depends on `initialPlan`, so each keystroke re-ran the resume effect and reloaded the dismissed session. Track dismissed `resumeSessionId`s in a ref and drop `loadSession` from the effect's deps. Also guard the SSE `onThinking`/`onQuestion`/`onSummary` handlers against late events from a stale connection so they can't overwrite the new session's view.

- 5398bc7: Fixes and a new appearance setting for the AI session notification banner and planning mode UI:

  - Planning mode question list no longer has its own inner scrollbar nested inside the right pane's scrollbar. The inner `.planning-options` `max-height: 40vh` constraint was removed so longer question lists expand naturally and the outer pane handles all scrolling.
  - After a page refresh, the "AI sessions need your input" banner briefly displayed the real session title and then flipped to the literal default "Planning session". `PlanningModeModal` was broadcasting the fallback title via the cross-tab sync channel before `initialPlan` had hydrated on a resumed session, overwriting the API title. The broadcast now omits the title field when no real title is known, so the API title is preserved.
  - Banner dismissals are now persisted to `localStorage` keyed by session `updatedAt`. A dismissed entry stays hidden across refreshes until the session advances (a new question/event arrives), at which point the dismissal is auto-pruned and the banner re-appears.
  - Added a Settings → Appearance toggle to hide the AI session notification banner entirely.

- 80b45d0: Fix per-agent filesystem defaults to use display-name-plus-id directories (for example `ceo-agent2736`) for heartbeat procedure files and managed instruction bundles, while preserving compatibility with legacy id-only and previously created display-name-based paths. Existing agent files are reused in place and are not auto-renamed or deleted during upgrades.
- fd36fbd: Fix heartbeat run prompt composition so manual and automatic runs consistently include agent identity/instructions context and autonomous heartbeat framing for both task-scoped and no-task execution.
- 8b7f20f: Clarify and harden cross-node mesh lifecycle ownership in node startup paths. Peer exchange shutdown is now deterministic (idempotent and waits for in-flight sync), and docs/tests now codify that mesh discovery + peer exchange are owned by `fn serve`/`fn dashboard` process lifecycle rather than per-project runtime startup.
- c08a872: Apply task priority across all Fusion scheduling paths so urgent work overtakes older low-priority work — including the merge queue, which previously merged tasks strictly FIFO.

  - The auto-merge queue now picks the highest-priority eligible task each iteration (`urgent → high → normal → low`, then `createdAt` ASC, then id ASC). Manual `onMerge` resolvers still run before auto-merges so awaited callers aren't starved.
  - Startup, periodic, global-unpause, and engine-unpause sweeps now sort their `listTasks` result by priority before enqueueing, so the first task picked up by `drainMergeQueue`'s single-item fast path is the highest-priority eligible one rather than the oldest. All four sweeps share a new `enqueueEligibleInReviewTasks` helper.
  - Hardened the picker against concurrent queue mutation: it now re-locates the chosen task via `indexOf` after awaiting `getTask`, so a `stop()` clear or pause-handler removal that lands during the await can't splice out the wrong sibling. Drain and picker both re-check `shuttingDown` after the awaits to avoid starting a merge whose queue entry was already cleared.
  - Triage and todo→in-progress scheduling already used the shared `sortTasksByPriorityThenAgeAndId` comparator and continue to apply dependency, overlap, and worktree constraints after the priority sort.

- 0188da7: Raise the per-IP planning session rate limit from 5/hour to 1000/hour. The previous cap was tripping for normal interactive usage during a single session.
- 4d70a9e: Always reload the selected planning session into the right pane when the planning screen is shown. Previously the reload was skipped if an SSE stream was still connected, so a stream that survived close (or one re-established before the reload effect ran) could leave the right view divergent from the sidebar selection. `loadSession` already tears down and reconnects the stream, so the guard was unnecessary; dropping it makes close+reopen — and any other show transition — deterministically refresh the detail view from the server.
- e72eff4: Fix `PATCH /tasks/:id` silently dropping task priority updates. The route handler in the dashboard server was destructuring every editable field from the request body except `priority`, so changing a task's priority via the dashboard task-detail modal had no effect on disk. The handler now accepts `priority`, validates it against the allowed values (`urgent`, `high`, `normal`, `low`) — `null` resets to the default — and forwards it to `store.updateTask`. Combined with the priority-aware merge queue and sweep ordering shipped earlier, dashboard priority changes now actually shift triage, scheduling, and merge order.
- 72ed143: Fix the dashboard usage indicator popup so the footer (Last updated timestamp, Refresh, and Close buttons) is always visible, and make the popup resizable with the size persisted across sessions.

  - Changed the modal/popover to a flex column so the scrollable provider list can shrink while the header and action footer stay pinned. Previously the inner content used `max-height: 60vh` while the popover wrapper capped at 70vh with `overflow: hidden`, which pushed the footer below the visible area on shorter viewports or when many providers were configured.
  - Added native `resize: both` to the desktop popover and modal variants, with sensible min sizes. The popover now anchors via `left` (computed from the trigger button's right edge) instead of `right`, so dragging the bottom-right resize handle behaves as expected.
  - Persist the user's chosen width/height per project in `localStorage` under a new `kb-usage-modal-size` scoped key (debounced via `ResizeObserver`). The saved size is reapplied on next open.

### runfusion.ai

#### Patch Changes

- Updated dependencies [e505bad]
- Updated dependencies [f0d0f8c]
- Updated dependencies [5398bc7]
- Updated dependencies [80b45d0]
- Updated dependencies [fd36fbd]
- Updated dependencies [8b7f20f]
- Updated dependencies [1634ea3]
- Updated dependencies [4231c4a]
- Updated dependencies [c08a872]
- Updated dependencies [0188da7]
- Updated dependencies [4d70a9e]
- Updated dependencies [e72eff4]
- Updated dependencies [72ed143]
  - @runfusion/fusion@0.14.0

## 0.13.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.13.0
- @fusion/engine@0.13.0
- @fusion-plugin-examples/hermes-runtime@0.2.15
- @fusion-plugin-examples/openclaw-runtime@0.2.15
- @fusion-plugin-examples/paperclip-runtime@0.2.15

### @fusion/engine

#### Patch Changes

- @fusion/core@0.13.0
- @fusion/pi-claude-cli@0.13.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.13.0

### @runfusion/fusion

#### Minor Changes

- d18e411: Add Droid CLI provider integration: new auth and status routes (`GET /api/providers/droid-cli/status`, `POST /api/auth/droid-cli`) plus a Settings toggle hook for enabling Droid CLI–based authentication. Wired into the onboarding provider card so users can connect Droid CLI from the same flow as the other providers.
- d18e411: Add an experimental agent onboarding modal that streamlines the handoff from first-run onboarding into the create-agent form, so new users land on a configured agent draft instead of an empty Settings page. Backed by lifecycle tests and gated behind the experimental flag documented in the onboarding docs.
- 56210e0: Planning sidebar now lists every saved planning session, not just active ones, so a session that finishes while the modal is closed remains selectable on refresh — previously the `/api/ai-sessions` listing filtered out `complete` rows and they vanished from the UI even though the result was still in SQLite. Adds the ability to archive and unarchive completed (or errored) planning sessions: a per-row archive button hides terminal sessions from the sidebar, and a "Show archived" toggle reveals them for unarchive. Backed by a new `ai_sessions.archived` column (migration 57), `POST /api/ai-sessions/:id/archive` and `/unarchive` endpoints (only terminal sessions are archivable so live agents can't be orphaned), and `?includeCompleted` / `?includeArchived` query flags on `GET /api/ai-sessions`. Existing consumers (`useBackgroundSessions`, `MissionManager`) are unchanged — they continue to see only active/retryable sessions.

#### Patch Changes

- d18e411: Fix two related CLI-session issues that caused resumed sessions to balloon in size and quick chat to lose continuity:

  - Resumed pi-claude-cli and droid-cli sessions were re-sending the entire conversation transcript over stdin every iteration. `buildResumePrompt` anchored on the last user message and walked forward through preceding tool results, but the only user message stayed at index 0, so each turn duplicated the original query plus a growing stack of tool results into the on-disk session. Anchor on the last assistant message and slice forward instead, so only the genuine delta since the previous turn is sent.
  - Quick chat created a fresh CLI session per user message and faked continuity by stuffing the last 50 messages into the prompt as a "## Previous Conversation" block. Replace that with real session continuity: `chat_sessions` gains a `cliSessionFile` column (migration 56) and ChatManager now reuses the existing pi SessionManager file when present, creating a fresh one on the first turn and persisting its path. The prompt now carries only the new user content.

- 7011831: Replace dashboard runtime dynamic `@fusion/engine` imports with bundler-safe static imports and add regression coverage to prevent reintroduction. This avoids npm-installed runtime failures caused by non-static engine imports that cannot be safely inlined during bundling.

### runfusion.ai

#### Patch Changes

- Updated dependencies [d18e411]
- Updated dependencies [d18e411]
- Updated dependencies [d18e411]
- Updated dependencies [7011831]
- Updated dependencies [56210e0]
  - @runfusion/fusion@0.13.0

## 0.12.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.12.0
- @fusion/engine@0.12.0
- @fusion-plugin-examples/hermes-runtime@0.2.14
- @fusion-plugin-examples/openclaw-runtime@0.2.14
- @fusion-plugin-examples/paperclip-runtime@0.2.14

### @fusion/engine

#### Patch Changes

- @fusion/core@0.12.0
- @fusion/pi-claude-cli@0.12.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.12.0

### @runfusion/fusion

#### Minor Changes

- cf0ea34: Add a new `fn research` command group for managing research runs from the CLI, including create, list, show, export, cancel, and retry flows with JSON-friendly output options.

#### Patch Changes

- bdf91f8: Fix mobile chat view layout when the iOS keyboard is up so the message input stays anchored above the keyboard instead of being pushed to the top of the screen.
- 23134cf: Keep mobile chat composer focused when tapping Send so the keyboard stays open and messages send on the first tap.
- 72dffe4: Fix Quick Chat mobile send button so the first tap while keyboard is open sends the message instead of only dismissing the keyboard.
- 41e5458: Keep the mobile keyboard open in Quick Chat after tapping send so users can continue typing without an extra tap.
- 7f55dde: Preserve Quick Chat input focus on mobile send taps so the keyboard stays open.
- a16ca0a: Seal readonly AI agent sessions so summarizers (title, merge subject, merge body, merge summary) cannot reach host-injected `fn_*` mutation tools or caller-supplied custom tools. Harden all four summarizer system prompts with explicit "do not call tools / treat input as content" framing, wrap the title prompt in a `<description>` delimiter, and sanitize the AI response (strip chatty preambles, markdown emphasis, surrounding quotes, trailing punctuation) before returning. Prevents a class of incidents where the title summarizer would call `fn_task_create` mid-summary and store its chat-style reply as the title.
- ecabab8: Show task provenance as "Created by <agent name>" for agent-created tasks and make the agent name clickable to open the agent detail modal.

### runfusion.ai

#### Patch Changes

- Updated dependencies [cf0ea34]
- Updated dependencies [bdf91f8]
- Updated dependencies [23134cf]
- Updated dependencies [72dffe4]
- Updated dependencies [41e5458]
- Updated dependencies [7f55dde]
- Updated dependencies [a16ca0a]
- Updated dependencies [ecabab8]
  - @runfusion/fusion@0.12.0

## 0.11.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.11.0
- @fusion/engine@0.11.0
- @fusion-plugin-examples/hermes-runtime@0.2.13
- @fusion-plugin-examples/openclaw-runtime@0.2.13
- @fusion-plugin-examples/paperclip-runtime@0.2.13

### @fusion/engine

#### Patch Changes

- @fusion/core@0.11.0
- @fusion/pi-claude-cli@0.11.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.11.0

### @runfusion/fusion

#### Minor Changes

- 28e6819: Add first-class Research configuration and readiness workflows across settings and dashboard surfaces. This introduces scoped Research defaults/overrides, exposes Research in experimental feature toggles, and routes missing-provider/missing-credentials setup through existing Settings and Authentication flows while keeping API keys in auth storage.

#### Patch Changes

- 97bb80e: Fix backup routine sync failures on legacy SQLite databases by backfilling missing `routines` columns (including `agentId`) during database initialization. Auto-backup settings now create/update the `Database Backup` routine without logging `table routines has no column named agentId` on upgraded installs.
- 451c6d8: Add read-only `fn_insight_*` pi extension tools so agents can list and inspect persisted insights and recent insight-generation runs directly from the project `InsightStore`.
- 3443aed: Ship a bundled Nerd Font symbols fallback for the dashboard terminal so patched glyphs render even when users do not have a local Nerd Font installed. The dashboard now preloads `/fonts/SymbolsNerdFontMono-Regular.ttf`, applies it first in the xterm font stack, and includes build-output regression checks for the bundled font artifact and preload reference.
- d7fdff4: Move `experimentalFeatures` and `remoteAccess` from project-scoped settings to global-scoped settings, including settings schema/type updates, save-path migration, dashboard routes/UI, and regression coverage updates.
- 13ed470: Fix the mobile QuickChat panel layout when the iOS keyboard opens. The panel now stays anchored to the visible viewport (no off-screen drift on a refocus after the keyboard was dismissed), the soft keyboard reliably comes up the moment the FAB is tapped (a stealth input claims focus inside the user gesture so iOS opens the keyboard even before the real composer is enabled), the panel snaps back to full height immediately on blur instead of trailing the keyboard slide-down, and the model name in the header pill collapses to a provider icon when it would otherwise overflow.
- 40620a9: Keep the terminal modal header on a single row on mobile. The tab bar now flexes to fill remaining width and stays scrollable, while the action cluster pins to the right edge of the same row instead of stacking onto a second row.

### runfusion.ai

#### Patch Changes

- Updated dependencies [97bb80e]
- Updated dependencies [28e6819]
- Updated dependencies [451c6d8]
- Updated dependencies [3443aed]
- Updated dependencies [d7fdff4]
- Updated dependencies [13ed470]
- Updated dependencies [40620a9]
  - @runfusion/fusion@0.11.0

## 0.10.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.10.0
- @fusion/engine@0.10.0
- @fusion-plugin-examples/hermes-runtime@0.2.12
- @fusion-plugin-examples/openclaw-runtime@0.2.12
- @fusion-plugin-examples/paperclip-runtime@0.2.12

### @fusion/engine

#### Patch Changes

- @fusion/core@0.10.0
- @fusion/pi-claude-cli@0.10.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.10.0

### @runfusion/fusion

#### Minor Changes

- 3218c05: Add support for custom OpenAI-compatible and Anthropic-compatible API providers. Users can add, edit, and remove custom providers from Settings → Authentication or during model onboarding, with automatic ModelRegistry registration and live updates without restart.
- 3fcf5f4: Detect pre-existing Tailscale funnel sessions in Remote Access settings, surface external tunnel status in `/api/remote/status`, and add a kill-external tunnel endpoint plus Settings UI actions to adopt or restart cleanly.

#### Patch Changes

- f7df0d4: Improve mobile keyboard overlap detection so chat layout resizes reliably (including smaller iOS viewport shifts) without pushing fixed app chrome.
- 21402a3: Fix vitest test-harness regressions that masked correct production code as failing tests:

  - Restore `util.promisify(exec)`/`util.promisify(execFile)` to resolve with `{stdout, stderr}` inside the test child-process guard. The previous wrapper dropped the `[util.promisify.custom]` symbol, so awaited `execAsync` resolved to a raw stdout string and broke any test or runtime path that destructured the result (cli `init` git commit flow, core git-remote project-name detection, engine cron-runner / restart / worktree-pool clusters, etc.).
  - Allow cheap CLI introspection invocations (`--version`, `--help`, `which …`) through the AI-CLI block so the dashboard's claude availability probe can tell the truth about the local system. Session-launching invocations (e.g. `claude -p …`, `droid chat`) still throw.
  - Give SIGTERM'd subprocesses a short grace period in the per-test guard's `afterEach` before flagging them as "left running", fixing a race where production code that correctly killed the child was reported as leaking it.
  - Add a test-only `__registerMissionInterviewSessionForTest` helper so SSE replay/buffer tests can exercise the stream manager without spinning up a real AI agent.
  - Fix executor mock to simulate real step-transition semantics (forward moves persist; in-progress regressions on done/skipped steps get rejected) so the new `persistedStatus`-aware response text in `fn_task_update` is exercised correctly.
  - Fix the iOS last-resort path test in `useMobileKeyboard` to actually reach the `gap < 16 && viewportShrink ≥ 16` branch by setting `vv.offsetTop > 0`.
  - Convert `await import("../server.js")` in 14 dashboard route tests to static imports so first-test latency in those files drops from ~2–5s to <200ms.

- 98c3c22: Stop wiping accumulated step progress and the worktree pointer on internal task bounces. Workflow-step REVISE retries, pause→todo handoffs, and the context-overflow fresh-session requeue all moved tasks back to `todo` before returning to `in-progress`, and the default reopen-to-todo path was resetting every step to `pending` and rewriting PROMPT.md checkboxes — so each retry restarted the agent from step 0 even though earlier steps were already done. `moveTask` now accepts a `preserveResumeState` flag that the executor sets on those internal hops; user-initiated "move back to todo" still gets the clean-slate behavior. The context-overflow path additionally clears `sessionFile` synchronously so the next dispatch can no longer reopen the saturated session. `fn_task_update` no longer silently regresses a `done`/`skipped` step to `in-progress`, no longer captures a stale rewind checkpoint when it does, and tells the agent honestly when a regression is ignored. Mobile chat keyboard handling now keeps the layout adjusted on iOS even when the visual-viewport overlap reads as zero (focused input + viewport shrink).
- 491097c: Prefer a Nerd Font-capable monospace stack in the dashboard interactive terminal so powerline/private-use glyphs render correctly when patched fonts are installed, while preserving existing fallback monospace behavior.
- f118606: Stop blocking the Node event loop on every chat send. The pi-claude-cli extension factory used to run two `execSync` probes (`claude --version`, `claude auth status`) on every `createFnAgent` call, which Fusion invokes per chat message — so each send froze every other dashboard API for a few seconds while the Claude CLI cold-started. Probes now run async via `spawn` and are memoized to once per process.

### runfusion.ai

#### Patch Changes

- Updated dependencies [3218c05]
- Updated dependencies [f7df0d4]
- Updated dependencies [21402a3]
- Updated dependencies [3fcf5f4]
- Updated dependencies [98c3c22]
- Updated dependencies [491097c]
- Updated dependencies [f118606]
  - @runfusion/fusion@0.10.0

## 0.9.4

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.9.4
- @fusion/engine@0.9.4
- @fusion-plugin-examples/hermes-runtime@0.2.11
- @fusion-plugin-examples/openclaw-runtime@0.2.11
- @fusion-plugin-examples/paperclip-runtime@0.2.11

### @fusion/engine

#### Patch Changes

- @fusion/core@0.9.4
- @fusion/pi-claude-cli@0.9.4

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.9.4

### @runfusion/fusion

#### Patch Changes

- 299b66e: Fix InProcessRuntime creating a nested `.fusion/.fusion/fusion.db`. RoutineStore was being constructed with the project's `.fusion` directory, but its constructor appends `.fusion` internally. Pass the project root instead, matching AutomationStore.
- c3c8007: Add ghost-review fallback recovery to the self-healing maintenance loop. Catches any `in-review` task that fell through every more-specific recovery scan and has been idle past `taskStuckTimeoutMs`, kicks it back to `todo` with transient status cleared. Preserves human-handoff (`awaiting-user-review`, `awaiting-approval`) and active-merge (`merging`, `merging-pr`) statuses; rate-limited naturally by `updatedAt` refresh so a re-stuck task can only be kicked once per timeout window.
- 24e142d: Merge commits now get an AI-generated summary subject describing what changed (e.g. `feat(FN-XXXX): add user-invited webhook handler`) instead of the bare `feat(FN-XXXX): merge fusion/fn-XXXX`. The merger calls the existing `summarizeCommitSubject` lane alongside the body summarizer; on failure or when disabled, falls back to the legacy `merge <branch>` form.

  Default for `useAiMergeCommitSummary` is now `true` (was `false`). Existing projects that haven't explicitly set the flag will pick up the new behavior on next start. The Settings UI already exposes the toggle.

### runfusion.ai

#### Patch Changes

- Updated dependencies [299b66e]
- Updated dependencies [c3c8007]
- Updated dependencies [24e142d]
  - @runfusion/fusion@0.9.4

## 0.9.3

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.9.3
- @fusion/engine@0.9.3
- @fusion-plugin-examples/hermes-runtime@0.2.10
- @fusion-plugin-examples/openclaw-runtime@0.2.10
- @fusion-plugin-examples/paperclip-runtime@0.2.10

### @fusion/engine

#### Patch Changes

- @fusion/core@0.9.3
- @fusion/pi-claude-cli@0.9.3

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.9.3

### @runfusion/fusion

#### Patch Changes

- bb9b0f1: Preserve in-progress card timers and stats across internal workflow rerun bounces.

### runfusion.ai

#### Patch Changes

- Updated dependencies [bb9b0f1]
  - @runfusion/fusion@0.9.3

## 0.9.2

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.10.0
- @fusion/engine@0.10.0
- @fusion-plugin-examples/hermes-runtime@0.2.9
- @fusion-plugin-examples/openclaw-runtime@0.2.9
- @fusion-plugin-examples/paperclip-runtime@0.2.9

### @fusion/engine

#### Patch Changes

- @fusion/core@0.10.0
- @fusion/pi-claude-cli@0.10.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.10.0

### @runfusion/fusion

#### Minor Changes

- 9e5ac3c: Add an optional `useAiMergeCommitSummary` project setting that enables AI-generated merge commit summaries using the title summarizer model lane, with deterministic fallback when disabled or unavailable.
- 19cdf7f: Add dashboard support for managing custom OpenAI/Anthropic/Google-compatible providers via Settings and onboarding advanced sections, backed by new custom-provider API routes and models.json persistence.
- 7eec105: Heartbeat prompts now re-anchor every tick on a Wake Delta + Heartbeat Procedure (paperclip-parity) so permanent agents stop silently grinding on prior tasks. Each tick the agent receives a structured wake delta (source, wake reason, assigned task, pending messages, triggering comments) and re-runs a 7-step procedure (identity → inbox → wake delta → assignment review → pick action → persist → exit) before continuing prior work.

  The procedure is overridable per agent via a new `heartbeatProcedurePath` field pointing at a project-relative markdown file; the file is reloaded fresh each tick so operators can edit it live without restarting agents. New non-ephemeral agents default to `.fusion/HEARTBEAT.md`, and existing agents can be backfilled onto that path via `POST /api/agents/:id/upgrade-heartbeat-procedure` (also surfaced as an "Upgrade to Default Heartbeat Procedure" button in the agent detail Config tab). The default file is seeded from the built-in template on first use; subsequent edits are preserved.

#### Patch Changes

- 6c051b1: Fix the update notification release notes link so it points to the repo changelog.
- 64b5f67: Register custom providers from global settings with the pi ModelRegistry at startup, so they appear as available models without restart.
- cfc8aa3: Fix TUI header overflow when a remote tunnel is configured. Between 100 and 175 columns the remote URL was pushing the left edge (logo + tabs) offscreen; the remote info now lives in a flex-shrinkable, right-justified slot that truncates instead of overflowing. Also gives the QR overlay a solid background so it no longer renders transparent over the underlying TUI.

### runfusion.ai

#### Patch Changes

- Updated dependencies [9e5ac3c]
- Updated dependencies [19cdf7f]
- Updated dependencies [6c051b1]
- Updated dependencies [7eec105]
- Updated dependencies [64b5f67]
- Updated dependencies [cfc8aa3]
  - @runfusion/fusion@0.10.0

## 0.9.1

### @fusion/core

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.

### @fusion/dashboard

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- Updated dependencies [76deb48]
- Updated dependencies [f6242c2]
  - @fusion/core@0.9.1
  - @fusion/engine@0.9.1
  - @fusion-plugin-examples/hermes-runtime@0.2.8
  - @fusion-plugin-examples/openclaw-runtime@0.2.8
  - @fusion-plugin-examples/paperclip-runtime@0.2.8

### @fusion/desktop

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.

### @fusion/engine

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- Updated dependencies [76deb48]
- Updated dependencies [f6242c2]
  - @fusion/core@0.9.1
  - @fusion/pi-claude-cli@0.9.1

### @fusion/mobile

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.

### @fusion/pi-claude-cli

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.

### @fusion/plugin-sdk

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- Updated dependencies [76deb48]
- Updated dependencies [f6242c2]
  - @fusion/core@0.9.1

### @runfusion/fusion

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- 7e832bb: Clear stale agent task links when tasks become terminal or are deleted, fall back to no-task heartbeat instruction runs for archived assignments, and expand built-in agent prompts with explicit heartbeat guidance.
- 118a03a: Keep experimental dashboard views off by default until project settings enable them.
- 291e156: Improve the Git Manager diff layout and file path truncation in dashboard modals.
- c6d67b9: Insights view: two-pane layout (categories sidebar + scrollable detail), full insight content (no line-clamp), larger action icons, fixed scrolling, and mobile single-row header.
- d8baa7a: Show tasks created from planning sessions on the board immediately without requiring a refresh.

### runfusion.ai

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- Updated dependencies [76deb48]
- Updated dependencies [f6242c2]
- Updated dependencies [7e832bb]
- Updated dependencies [118a03a]
- Updated dependencies [291e156]
- Updated dependencies [c6d67b9]
- Updated dependencies [d8baa7a]
  - @runfusion/fusion@0.9.1

## 0.9.0

### @fusion/core

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.

### @fusion/dashboard

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- 9ce811a: Remote access (Tailscale) overhaul: the auth/scan URL now uses the live `https://<machine>.<tailnet>.ts.net/` URL captured from `tailscale funnel` instead of a constructed `http://<hostname>:<port>` from a configured label, so QR codes lead to a working public endpoint. The hostname label is no longer required (engine validation and the Settings UI both dropped it; `tailscale funnel` never used it). QR codes are now rendered with the `qrcode` library — previously the SVG was just the URL drawn as text — and a new `format=terminal` returns ASCII QR for the TUI. The Tailscale readiness parser now waits for the line containing the URL before flipping to `running`, fixing missing-URL captures. Dashboard polls remote status while `starting`/`stopping` so state updates without reopening the modal. The TUI shows a global `● tunnel` indicator with URL in the header when running, and `Ctrl+Q` opens an ASCII QR overlay anywhere in the app.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.
- Updated dependencies [48208db]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [91f9f20]
- Updated dependencies [b91533c]
- Updated dependencies [7f42c7f]
- Updated dependencies [9ce811a]
- Updated dependencies [17a072c]
- Updated dependencies [1beebc0]
- Updated dependencies [a654795]
- Updated dependencies [bb5402a]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
  - @fusion/core@0.9.0
  - @fusion/engine@0.9.0
  - @fusion-plugin-examples/hermes-runtime@0.2.7
  - @fusion-plugin-examples/openclaw-runtime@0.2.7
  - @fusion-plugin-examples/paperclip-runtime@0.2.7

### @fusion/desktop

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.

### @fusion/engine

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- 9ce811a: Remote access (Tailscale) overhaul: the auth/scan URL now uses the live `https://<machine>.<tailnet>.ts.net/` URL captured from `tailscale funnel` instead of a constructed `http://<hostname>:<port>` from a configured label, so QR codes lead to a working public endpoint. The hostname label is no longer required (engine validation and the Settings UI both dropped it; `tailscale funnel` never used it). QR codes are now rendered with the `qrcode` library — previously the SVG was just the URL drawn as text — and a new `format=terminal` returns ASCII QR for the TUI. The Tailscale readiness parser now waits for the line containing the URL before flipping to `running`, fixing missing-URL captures. Dashboard polls remote status while `starting`/`stopping` so state updates without reopening the modal. The TUI shows a global `● tunnel` indicator with URL in the header when running, and `Ctrl+Q` opens an ASCII QR overlay anywhere in the app.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.
- Updated dependencies [48208db]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [91f9f20]
- Updated dependencies [b91533c]
- Updated dependencies [7f42c7f]
- Updated dependencies [17a072c]
- Updated dependencies [1beebc0]
- Updated dependencies [a654795]
- Updated dependencies [bb5402a]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
  - @fusion/core@0.9.0
  - @fusion/pi-claude-cli@0.9.0

### @fusion/mobile

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.

### @fusion/pi-claude-cli

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.

### @fusion/plugin-sdk

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.
- Updated dependencies [48208db]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [91f9f20]
- Updated dependencies [b91533c]
- Updated dependencies [7f42c7f]
- Updated dependencies [17a072c]
- Updated dependencies [1beebc0]
- Updated dependencies [a654795]
- Updated dependencies [bb5402a]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
  - @fusion/core@0.9.0

### @runfusion/fusion

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- e46f2d4: Add pluggable notification provider system with built-in ntfy and webhook support.
- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- 17a072c: Fix agent heartbeat scheduling so disabled agents stay disabled and active timers are not reset by unrelated agent updates.
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- 9ce811a: Remote access (Tailscale) overhaul: the auth/scan URL now uses the live `https://<machine>.<tailnet>.ts.net/` URL captured from `tailscale funnel` instead of a constructed `http://<hostname>:<port>` from a configured label, so QR codes lead to a working public endpoint. The hostname label is no longer required (engine validation and the Settings UI both dropped it; `tailscale funnel` never used it). QR codes are now rendered with the `qrcode` library — previously the SVG was just the URL drawn as text — and a new `format=terminal` returns ASCII QR for the TUI. The Tailscale readiness parser now waits for the line containing the URL before flipping to `running`, fixing missing-URL captures. Dashboard polls remote status while `starting`/`stopping` so state updates without reopening the modal. The TUI shows a global `● tunnel` indicator with URL in the header when running, and `Ctrl+Q` opens an ASCII QR overlay anywhere in the app.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.

### runfusion.ai

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.
- Updated dependencies [48208db]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [17a072c]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [91f9f20]
- Updated dependencies [e46f2d4]
- Updated dependencies [b91533c]
- Updated dependencies [7f42c7f]
- Updated dependencies [9ce811a]
- Updated dependencies [17a072c]
- Updated dependencies [1beebc0]
- Updated dependencies [a654795]
- Updated dependencies [bb5402a]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
  - @runfusion/fusion@0.9.0

## 0.8.4

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.8.4
- @fusion/engine@0.8.4
- @fusion-plugin-examples/hermes-runtime@0.2.6
- @fusion-plugin-examples/openclaw-runtime@0.2.6
- @fusion-plugin-examples/paperclip-runtime@0.2.6

### @fusion/engine

#### Patch Changes

- @fusion/core@0.8.4
- @fusion/pi-claude-cli@0.8.4

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.8.4

### @runfusion/fusion

#### Patch Changes

- 1c4c08b: Verify and tighten npm bundle fixes from FN-2897: keep the vendored pi-claude-cli runtime on Node built-in child_process APIs (no cross-spawn dependency), confirm Claude CLI extension resolution works from the published dist/pi-claude-cli layout, and ensure prepack strips private @fusion/\* workspace devDependencies from the published package manifest.
- 3202e57: Fix SQLite project and central database validation so dashboard and desktop startup handle corrupt database files more predictably.
- 858e244: Fix the TUI startup update notice to use the same version source and cached update gating as the rest of the CLI.
- 995165e: Fix the dashboard version label so it matches the version used by update notifications.
- bd14cf8: Fix Windows path handling for worktree detection and home-directory lookups.
- 995165e: Fix worktree creation failure when git reports "already checked out at" instead of "already used by worktree at"
- 10d565e: Fix OAuth login redirect for non-localhost dashboard access (Tailscale, Cloudflare, LAN).

### runfusion.ai

#### Patch Changes

- Updated dependencies [1c4c08b]
- Updated dependencies [3202e57]
- Updated dependencies [858e244]
- Updated dependencies [995165e]
- Updated dependencies [bd14cf8]
- Updated dependencies [995165e]
- Updated dependencies [10d565e]
  - @runfusion/fusion@0.8.4

## 0.8.3

### @fusion/dashboard

#### Patch Changes

- 9850bfa: Fix TUI token rendering, memory tracking fix, and other minor improvements
  - @fusion/core@0.8.3
  - @fusion/engine@0.8.3
  - @fusion-plugin-examples/hermes-runtime@0.2.5
  - @fusion-plugin-examples/openclaw-runtime@0.2.5
  - @fusion-plugin-examples/paperclip-runtime@0.2.5

### @fusion/engine

#### Patch Changes

- @fusion/core@0.8.3
- @fusion/pi-claude-cli@0.8.3

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.8.3

### runfusion.ai

#### Patch Changes

- @runfusion/fusion@0.8.3

## 0.8.2

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.8.2
- @fusion/engine@0.8.2
- @fusion-plugin-examples/hermes-runtime@0.2.4
- @fusion-plugin-examples/openclaw-runtime@0.2.4
- @fusion-plugin-examples/paperclip-runtime@0.2.4

### @fusion/engine

#### Patch Changes

- @fusion/core@0.8.2
- @fusion/pi-claude-cli@0.8.2

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.8.2

### @runfusion/fusion

#### Patch Changes

- 531b13e: Recover automatically from SQLite FTS5 corruption errors during task upserts by rebuilding the `tasks_fts` index and retrying once. Also adds FTS5 index rebuild/integrity helpers in core database code and extends task store health checks to validate FTS5 integrity.
- 531b13e: Add executor watchdogs to recover stuck `fn_task_done` and workflow rerun handoffs faster.

### runfusion.ai

#### Patch Changes

- Updated dependencies [531b13e]
- Updated dependencies [531b13e]
  - @runfusion/fusion@0.8.2

## 0.8.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.8.1
- @fusion/engine@0.8.1
- @fusion-plugin-examples/hermes-runtime@0.2.3
- @fusion-plugin-examples/openclaw-runtime@0.2.3
- @fusion-plugin-examples/paperclip-runtime@0.2.3

### @fusion/engine

#### Patch Changes

- @fusion/core@0.8.1
- @fusion/pi-claude-cli@0.8.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.8.1

### @runfusion/fusion

#### Patch Changes

- a8dbdbc: Include linked GitHub issue references (`Ref: owner/repo#N`) in executor and merger commit message instructions and merger fallback commits when tasks are sourced from GitHub issues.

### runfusion.ai

#### Patch Changes

- Updated dependencies [a8dbdbc]
  - @runfusion/fusion@0.8.1

## 0.8.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.8.0
- @fusion/engine@0.8.0
- @fusion-plugin-examples/hermes-runtime@0.2.2
- @fusion-plugin-examples/openclaw-runtime@0.2.2
- @fusion-plugin-examples/paperclip-runtime@0.2.2

### @fusion/engine

#### Patch Changes

- @fusion/core@0.8.0
- @fusion/pi-claude-cli@0.8.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.8.0

### @runfusion/fusion

#### Minor Changes

- 58510e1: Add CLI support for multi-node routing: configure project default node (`fn settings set defaultNodeId`), unavailable-node policy (`fn settings set unavailableNodePolicy`), per-task node overrides (`fn task set-node`, `fn task clear-node`), and `--node` flag for `fn task create`.
- 81c6f01: Add node routing policy enforcement: when a task is routed to a node that is offline or unhealthy, the project's `unavailableNodePolicy` setting controls whether execution is blocked (task stays in todo) or falls back to local execution. Supports `defaultNodeId` project setting for pinned default nodes and per-task `nodeId` overrides. Routing decisions are logged to task activity for visibility.
- c9241d8: Add pluggable notification provider system with built-in ntfy and webhook support.
- 22bac2d: Refactor merge conflict strategies into two `smart-*` flavors and change the default to "prefer main".

  Both smart strategies now run a best-effort `git fetch` + fast-forward of local main from `origin` before the merge cascade — a freshly-pushed sibling commit no longer gets clobbered when the fallback resolves a conflict against a stale base. They differ only in the per-file final fallback:

  - **`smart-prefer-main`** (new default): `-X ours` — main wins. Best when concurrent agents could regress just-merged sibling work.
  - **`smart-prefer-branch`**: `-X theirs` — task branch wins. Equivalent to the previous `"smart"` behavior.

  Legacy enum values are accepted for backwards compatibility and normalized at load time: `"smart"` → `"smart-prefer-branch"`, `"prefer-main"` → `"smart-prefer-main"`. Settings on disk continue to work without changes.

#### Patch Changes

- f19ecac: Add dedicated POST /api/memory/dream endpoint and triggerMemoryDreams() client helper for manual dream processing.
- cc9181d: Recover automatically from SQLite FTS5 corruption during task upserts by rebuilding the `tasks_fts` index and retrying once, and add FTS5 integrity checks to database health monitoring.
- 5cc7597: Fix npm bundle reliability for the published CLI package by removing the vendored pi-claude-cli `cross-spawn` runtime dependency, validating bundled pi-claude-cli resolution from `dist/`, and preventing private `@fusion/*` workspace dev dependencies from leaking into the packed manifest.
- 2029968: Fix project-level model overrides so they take precedence over the default model fallback consistently across dashboard and engine AI flows.
- cd03c6a: Add runfusion.ai links to dashboard update-available notices in the banner and settings modal.
- 7227b87: Add a retry button to failed task error boxes on dashboard task cards so users can retry directly from the card without opening task details.
- 198f85c: Fix dashboard onboarding: the "Welcome to Fusion" setup wizard is now scrollable on short viewports (older laptops / browsers without `dvh` support), and the model-onboarding modal reliably opens after the wizard closes on a fresh install instead of racing it or being suppressed.

### runfusion.ai

#### Patch Changes

- Updated dependencies [f19ecac]
- Updated dependencies [58510e1]
- Updated dependencies [cc9181d]
- Updated dependencies [5cc7597]
- Updated dependencies [2029968]
- Updated dependencies [cd03c6a]
- Updated dependencies [7227b87]
- Updated dependencies [81c6f01]
- Updated dependencies [c9241d8]
- Updated dependencies [198f85c]
- Updated dependencies [22bac2d]
  - @runfusion/fusion@0.8.0

## 0.7.1

### @fusion/core

#### Patch Changes

- ce6dcef: fix(0.7.1): mobile polish, modal layout fixes, paperclip CLI parity, schema migration

  Mobile / dashboard:

  - ModelOnboardingModal: dialog was off-screen on phones because the desktop `min-width: 640px` won over the mobile `max-width: 100%`. Reset min-width/min-height to 0 in the mobile media query (with `!important` so persisted desktop sizes from `useModalResizePersist` cannot re-pin it). Compact provider cards: keep the icon inline beside the name + description, shrink the icon container, drop name/description font sizes, and rely on flex-wrap so the API-key actions still drop to their own row underneath. The API-key input + Save button now live on a single row at the full card width — input grows left-aligned, Save shrinks to the right with a hairline of inline padding.
  - NewAgentDialog: the dialog's top was rendering hidden behind the in-page Agents header on mobile. Render the dialog through `createPortal(..., document.body)` so the overlay escapes the `.agents-view` stacking context. Mobile media query also drops the overlay padding, fills 100vw / 100dvh with safe-area insets on header/footer for iOS notch + home indicator, and fixes the classic flex `min-height: auto` bug that prevented `overflow-y: auto` on the body from activating.
  - TerminalModal: same root cause as the onboarding modal — desktop `min-width: 480px` / `min-height: 320px` pinned the modal off-screen on phones. Reset to 0 in the mobile rule with `!important` so persisted desktop sizes can't override.
  - WorkflowStepManager: fix React error #310 ("Rendered more hooks than during the previous render") that prevented the workflow steps panel from loading. `useOverlayDismiss` was being called after an `if (!isOpen) return null` early return, so the hook count differed between open/closed renders. Moved the hook above the early return.
  - SettingsModal auth panel: tightened `.auth-panel-body` horizontal padding from `--space-xl` (24px) to `--space-md` (12px), giving each provider card more horizontal room.

  Paperclip runtime:

  - CLI parity: in the dashboard's "Local CLI" tab, Test / fetch companies / fetch agents now actually shell out to `paperclipai` instead of making HTTP calls through a derived URL. New CLI-backed variants (`probePaperclipViaCli`, `listCompaniesViaCli`, `listCompanyAgentsViaCli`, `createIssueViaCli`, `getIssueViaCli`, `agentsMeViaCli`) drive every Paperclip call that has a CLI counterpart; the runtime adapter routes through them when `transport=cli`. `getIssueComments` / `wakeAgent` / `getRunEvents` continue using HTTP (no matching `paperclipai` subcommands) but rely on the apiKey discovered from the local paperclipai config so CLI mode works end-to-end.
  - New dashboard routes `/providers/paperclip/cli-status`, `/cli-companies`, `/cli-agents` exposing the CLI helpers.

  Plugin runtime registry:

  - `GET /api/plugins/runtimes` now merges a bundled hermes/openclaw/paperclip fallback list on top of installed plugins, so the NewAgentDialog "Plugin Runtime" dropdown populates without requiring `fn plugin install` on a fresh setup. Installed plugins override the bundled entry by `runtimeId`. Coalesced the optional `version` field to `"0.0.0"` to satisfy the bundled-runtime type.

  Core:

  - Schema migration fix: bumped `SCHEMA_VERSION` from 48 → 49 so migration 49 (per-task `nodeId` column for remote-node routing) actually runs. Existing DBs at version 48 hit the early-return guard, never created the column, and `TaskStore.listTasks` crashed at startup with `no such column: nodeId` — the dashboard exited before initialization. The bump unblocks app startup on any pre-existing 0.7.0 install.

### @fusion/dashboard

#### Patch Changes

- ce6dcef: fix(0.7.1): mobile polish, modal layout fixes, paperclip CLI parity, schema migration

  Mobile / dashboard:

  - ModelOnboardingModal: dialog was off-screen on phones because the desktop `min-width: 640px` won over the mobile `max-width: 100%`. Reset min-width/min-height to 0 in the mobile media query (with `!important` so persisted desktop sizes from `useModalResizePersist` cannot re-pin it). Compact provider cards: keep the icon inline beside the name + description, shrink the icon container, drop name/description font sizes, and rely on flex-wrap so the API-key actions still drop to their own row underneath. The API-key input + Save button now live on a single row at the full card width — input grows left-aligned, Save shrinks to the right with a hairline of inline padding.
  - NewAgentDialog: the dialog's top was rendering hidden behind the in-page Agents header on mobile. Render the dialog through `createPortal(..., document.body)` so the overlay escapes the `.agents-view` stacking context. Mobile media query also drops the overlay padding, fills 100vw / 100dvh with safe-area insets on header/footer for iOS notch + home indicator, and fixes the classic flex `min-height: auto` bug that prevented `overflow-y: auto` on the body from activating.
  - TerminalModal: same root cause as the onboarding modal — desktop `min-width: 480px` / `min-height: 320px` pinned the modal off-screen on phones. Reset to 0 in the mobile rule with `!important` so persisted desktop sizes can't override.
  - WorkflowStepManager: fix React error #310 ("Rendered more hooks than during the previous render") that prevented the workflow steps panel from loading. `useOverlayDismiss` was being called after an `if (!isOpen) return null` early return, so the hook count differed between open/closed renders. Moved the hook above the early return.
  - SettingsModal auth panel: tightened `.auth-panel-body` horizontal padding from `--space-xl` (24px) to `--space-md` (12px), giving each provider card more horizontal room.

  Paperclip runtime:

  - CLI parity: in the dashboard's "Local CLI" tab, Test / fetch companies / fetch agents now actually shell out to `paperclipai` instead of making HTTP calls through a derived URL. New CLI-backed variants (`probePaperclipViaCli`, `listCompaniesViaCli`, `listCompanyAgentsViaCli`, `createIssueViaCli`, `getIssueViaCli`, `agentsMeViaCli`) drive every Paperclip call that has a CLI counterpart; the runtime adapter routes through them when `transport=cli`. `getIssueComments` / `wakeAgent` / `getRunEvents` continue using HTTP (no matching `paperclipai` subcommands) but rely on the apiKey discovered from the local paperclipai config so CLI mode works end-to-end.
  - New dashboard routes `/providers/paperclip/cli-status`, `/cli-companies`, `/cli-agents` exposing the CLI helpers.

  Plugin runtime registry:

  - `GET /api/plugins/runtimes` now merges a bundled hermes/openclaw/paperclip fallback list on top of installed plugins, so the NewAgentDialog "Plugin Runtime" dropdown populates without requiring `fn plugin install` on a fresh setup. Installed plugins override the bundled entry by `runtimeId`. Coalesced the optional `version` field to `"0.0.0"` to satisfy the bundled-runtime type.

  Core:

  - Schema migration fix: bumped `SCHEMA_VERSION` from 48 → 49 so migration 49 (per-task `nodeId` column for remote-node routing) actually runs. Existing DBs at version 48 hit the early-return guard, never created the column, and `TaskStore.listTasks` crashed at startup with `no such column: nodeId` — the dashboard exited before initialization. The bump unblocks app startup on any pre-existing 0.7.0 install.

- Updated dependencies [ce6dcef]
  - @fusion/core@0.7.1
  - @fusion/engine@0.7.1
  - @fusion-plugin-examples/hermes-runtime@0.2.1
  - @fusion-plugin-examples/openclaw-runtime@0.2.1
  - @fusion-plugin-examples/paperclip-runtime@0.2.1

### @fusion/desktop

#### Patch Changes

- ce6dcef: fix(0.7.1): mobile polish, modal layout fixes, paperclip CLI parity, schema migration

  Mobile / dashboard:

  - ModelOnboardingModal: dialog was off-screen on phones because the desktop `min-width: 640px` won over the mobile `max-width: 100%`. Reset min-width/min-height to 0 in the mobile media query (with `!important` so persisted desktop sizes from `useModalResizePersist` cannot re-pin it). Compact provider cards: keep the icon inline beside the name + description, shrink the icon container, drop name/description font sizes, and rely on flex-wrap so the API-key actions still drop to their own row underneath. The API-key input + Save button now live on a single row at the full card width — input grows left-aligned, Save shrinks to the right with a hairline of inline padding.
  - NewAgentDialog: the dialog's top was rendering hidden behind the in-page Agents header on mobile. Render the dialog through `createPortal(..., document.body)` so the overlay escapes the `.agents-view` stacking context. Mobile media query also drops the overlay padding, fills 100vw / 100dvh with safe-area insets on header/footer for iOS notch + home indicator, and fixes the classic flex `min-height: auto` bug that prevented `overflow-y: auto` on the body from activating.
  - TerminalModal: same root cause as the onboarding modal — desktop `min-width: 480px` / `min-height: 320px` pinned the modal off-screen on phones. Reset to 0 in the mobile rule with `!important` so persisted desktop sizes can't override.
  - WorkflowStepManager: fix React error #310 ("Rendered more hooks than during the previous render") that prevented the workflow steps panel from loading. `useOverlayDismiss` was being called after an `if (!isOpen) return null` early return, so the hook count differed between open/closed renders. Moved the hook above the early return.
  - SettingsModal auth panel: tightened `.auth-panel-body` horizontal padding from `--space-xl` (24px) to `--space-md` (12px), giving each provider card more horizontal room.

  Paperclip runtime:

  - CLI parity: in the dashboard's "Local CLI" tab, Test / fetch companies / fetch agents now actually shell out to `paperclipai` instead of making HTTP calls through a derived URL. New CLI-backed variants (`probePaperclipViaCli`, `listCompaniesViaCli`, `listCompanyAgentsViaCli`, `createIssueViaCli`, `getIssueViaCli`, `agentsMeViaCli`) drive every Paperclip call that has a CLI counterpart; the runtime adapter routes through them when `transport=cli`. `getIssueComments` / `wakeAgent` / `getRunEvents` continue using HTTP (no matching `paperclipai` subcommands) but rely on the apiKey discovered from the local paperclipai config so CLI mode works end-to-end.
  - New dashboard routes `/providers/paperclip/cli-status`, `/cli-companies`, `/cli-agents` exposing the CLI helpers.

  Plugin runtime registry:

  - `GET /api/plugins/runtimes` now merges a bundled hermes/openclaw/paperclip fallback list on top of installed plugins, so the NewAgentDialog "Plugin Runtime" dropdown populates without requiring `fn plugin install` on a fresh setup. Installed plugins override the bundled entry by `runtimeId`. Coalesced the optional `version` field to `"0.0.0"` to satisfy the bundled-runtime type.

  Core:

  - Schema migration fix: bumped `SCHEMA_VERSION` from 48 → 49 so migration 49 (per-task `nodeId` column for remote-node routing) actually runs. Existing DBs at version 48 hit the early-return guard, never created the column, and `TaskStore.listTasks` crashed at startup with `no such column: nodeId` — the dashboard exited before initialization. The bump unblocks app startup on any pre-existing 0.7.0 install.

### @fusion/engine

#### Patch Changes

- ce6dcef: fix(0.7.1): mobile polish, modal layout fixes, paperclip CLI parity, schema migration

  Mobile / dashboard:

  - ModelOnboardingModal: dialog was off-screen on phones because the desktop `min-width: 640px` won over the mobile `max-width: 100%`. Reset min-width/min-height to 0 in the mobile media query (with `!important` so persisted desktop sizes from `useModalResizePersist` cannot re-pin it). Compact provider cards: keep the icon inline beside the name + description, shrink the icon container, drop name/description font sizes, and rely on flex-wrap so the API-key actions still drop to their own row underneath. The API-key input + Save button now live on a single row at the full card width — input grows left-aligned, Save shrinks to the right with a hairline of inline padding.
  - NewAgentDialog: the dialog's top was rendering hidden behind the in-page Agents header on mobile. Render the dialog through `createPortal(..., document.body)` so the overlay escapes the `.agents-view` stacking context. Mobile media query also drops the overlay padding, fills 100vw / 100dvh with safe-area insets on header/footer for iOS notch + home indicator, and fixes the classic flex `min-height: auto` bug that prevented `overflow-y: auto` on the body from activating.
  - TerminalModal: same root cause as the onboarding modal — desktop `min-width: 480px` / `min-height: 320px` pinned the modal off-screen on phones. Reset to 0 in the mobile rule with `!important` so persisted desktop sizes can't override.
  - WorkflowStepManager: fix React error #310 ("Rendered more hooks than during the previous render") that prevented the workflow steps panel from loading. `useOverlayDismiss` was being called after an `if (!isOpen) return null` early return, so the hook count differed between open/closed renders. Moved the hook above the early return.
  - SettingsModal auth panel: tightened `.auth-panel-body` horizontal padding from `--space-xl` (24px) to `--space-md` (12px), giving each provider card more horizontal room.

  Paperclip runtime:

  - CLI parity: in the dashboard's "Local CLI" tab, Test / fetch companies / fetch agents now actually shell out to `paperclipai` instead of making HTTP calls through a derived URL. New CLI-backed variants (`probePaperclipViaCli`, `listCompaniesViaCli`, `listCompanyAgentsViaCli`, `createIssueViaCli`, `getIssueViaCli`, `agentsMeViaCli`) drive every Paperclip call that has a CLI counterpart; the runtime adapter routes through them when `transport=cli`. `getIssueComments` / `wakeAgent` / `getRunEvents` continue using HTTP (no matching `paperclipai` subcommands) but rely on the apiKey discovered from the local paperclipai config so CLI mode works end-to-end.
  - New dashboard routes `/providers/paperclip/cli-status`, `/cli-companies`, `/cli-agents` exposing the CLI helpers.

  Plugin runtime registry:

  - `GET /api/plugins/runtimes` now merges a bundled hermes/openclaw/paperclip fallback list on top of installed plugins, so the NewAgentDialog "Plugin Runtime" dropdown populates without requiring `fn plugin install` on a fresh setup. Installed plugins override the bundled entry by `runtimeId`. Coalesced the optional `version` field to `"0.0.0"` to satisfy the bundled-runtime type.

  Core:

  - Schema migration fix: bumped `SCHEMA_VERSION` from 48 → 49 so migration 49 (per-task `nodeId` column for remote-node routing) actually runs. Existing DBs at version 48 hit the early-return guard, never created the column, and `TaskStore.listTasks` crashed at startup with `no such column: nodeId` — the dashboard exited before initialization. The bump unblocks app startup on any pre-existing 0.7.0 install.

- Updated dependencies [ce6dcef]
  - @fusion/core@0.7.1
  - @fusion/pi-claude-cli@0.7.1

### @fusion/mobile

#### Patch Changes

- ce6dcef: fix(0.7.1): mobile polish, modal layout fixes, paperclip CLI parity, schema migration

  Mobile / dashboard:

  - ModelOnboardingModal: dialog was off-screen on phones because the desktop `min-width: 640px` won over the mobile `max-width: 100%`. Reset min-width/min-height to 0 in the mobile media query (with `!important` so persisted desktop sizes from `useModalResizePersist` cannot re-pin it). Compact provider cards: keep the icon inline beside the name + description, shrink the icon container, drop name/description font sizes, and rely on flex-wrap so the API-key actions still drop to their own row underneath. The API-key input + Save button now live on a single row at the full card width — input grows left-aligned, Save shrinks to the right with a hairline of inline padding.
  - NewAgentDialog: the dialog's top was rendering hidden behind the in-page Agents header on mobile. Render the dialog through `createPortal(..., document.body)` so the overlay escapes the `.agents-view` stacking context. Mobile media query also drops the overlay padding, fills 100vw / 100dvh with safe-area insets on header/footer for iOS notch + home indicator, and fixes the classic flex `min-height: auto` bug that prevented `overflow-y: auto` on the body from activating.
  - TerminalModal: same root cause as the onboarding modal — desktop `min-width: 480px` / `min-height: 320px` pinned the modal off-screen on phones. Reset to 0 in the mobile rule with `!important` so persisted desktop sizes can't override.
  - WorkflowStepManager: fix React error #310 ("Rendered more hooks than during the previous render") that prevented the workflow steps panel from loading. `useOverlayDismiss` was being called after an `if (!isOpen) return null` early return, so the hook count differed between open/closed renders. Moved the hook above the early return.
  - SettingsModal auth panel: tightened `.auth-panel-body` horizontal padding from `--space-xl` (24px) to `--space-md` (12px), giving each provider card more horizontal room.

  Paperclip runtime:

  - CLI parity: in the dashboard's "Local CLI" tab, Test / fetch companies / fetch agents now actually shell out to `paperclipai` instead of making HTTP calls through a derived URL. New CLI-backed variants (`probePaperclipViaCli`, `listCompaniesViaCli`, `listCompanyAgentsViaCli`, `createIssueViaCli`, `getIssueViaCli`, `agentsMeViaCli`) drive every Paperclip call that has a CLI counterpart; the runtime adapter routes through them when `transport=cli`. `getIssueComments` / `wakeAgent` / `getRunEvents` continue using HTTP (no matching `paperclipai` subcommands) but rely on the apiKey discovered from the local paperclipai config so CLI mode works end-to-end.
  - New dashboard routes `/providers/paperclip/cli-status`, `/cli-companies`, `/cli-agents` exposing the CLI helpers.

  Plugin runtime registry:

  - `GET /api/plugins/runtimes` now merges a bundled hermes/openclaw/paperclip fallback list on top of installed plugins, so the NewAgentDialog "Plugin Runtime" dropdown populates without requiring `fn plugin install` on a fresh setup. Installed plugins override the bundled entry by `runtimeId`. Coalesced the optional `version` field to `"0.0.0"` to satisfy the bundled-runtime type.

  Core:

  - Schema migration fix: bumped `SCHEMA_VERSION` from 48 → 49 so migration 49 (per-task `nodeId` column for remote-node routing) actually runs. Existing DBs at version 48 hit the early-return guard, never created the column, and `TaskStore.listTasks` crashed at startup with `no such column: nodeId` — the dashboard exited before initialization. The bump unblocks app startup on any pre-existing 0.7.0 install.

### @fusion/pi-claude-cli

#### Patch Changes

- ce6dcef: fix(0.7.1): mobile polish, modal layout fixes, paperclip CLI parity, schema migration

  Mobile / dashboard:

  - ModelOnboardingModal: dialog was off-screen on phones because the desktop `min-width: 640px` won over the mobile `max-width: 100%`. Reset min-width/min-height to 0 in the mobile media query (with `!important` so persisted desktop sizes from `useModalResizePersist` cannot re-pin it). Compact provider cards: keep the icon inline beside the name + description, shrink the icon container, drop name/description font sizes, and rely on flex-wrap so the API-key actions still drop to their own row underneath. The API-key input + Save button now live on a single row at the full card width — input grows left-aligned, Save shrinks to the right with a hairline of inline padding.
  - NewAgentDialog: the dialog's top was rendering hidden behind the in-page Agents header on mobile. Render the dialog through `createPortal(..., document.body)` so the overlay escapes the `.agents-view` stacking context. Mobile media query also drops the overlay padding, fills 100vw / 100dvh with safe-area insets on header/footer for iOS notch + home indicator, and fixes the classic flex `min-height: auto` bug that prevented `overflow-y: auto` on the body from activating.
  - TerminalModal: same root cause as the onboarding modal — desktop `min-width: 480px` / `min-height: 320px` pinned the modal off-screen on phones. Reset to 0 in the mobile rule with `!important` so persisted desktop sizes can't override.
  - WorkflowStepManager: fix React error #310 ("Rendered more hooks than during the previous render") that prevented the workflow steps panel from loading. `useOverlayDismiss` was being called after an `if (!isOpen) return null` early return, so the hook count differed between open/closed renders. Moved the hook above the early return.
  - SettingsModal auth panel: tightened `.auth-panel-body` horizontal padding from `--space-xl` (24px) to `--space-md` (12px), giving each provider card more horizontal room.

  Paperclip runtime:

  - CLI parity: in the dashboard's "Local CLI" tab, Test / fetch companies / fetch agents now actually shell out to `paperclipai` instead of making HTTP calls through a derived URL. New CLI-backed variants (`probePaperclipViaCli`, `listCompaniesViaCli`, `listCompanyAgentsViaCli`, `createIssueViaCli`, `getIssueViaCli`, `agentsMeViaCli`) drive every Paperclip call that has a CLI counterpart; the runtime adapter routes through them when `transport=cli`. `getIssueComments` / `wakeAgent` / `getRunEvents` continue using HTTP (no matching `paperclipai` subcommands) but rely on the apiKey discovered from the local paperclipai config so CLI mode works end-to-end.
  - New dashboard routes `/providers/paperclip/cli-status`, `/cli-companies`, `/cli-agents` exposing the CLI helpers.

  Plugin runtime registry:

  - `GET /api/plugins/runtimes` now merges a bundled hermes/openclaw/paperclip fallback list on top of installed plugins, so the NewAgentDialog "Plugin Runtime" dropdown populates without requiring `fn plugin install` on a fresh setup. Installed plugins override the bundled entry by `runtimeId`. Coalesced the optional `version` field to `"0.0.0"` to satisfy the bundled-runtime type.

  Core:

  - Schema migration fix: bumped `SCHEMA_VERSION` from 48 → 49 so migration 49 (per-task `nodeId` column for remote-node routing) actually runs. Existing DBs at version 48 hit the early-return guard, never created the column, and `TaskStore.listTasks` crashed at startup with `no such column: nodeId` — the dashboard exited before initialization. The bump unblocks app startup on any pre-existing 0.7.0 install.

### @fusion/plugin-sdk

#### Patch Changes

- ce6dcef: fix(0.7.1): mobile polish, modal layout fixes, paperclip CLI parity, schema migration

  Mobile / dashboard:

  - ModelOnboardingModal: dialog was off-screen on phones because the desktop `min-width: 640px` won over the mobile `max-width: 100%`. Reset min-width/min-height to 0 in the mobile media query (with `!important` so persisted desktop sizes from `useModalResizePersist` cannot re-pin it). Compact provider cards: keep the icon inline beside the name + description, shrink the icon container, drop name/description font sizes, and rely on flex-wrap so the API-key actions still drop to their own row underneath. The API-key input + Save button now live on a single row at the full card width — input grows left-aligned, Save shrinks to the right with a hairline of inline padding.
  - NewAgentDialog: the dialog's top was rendering hidden behind the in-page Agents header on mobile. Render the dialog through `createPortal(..., document.body)` so the overlay escapes the `.agents-view` stacking context. Mobile media query also drops the overlay padding, fills 100vw / 100dvh with safe-area insets on header/footer for iOS notch + home indicator, and fixes the classic flex `min-height: auto` bug that prevented `overflow-y: auto` on the body from activating.
  - TerminalModal: same root cause as the onboarding modal — desktop `min-width: 480px` / `min-height: 320px` pinned the modal off-screen on phones. Reset to 0 in the mobile rule with `!important` so persisted desktop sizes can't override.
  - WorkflowStepManager: fix React error #310 ("Rendered more hooks than during the previous render") that prevented the workflow steps panel from loading. `useOverlayDismiss` was being called after an `if (!isOpen) return null` early return, so the hook count differed between open/closed renders. Moved the hook above the early return.
  - SettingsModal auth panel: tightened `.auth-panel-body` horizontal padding from `--space-xl` (24px) to `--space-md` (12px), giving each provider card more horizontal room.

  Paperclip runtime:

  - CLI parity: in the dashboard's "Local CLI" tab, Test / fetch companies / fetch agents now actually shell out to `paperclipai` instead of making HTTP calls through a derived URL. New CLI-backed variants (`probePaperclipViaCli`, `listCompaniesViaCli`, `listCompanyAgentsViaCli`, `createIssueViaCli`, `getIssueViaCli`, `agentsMeViaCli`) drive every Paperclip call that has a CLI counterpart; the runtime adapter routes through them when `transport=cli`. `getIssueComments` / `wakeAgent` / `getRunEvents` continue using HTTP (no matching `paperclipai` subcommands) but rely on the apiKey discovered from the local paperclipai config so CLI mode works end-to-end.
  - New dashboard routes `/providers/paperclip/cli-status`, `/cli-companies`, `/cli-agents` exposing the CLI helpers.

  Plugin runtime registry:

  - `GET /api/plugins/runtimes` now merges a bundled hermes/openclaw/paperclip fallback list on top of installed plugins, so the NewAgentDialog "Plugin Runtime" dropdown populates without requiring `fn plugin install` on a fresh setup. Installed plugins override the bundled entry by `runtimeId`. Coalesced the optional `version` field to `"0.0.0"` to satisfy the bundled-runtime type.

  Core:

  - Schema migration fix: bumped `SCHEMA_VERSION` from 48 → 49 so migration 49 (per-task `nodeId` column for remote-node routing) actually runs. Existing DBs at version 48 hit the early-return guard, never created the column, and `TaskStore.listTasks` crashed at startup with `no such column: nodeId` — the dashboard exited before initialization. The bump unblocks app startup on any pre-existing 0.7.0 install.

- Updated dependencies [ce6dcef]
  - @fusion/core@0.7.1

### @runfusion/fusion

#### Patch Changes

- ce6dcef: fix(0.7.1): mobile polish, modal layout fixes, paperclip CLI parity, schema migration

  Mobile / dashboard:

  - ModelOnboardingModal: dialog was off-screen on phones because the desktop `min-width: 640px` won over the mobile `max-width: 100%`. Reset min-width/min-height to 0 in the mobile media query (with `!important` so persisted desktop sizes from `useModalResizePersist` cannot re-pin it). Compact provider cards: keep the icon inline beside the name + description, shrink the icon container, drop name/description font sizes, and rely on flex-wrap so the API-key actions still drop to their own row underneath. The API-key input + Save button now live on a single row at the full card width — input grows left-aligned, Save shrinks to the right with a hairline of inline padding.
  - NewAgentDialog: the dialog's top was rendering hidden behind the in-page Agents header on mobile. Render the dialog through `createPortal(..., document.body)` so the overlay escapes the `.agents-view` stacking context. Mobile media query also drops the overlay padding, fills 100vw / 100dvh with safe-area insets on header/footer for iOS notch + home indicator, and fixes the classic flex `min-height: auto` bug that prevented `overflow-y: auto` on the body from activating.
  - TerminalModal: same root cause as the onboarding modal — desktop `min-width: 480px` / `min-height: 320px` pinned the modal off-screen on phones. Reset to 0 in the mobile rule with `!important` so persisted desktop sizes can't override.
  - WorkflowStepManager: fix React error #310 ("Rendered more hooks than during the previous render") that prevented the workflow steps panel from loading. `useOverlayDismiss` was being called after an `if (!isOpen) return null` early return, so the hook count differed between open/closed renders. Moved the hook above the early return.
  - SettingsModal auth panel: tightened `.auth-panel-body` horizontal padding from `--space-xl` (24px) to `--space-md` (12px), giving each provider card more horizontal room.

  Paperclip runtime:

  - CLI parity: in the dashboard's "Local CLI" tab, Test / fetch companies / fetch agents now actually shell out to `paperclipai` instead of making HTTP calls through a derived URL. New CLI-backed variants (`probePaperclipViaCli`, `listCompaniesViaCli`, `listCompanyAgentsViaCli`, `createIssueViaCli`, `getIssueViaCli`, `agentsMeViaCli`) drive every Paperclip call that has a CLI counterpart; the runtime adapter routes through them when `transport=cli`. `getIssueComments` / `wakeAgent` / `getRunEvents` continue using HTTP (no matching `paperclipai` subcommands) but rely on the apiKey discovered from the local paperclipai config so CLI mode works end-to-end.
  - New dashboard routes `/providers/paperclip/cli-status`, `/cli-companies`, `/cli-agents` exposing the CLI helpers.

  Plugin runtime registry:

  - `GET /api/plugins/runtimes` now merges a bundled hermes/openclaw/paperclip fallback list on top of installed plugins, so the NewAgentDialog "Plugin Runtime" dropdown populates without requiring `fn plugin install` on a fresh setup. Installed plugins override the bundled entry by `runtimeId`. Coalesced the optional `version` field to `"0.0.0"` to satisfy the bundled-runtime type.

  Core:

  - Schema migration fix: bumped `SCHEMA_VERSION` from 48 → 49 so migration 49 (per-task `nodeId` column for remote-node routing) actually runs. Existing DBs at version 48 hit the early-return guard, never created the column, and `TaskStore.listTasks` crashed at startup with `no such column: nodeId` — the dashboard exited before initialization. The bump unblocks app startup on any pre-existing 0.7.0 install.

### runfusion.ai

#### Patch Changes

- ce6dcef: fix(0.7.1): mobile polish, modal layout fixes, paperclip CLI parity, schema migration

  Mobile / dashboard:

  - ModelOnboardingModal: dialog was off-screen on phones because the desktop `min-width: 640px` won over the mobile `max-width: 100%`. Reset min-width/min-height to 0 in the mobile media query (with `!important` so persisted desktop sizes from `useModalResizePersist` cannot re-pin it). Compact provider cards: keep the icon inline beside the name + description, shrink the icon container, drop name/description font sizes, and rely on flex-wrap so the API-key actions still drop to their own row underneath. The API-key input + Save button now live on a single row at the full card width — input grows left-aligned, Save shrinks to the right with a hairline of inline padding.
  - NewAgentDialog: the dialog's top was rendering hidden behind the in-page Agents header on mobile. Render the dialog through `createPortal(..., document.body)` so the overlay escapes the `.agents-view` stacking context. Mobile media query also drops the overlay padding, fills 100vw / 100dvh with safe-area insets on header/footer for iOS notch + home indicator, and fixes the classic flex `min-height: auto` bug that prevented `overflow-y: auto` on the body from activating.
  - TerminalModal: same root cause as the onboarding modal — desktop `min-width: 480px` / `min-height: 320px` pinned the modal off-screen on phones. Reset to 0 in the mobile rule with `!important` so persisted desktop sizes can't override.
  - WorkflowStepManager: fix React error #310 ("Rendered more hooks than during the previous render") that prevented the workflow steps panel from loading. `useOverlayDismiss` was being called after an `if (!isOpen) return null` early return, so the hook count differed between open/closed renders. Moved the hook above the early return.
  - SettingsModal auth panel: tightened `.auth-panel-body` horizontal padding from `--space-xl` (24px) to `--space-md` (12px), giving each provider card more horizontal room.

  Paperclip runtime:

  - CLI parity: in the dashboard's "Local CLI" tab, Test / fetch companies / fetch agents now actually shell out to `paperclipai` instead of making HTTP calls through a derived URL. New CLI-backed variants (`probePaperclipViaCli`, `listCompaniesViaCli`, `listCompanyAgentsViaCli`, `createIssueViaCli`, `getIssueViaCli`, `agentsMeViaCli`) drive every Paperclip call that has a CLI counterpart; the runtime adapter routes through them when `transport=cli`. `getIssueComments` / `wakeAgent` / `getRunEvents` continue using HTTP (no matching `paperclipai` subcommands) but rely on the apiKey discovered from the local paperclipai config so CLI mode works end-to-end.
  - New dashboard routes `/providers/paperclip/cli-status`, `/cli-companies`, `/cli-agents` exposing the CLI helpers.

  Plugin runtime registry:

  - `GET /api/plugins/runtimes` now merges a bundled hermes/openclaw/paperclip fallback list on top of installed plugins, so the NewAgentDialog "Plugin Runtime" dropdown populates without requiring `fn plugin install` on a fresh setup. Installed plugins override the bundled entry by `runtimeId`. Coalesced the optional `version` field to `"0.0.0"` to satisfy the bundled-runtime type.

  Core:

  - Schema migration fix: bumped `SCHEMA_VERSION` from 48 → 49 so migration 49 (per-task `nodeId` column for remote-node routing) actually runs. Existing DBs at version 48 hit the early-return guard, never created the column, and `TaskStore.listTasks` crashed at startup with `no such column: nodeId` — the dashboard exited before initialization. The bump unblocks app startup on any pre-existing 0.7.0 install.

- Updated dependencies [ce6dcef]
  - @runfusion/fusion@0.7.1

## 0.7.0

### @fusion/core

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

### @fusion/dashboard

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

#### Patch Changes

- Updated dependencies [b30e017]
  - @fusion/core@0.7.0
  - @fusion/engine@0.7.0
  - @fusion-plugin-examples/hermes-runtime@0.2.0
  - @fusion-plugin-examples/openclaw-runtime@0.2.0
  - @fusion-plugin-examples/paperclip-runtime@0.2.0

### @fusion/desktop

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

### @fusion/engine

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

#### Patch Changes

- Updated dependencies [b30e017]
  - @fusion/core@0.7.0
  - @fusion/pi-claude-cli@0.7.0

### @fusion/mobile

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

### @fusion/pi-claude-cli

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

### @fusion/plugin-sdk

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

#### Patch Changes

- Updated dependencies [b30e017]
  - @fusion/core@0.7.0

### @runfusion/fusion

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

#### Patch Changes

- ec09282: Add dashboard vitest process controls with a new `POST /api/kill-vitest` endpoint and System Stats modal UI for manual kills plus auto-kill settings management.
- 92b8631: Fix automation execution pipeline reliability by improving ProjectEngine automation startup diagnostics and health visibility, adding due-schedule regression coverage, and fixing manual automation runs to execute ai-prompt and create-task steps (including continueOnFailure handling) instead of command-only behavior.
- 8fbd3bd: Fix plugin-install loader taskStore compatibility by ensuring CLI plugin install paths are covered with regression tests for `getRootDir` expectations.
- 347cae8: Load enabled plugins during dashboard, serve, and daemon startup so plugin runtimes are available to agent runtime selection immediately after boot.
- 0a5dcf1: Fix `/api/system-stats` so process/system metrics still return when project resolution fails, with task and agent aggregates gracefully falling back to zero counts.
- 3c8a490: Fix `fn plugin install` failing in CLI plugin commands by adding `getRootDir()` to the mock TaskStore used by `createPluginLoader`.
- 637f435: Fix pi-claude-cli planning hangs by simplifying custom MCP tool guidance to direct `mcp__custom-tools__*` calls (no `ToolSearch` prerequisite), aligning custom-tool handling diagnostics, and adding regression coverage for `ls`/triage MCP tool mapping behavior.
- 7691bab: Respect globalPause/enginePaused in heartbeat trigger scheduler and monitor to prevent agents from running when the engine is paused at startup.

### runfusion.ai

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

#### Patch Changes

- Updated dependencies [ec09282]
- Updated dependencies [92b8631]
- Updated dependencies [8fbd3bd]
- Updated dependencies [347cae8]
- Updated dependencies [0a5dcf1]
- Updated dependencies [3c8a490]
- Updated dependencies [637f435]
- Updated dependencies [7691bab]
- Updated dependencies [b30e017]
  - @runfusion/fusion@0.7.0

## 0.6.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.6.0
- @fusion/engine@0.6.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.6.0
- @fusion/pi-claude-cli@0.6.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.6.0

### @runfusion/fusion

#### Minor Changes

- f4d98ed: Add a `--git` flag to `fn init` to auto-initialize a git repository (including an initial commit) when the target directory is not already a git repo.
- 6caab17: Add project settings to auto-comment on imported GitHub issues when tasks move to done, plus dashboard GitHub integration support for posting issue comments.
- fdf8ca9: Reframe the CLI splash to "multi node agent orchestrator" with `runfusion.ai` and the current version, and surface the version alongside URL/host/auth/uptime in the dashboard System panel and status bar.

### runfusion.ai

#### Patch Changes

- Updated dependencies [f4d98ed]
- Updated dependencies [6caab17]
- Updated dependencies [fdf8ca9]
  - @runfusion/fusion@0.6.0

## 0.5.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.5.0
- @fusion/engine@0.5.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.5.0
- @fusion/pi-claude-cli@0.5.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.5.0

### @runfusion/fusion

#### Minor Changes

- b969635: v0.5.0: status terminology refresh (planning/replan), Reviewer rename, in-review pause behavior, dashboard-tui resize hardening, dev-server experimental toggle fix, and version reporting fix.

#### Patch Changes

- 112ad67: Fix experimental feature save normalization so disabling Dev Server clears the legacy `devServer` alias (`null` delete) alongside canonical `devServerView`, preventing stale nav visibility after save.
- 16ec204: Fix dashboard health/version reporting to read the version from package.json instead of relying on npm_package_version with a stale hardcoded fallback.
- 79ce48c: Fix pausing behavior for in-review tasks so stop fully halts merge activity. Paused in-review tasks are now marked with paused status, removed from merge queues, active merge sessions are aborted/disposed, self-healing recovery skips paused tasks, and unpausing re-enqueues eligible review tasks for auto-merge.
- c85ffa9: Rename status values: specifying→planning, needs-respecify→needs-replan. Display label "Triage"→"Planning". Includes DB migration for existing records.
- 03a48ae: Update dashboard and CLI status strings: specifying→planning, needs-respecify→needs-replan. Update user-facing text from "triage/specify" terminology to "planning/replan" terminology.
- c1b0121: Rename "Validator" to "Reviewer" across all dashboard UI labels and descriptions.

### runfusion.ai

#### Patch Changes

- Updated dependencies [112ad67]
- Updated dependencies [16ec204]
- Updated dependencies [79ce48c]
- Updated dependencies [c85ffa9]
- Updated dependencies [03a48ae]
- Updated dependencies [c1b0121]
- Updated dependencies [b969635]
  - @runfusion/fusion@0.5.0

## 0.4.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.4.1
- @fusion/engine@0.4.1

### @fusion/engine

#### Patch Changes

- @fusion/core@0.4.1
- @fusion/pi-claude-cli@0.4.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.4.1

### @runfusion/fusion

#### Patch Changes

- b5200ba: Add Cloudflare Quick Tunnel mode for Remote Access so Fusion can auto-provision an ephemeral `trycloudflare.com` URL via `cloudflared tunnel --url` without requiring a pre-created named tunnel or tunnel token.
- 8097db2: Rename status values: specifying→planning, needs-respecify→needs-replan. Display label "Triage"→"Planning". Includes DB migration for existing records.

### runfusion.ai

#### Patch Changes

- Updated dependencies [b5200ba]
- Updated dependencies [8097db2]
  - @runfusion/fusion@0.4.1

## 0.4.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.4.0
- @fusion/engine@0.4.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.4.0
- @fusion/pi-claude-cli@0.4.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.4.0

### @runfusion/fusion

#### Minor Changes

- 9d8852e: Add project-level overlap ignore paths so teams can exempt safe shared files/directories from overlap-based task serialization while keeping overlap protection enabled for the rest of the repo.

#### Patch Changes

- f560af5: Fix dashboard TUI agents view run history rendering to use readable status labels and allow opening selected run logs reliably.
- cd4cef3: Fix dashboard TUI agent run-log opening so Enter key presses sent as carriage-return/newline characters are recognized reliably.
- 7e05a20: Speed up `fn init` project-name detection by skipping git remote lookup when the target directory is not a git repository. This avoids unnecessary subprocess work and reduces timeout risk in test/CI environments.
- c818d71: Inset plugin manager cards from the modal edges on mobile. The plugins subsection panel had no horizontal padding while its heading and toggle were already inset, leaving cards flush with the modal frame on small screens.
- c818d71: Fix triage hangs when using pi-claude-cli with claude-sonnet-4-6. Parameterless custom tools (e.g. `fn_review_spec`) emit zero `input_json_delta` events from the Claude CLI, so the event bridge previously fell through to a raw empty-string fallback and pi's TypeBox validator rejected the call with "root: must be object" — looping the agent indefinitely. Defaults empty `partialJson` to `{}`. Also adds a reminder loop before the planning fallback model engages, propagates the bundled `@runfusion/fusion` extension into engine sessions so `fn_*` tools register without `pi install`, and drops the "historical" qualifier from replayed tool labels that was confusing models into treating their own prior turns as a previous session.
- ff6a68b: Fix Skills Catalog initial-load failures by preventing unauthenticated public search requests for empty or too-short queries. The dashboard now returns a successful empty catalog result for short-query unauthenticated/fallback states instead of surfacing upstream 400 errors.
- 1b3994f: Fix the dashboard terminal modal desktop width contract so large displays use a broad viewport-based layout, and harden terminal input lifecycle handling so xterm keyboard input continues forwarding reliably after rerenders.
- 1a8058f: Make agent pause/resume state transitions act immediately by stopping active heartbeat runs on pause and triggering an on-demand heartbeat on resume.
- 39622f0: Fix scheduled automations so overdue runs catch up reliably after server downtime. Startup/settings sync no longer pushes unchanged overdue schedules into the future, and memory dreams automation is now synchronized during engine startup before cron begins ticking.
- 26f9c74: Synchronize Fusion skill documentation from `extension.ts` across `SKILL.md`, `references/extension-tools.md`, and `references/fusion-capabilities.md`, and document engine session-scoped runtime tools in a new `references/engine-tools.md` reference.

### runfusion.ai

#### Patch Changes

- Updated dependencies [f560af5]
- Updated dependencies [cd4cef3]
- Updated dependencies [7e05a20]
- Updated dependencies [c818d71]
- Updated dependencies [c818d71]
- Updated dependencies [ff6a68b]
- Updated dependencies [1b3994f]
- Updated dependencies [1a8058f]
- Updated dependencies [39622f0]
- Updated dependencies [26f9c74]
- Updated dependencies [9d8852e]
  - @runfusion/fusion@0.4.0

## Unreleased

### @fusion/pi-claude-cli

#### Patch Changes

- Add missing Anthropic model metadata entries to provider registration: `claude-sonnet-4-6`, `claude-sonnet-4-5`, and `claude-haiku-4-5` (alongside existing `claude-opus-4-7`) so they appear in the model picker even before upstream catalog updates.
- Improve subprocess diagnostics in `streamViaCli` by:
  - logging Claude stderr on close at warn level even when exit code is 0,
  - logging debug spawn correlation details (PID + effective args) when `PI_CLAUDE_CLI_DEBUG=1`,
  - warning when a subprocess closes without producing any content events.

### @runfusion/fusion

#### Patch Changes

- FN-2501: Agent pause/resume controls now act immediately. Pausing stops an active heartbeat run right away, and resuming to `active` triggers an immediate on-demand heartbeat instead of waiting for the next timer tick.

## 0.2.7

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.2.7
- @fusion/engine@0.2.7

### @fusion/engine

#### Patch Changes

- @fusion/core@0.2.7

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.2.7

### @runfusion/fusion

#### Patch Changes

- adbad8a: Add `fn plugin add` as a backward-compatible alias for `fn plugin install`, and update plugin command help text to advertise the alias while keeping `install` as the canonical command.

### runfusion.ai

#### Patch Changes

- Updated dependencies [adbad8a]
  - @runfusion/fusion@0.2.7

## 0.2.6

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.2.6
- @fusion/engine@0.2.6

### @fusion/engine

#### Patch Changes

- @fusion/core@0.2.6

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.2.6

### @runfusion/fusion

#### Patch Changes

- dbc9446: Add a blocking dashboard token-recovery dialog that appears only for daemon bearer-token 401 responses, with set-token or clear-token recovery actions that reload the app.

### runfusion.ai

#### Patch Changes

- Updated dependencies [dbc9446]
  - @runfusion/fusion@0.2.6

## 0.2.5

### @runfusion/fusion

#### Patch Changes

- 69f789f: TUI: layered defenses for the resize / wrong-height-layout bug

  Materially reduces (but doesn't fully eliminate) the symptom of the header rendering off-screen or the layout taking 1-2 too many rows, especially under tmux/ssh.

  - Enter alternate-screen buffer on start; leave on stop. The TUI gets a dedicated fullscreen surface that doesn't share scrollback.
  - StatusBar Text children no longer wrap (default `wrap="wrap"` was letting long hotkey + URL strings wrap to 2 rows, throwing the row budget off by 1).
  - Controller subscribes to `process.stdout` "resize" and calls `inkInstance.clear()` to reset log-update's frame tracking.
  - App-level resize listener + key-based remount on dimension change so React rebuilds the tree from scratch with fresh bounds.
  - Root Box gets explicit width + overflow="hidden"; MainHeader outer Box too.
  - Settings + Utilities side-by-side now stretch to equal heights (UtilitiesPanel switched from `flexShrink={0}` to `flexGrow={1}`).

### runfusion.ai

#### Patch Changes

- 69f789f: TUI: layered defenses for the resize / wrong-height-layout bug

  Materially reduces (but doesn't fully eliminate) the symptom of the header rendering off-screen or the layout taking 1-2 too many rows, especially under tmux/ssh.

  - Enter alternate-screen buffer on start; leave on stop. The TUI gets a dedicated fullscreen surface that doesn't share scrollback.
  - StatusBar Text children no longer wrap (default `wrap="wrap"` was letting long hotkey + URL strings wrap to 2 rows, throwing the row budget off by 1).
  - Controller subscribes to `process.stdout` "resize" and calls `inkInstance.clear()` to reset log-update's frame tracking.
  - App-level resize listener + key-based remount on dimension change so React rebuilds the tree from scratch with fresh bounds.
  - Root Box gets explicit width + overflow="hidden"; MainHeader outer Box too.
  - Settings + Utilities side-by-side now stretch to equal heights (UtilitiesPanel switched from `flexShrink={0}` to `flexGrow={1}`).

- Updated dependencies [69f789f]
  - @runfusion/fusion@0.2.5

## 0.2.4

### @runfusion/fusion

#### Patch Changes

- 88b4ecb: TUI fixes: help overlay no longer crashes, header stays rendered

  - Help overlay (`?` / `h`) crashed with "Encountered two children with the same key" because several shortcut entries share the same display key (`[t]` for Git view AND for Toggle engine pause; `[r]` for Refresh stats AND Refresh agent detail). Switch to index-based keys — each row is unique by position, not by character.
  - Refresh the help text to reflect the unified header (`[m]` Main, `[b/a/g/t/e]` views), the Settings/Files/Agents `←/→` pane swap, the Git push/fetch shortcuts, the Files hidden-files toggle, and the Logs `G` jump-to-end.
  - Main view (status mode) header sometimes vanished after a tmux pane switch and stayed missing until a terminal resize. Two fixes: (a) drop the `rows < 10` auto-hide in `MainHeader` — tmux pane switches can briefly report stale or zero dimensions, and a transient `return null` was orphaning the header. (b) Wrap `MainHeader` and `StatusBar` in `flexShrink={0}` boxes inside `StatusModeGrid` and `StatusModeSingle` (matching the prior fix in `InteractiveMode`), so Yoga can't squeeze them to 0 rows when content pressures the row budget.

### runfusion.ai

#### Patch Changes

- 88b4ecb: TUI fixes: help overlay no longer crashes, header stays rendered

  - Help overlay (`?` / `h`) crashed with "Encountered two children with the same key" because several shortcut entries share the same display key (`[t]` for Git view AND for Toggle engine pause; `[r]` for Refresh stats AND Refresh agent detail). Switch to index-based keys — each row is unique by position, not by character.
  - Refresh the help text to reflect the unified header (`[m]` Main, `[b/a/g/t/e]` views), the Settings/Files/Agents `←/→` pane swap, the Git push/fetch shortcuts, the Files hidden-files toggle, and the Logs `G` jump-to-end.
  - Main view (status mode) header sometimes vanished after a tmux pane switch and stayed missing until a terminal resize. Two fixes: (a) drop the `rows < 10` auto-hide in `MainHeader` — tmux pane switches can briefly report stale or zero dimensions, and a transient `return null` was orphaning the header. (b) Wrap `MainHeader` and `StatusBar` in `flexShrink={0}` boxes inside `StatusModeGrid` and `StatusModeSingle` (matching the prior fix in `InteractiveMode`), so Yoga can't squeeze them to 0 rows when content pressures the row budget.

- Updated dependencies [88b4ecb]
  - @runfusion/fusion@0.2.4

## 0.2.3

### @runfusion/fusion

#### Patch Changes

- 0f070d8: TUI header redesign and Settings ←/→ pane navigation

  - Replace the dual section + interactive tab strips with a single unified strip: `[m] Main  [b] Board  [a] Agents  [g] Settings  [t] Git  [e] Explorer`. Status mode highlights the Main pill; interactive views highlight their own. Number-key shortcuts (1–5) for status sections still work but are no longer rendered in the header chrome.
  - Width tiers now fit comfortably at every terminal size: full labels at cols ≥ 90, glyph-only at 50–89 (every shortcut still visible), FUSION + active pill only below 50. Help/quit shows at cols ≥ 110.
  - New `m` shortcut switches to status mode (Main); `s` kept as alias.
  - Settings interactive view: `←` focuses the list pane, `→` focuses the detail pane. `Tab` still cycles either way (consistent with Agents view).

### runfusion.ai

#### Patch Changes

- 0f070d8: TUI header redesign and Settings ←/→ pane navigation

  - Replace the dual section + interactive tab strips with a single unified strip: `[m] Main  [b] Board  [a] Agents  [g] Settings  [t] Git  [e] Explorer`. Status mode highlights the Main pill; interactive views highlight their own. Number-key shortcuts (1–5) for status sections still work but are no longer rendered in the header chrome.
  - Width tiers now fit comfortably at every terminal size: full labels at cols ≥ 90, glyph-only at 50–89 (every shortcut still visible), FUSION + active pill only below 50. Help/quit shows at cols ≥ 110.
  - New `m` shortcut switches to status mode (Main); `s` kept as alias.
  - Settings interactive view: `←` focuses the list pane, `→` focuses the detail pane. `Tab` still cycles either way (consistent with Agents view).

- Updated dependencies [0f070d8]
  - @runfusion/fusion@0.2.3

## 0.2.2

### @runfusion/fusion

#### Patch Changes

- 58688fa: Keep the FUSION header from wrapping when the terminal is narrow. The `MiniLogo` and tab pills had Yoga's default `flexShrink: 1`, so the row's collective content overrunning the width was being absorbed by shrinking every child — including FUSION, which then wrapped to two lines. Pin all fixed-content header children to `flexShrink={0}`; the trailing flexGrow filler absorbs slack instead.

### runfusion.ai

#### Patch Changes

- 58688fa: Keep the FUSION header from wrapping when the terminal is narrow. The `MiniLogo` and tab pills had Yoga's default `flexShrink: 1`, so the row's collective content overrunning the width was being absorbed by shrinking every child — including FUSION, which then wrapped to two lines. Pin all fixed-content header children to `flexShrink={0}`; the trailing flexGrow filler absorbs slack instead.
- Updated dependencies [58688fa]
  - @runfusion/fusion@0.2.2

## 0.2.1

### @runfusion/fusion

#### Patch Changes

- 07d7bac: Add a blocking dashboard token-recovery dialog that appears only for daemon bearer-token 401 responses, with set-token or clear-token recovery actions that reload the app.

### runfusion.ai

#### Patch Changes

- Updated dependencies [07d7bac]
  - @runfusion/fusion@0.2.1

## 0.2.0

### @runfusion/fusion

#### Minor Changes

- a8f5591: Add support for an optional custom ntfy server URL in notification settings, with default fallback to `https://ntfy.sh` when unset.

### runfusion.ai

#### Patch Changes

- Updated dependencies [a8f5591]
  - @runfusion/fusion@0.2.0

## 0.1.3

### @runfusion/fusion

#### Patch Changes

- c105cfa: Automatically install the bundled Fusion skill into supported agent home directories during `fn init` (`~/.claude/skills/fusion`, `~/.codex/skills/fusion`, and `~/.gemini/skills/fusion`) when missing. Existing installs are preserved, and per-target filesystem errors now warn without failing project initialization.
- 86521e2: Fix `pnpm install -g @runfusion/fusion` failing with a 404 for `@fusion/pi-claude-cli`. The vendored pi extension is now bundled into the published package's `dist/pi-claude-cli/` and is no longer listed as an external dependency.
- 76961d4: Add a severity filter to the interactive `fn dashboard` TUI Logs tab. Users can now press `f` to cycle `all → info → warn → error` for view-only filtering while preserving the full in-memory ring buffer.
- f77dd9d: Prevent stale dashboard service workers from trapping old client bundles, and compute automation cron schedules against UTC so monthly runs stay on day 1 across timezones.
- f4d2a4b: Fix `fn dashboard` Logs tab row budgeting so log lines stay above the footer hint on short terminals, including wrapped-message cases.
- f77dd9d: Fix dashboard SSE cleanup on browser refresh so stale event streams do not exhaust per-origin browser connections.
- 31f021a: Fix dashboard TUI log severity rendering so structured `logger.log(...)` entries routed via `stderr` display with info severity/icon instead of being misclassified as errors.
- eef56af: Normalize Fusion skill-facing tool naming to the public `fn_*` namespace and clarify the boundary between extension tools and internal engine runtime tools across skill docs.
- 832c32c: Refresh the shipped Fusion skill documentation to match the current `fn_*` extension and CLI surfaces, and replace stale kb-era task/storage examples with Fusion-native `FN-*` and `.fusion` conventions.
- dce70bf: Persist `fn dashboard` bearer tokens in the existing global settings store (`~/.fusion/settings.json`) on first authenticated run, then reuse them on subsequent starts. Explicit overrides (`--token`, `FUSION_DASHBOARD_TOKEN`, `FUSION_DAEMON_TOKEN`) and `--no-auth` precedence remain intact.
- f078a4e: Add a Settings → Pi Extensions action to reinstall Fusion's bundled Pi package (`npm:@runfusion/fusion`) for self-serve recovery when local Pi skill installs are stale or broken.

### runfusion.ai

#### Patch Changes

- Updated dependencies [c105cfa]
- Updated dependencies [86521e2]
- Updated dependencies [76961d4]
- Updated dependencies [f77dd9d]
- Updated dependencies [f4d2a4b]
- Updated dependencies [f77dd9d]
- Updated dependencies [31f021a]
- Updated dependencies [eef56af]
- Updated dependencies [832c32c]
- Updated dependencies [dce70bf]
- Updated dependencies [f078a4e]
  - @runfusion/fusion@0.1.3

## 0.1.2

### @runfusion/fusion

#### Patch Changes

- 9bf2981: Add a `planning-awaiting-input` ntfy notification event so users can opt in to alerts when planning sessions pause for user input.
- Fix the CLI init command import path for the Claude skills runner so tsup can resolve it during build.
- 94473c8: Improve dashboard shutdown observability by logging non-fatal diagnostics when `CentralCore.close()` fails during dispose, normal signal shutdown, or dev-mode shutdown cleanup.
- Fix dashboard and serve command plugin store initialization to support task store implementations that expose `getFusionDir()` without `getRootDir()`.
- c01892d: Route dashboard runtime diagnostics through the shared injected runtime logger so TTY sessions can capture server/package logs in the TUI while preserving readable non-TTY startup banner output.

### runfusion.ai

#### Patch Changes

- Updated dependencies [9bf2981]
- Updated dependencies
- Updated dependencies [94473c8]
- Updated dependencies
- Updated dependencies [c01892d]
  - @runfusion/fusion@0.1.2

## 0.1.1

### @runfusion/fusion

#### Patch Changes

- 39f7709: Dashboard TUI now surfaces engine log output in the Logs tab. Previously, the engine's `createLogger()` writes (scheduler, executor, triage, merger, PR monitor, heartbeat, etc.) went straight to `console.error` and were rendered beneath the alt-screen TUI — effectively invisible. `DashboardLogSink.captureConsole()` now intercepts `console.log/warn/error` while the TUI is running and routes each line into the ring buffer, parsing a leading `[prefix]` tag so entries carry the subsystem prefix. Originals are restored on TUI shutdown.
- 585e480: Add keyboard navigation and inspection features to the Dashboard TUI Logs tab: arrow keys and j/k to navigate entries, Enter to expand selected entry, Esc to close expanded view, and w to toggle wrap mode for long messages.
- 86fd24e: `fn dashboard` TTY mode now opens on the System tab first so users immediately see host, port, URL, and auth token access details.
- 585e480: Fix dashboard TUI log navigation: add Home/End shortcuts for jumping to first/last log entry, add Space and e keys as alternatives to Enter for expanding logs, improve word wrap to handle long unbroken tokens (URLs, stack traces) by hard-wrapping them at terminal width.
- 7d31b21: Fix iOS terminal typing in the dashboard. On touch-primary devices, tapping the terminal opened the on-screen keyboard but keystrokes were silently dropped because the bubble-phase `handleTerminalGestureFocus` handler re-focused the helper textarea and reset its selection during touchstart/pointerdown, disrupting iOS's input-event attribution. The CSS fix in commit c7266b7f already positions the textarea to receive taps natively, so the JS handler is now a no-op on `(hover: none) and (pointer: coarse)` devices and desktop retains click-to-focus.
- Fix dashboard TUI log viewport row calculation on very small terminals to prevent log lines from overlapping the footer.
- ff5df16: Fix executor model resolution precedence so project `defaultProviderOverride`/`defaultModelIdOverride` is honored before falling back to global `defaultProvider`/`defaultModelId` across execute, hot-swap, and step-session paths.
- df2836c: Fix dashboard TUI log behavior so log navigation can reach all entries still present in the ring buffer and streamed merge output is buffered into log lines instead of writing raw fragments into the interactive terminal UI.
- bbdd11a: Guard SQLite FTS5 usage so Fusion starts cleanly on Node builds whose bundled `node:sqlite` was compiled without FTS5. On affected systems, `fn dashboard` previously crashed on first run with `Error: no such module: fts5` during schema migration. The Database and ArchiveDatabase now probe for FTS5 at startup and skip the virtual table + triggers when unavailable; `TaskStore.searchTasks` and `ArchiveDatabase.search` fall back to LIKE-based scans. Set `FUSION_DISABLE_FTS5=1` to force the fallback on runtimes where FTS5 is present but undesirable.
- 0bb0100: Update dashboard TUI header branding from "fn board" to "fusion" for consistent product naming.

### runfusion.ai

Catch-up version bump so `runfusion.ai` stays in sync with `@runfusion/fusion`. The two packages are now grouped under changesets `fixed` in `.changeset/config.json` and will always share a version number from here on.

## 0.1.0

### @runfusion/fusion

#### Minor Changes

- 25d44e1: Add interactive TUI to `fn dashboard` with five navigable sections: logs, system, utilities, stats, and settings. Keyboard shortcuts enable quick in-terminal navigation (1-5, arrows, q, Ctrl+C, ? for help). The TUI activates automatically in interactive terminal sessions; non-TTY mode (CI, piped output) retains the existing plain-text banner/log behavior.

#### Patch Changes

- a2ed6d0: Fixes for stuck merges and agent lifecycle controls.

  - `findLandedTaskCommit` now falls back to scanning all of `HEAD` when the bounded `baseCommitSha..HEAD` range returns no commits (e.g. baseCommitSha was advanced past the landed merge by a fast-forward rebase). Previously the recovery silently returned null and re-queued the merge even though the commit had already landed.
  - Agent heartbeat triggers and registration are gated by `runtimeConfig.enabled` rather than transient agent state, so paused/idle/error agents stay registered for triggers and re-arm immediately on resume without waiting for a state transition.
  - `AgentDetailView` exposes a Stop control alongside Pause/Retry for `running` and `error` states so operators can terminate stuck agents without going through the agents list.

## 0.0.6

### @runfusion/fusion

#### Patch Changes

- Re-ship three previously reverted fixes and add pre-merge remote rebase.

  - `--no-auth` flag now correctly suppresses bearer-token auth instead of being silently overridden by a stale `FUSION_DAEMON_TOKEN` in the project's `.env`.
  - Workflow-review revisions reopen only the last step rather than resetting every previously-completed step. The agent applies the feedback as an in-place fix and earlier approved work stays done. New `reopenLastStepForRevision` helper is used by `handleWorkflowRevisionRequest`, `handleWorkflowStepFailure`, and `sendTaskBackForFix`. `determineRevisionResetStart` is marked `@deprecated` and kept exported for tests.
  - Heartbeat scheduling is now driven by `agent.state` (`active`/`running` = timer armed; everything else = timer cleared), not `runtimeConfig.enabled`. Resuming a paused agent through the dashboard now re-arms the timer immediately.
  - New setting `worktreeRebaseBeforeMerge` (default `true`) and companion `worktreeRebaseRemote` (default: git's configured default). The merger fetches the remote and rebases the task branch onto the latest default-branch tip before merging; conflicts flow into the existing smart/AI resolve cascade. Dashboard Settings → Worktrees exposes a checkbox and a remote dropdown populated from `/api/git/remotes/detailed`.
  - Last/Next heartbeat labels on the agent list card now share font-size and inline-flex alignment so they line up cleanly.

### runfusion.ai

#### Patch Changes

- Updated dependencies
  - @runfusion/fusion@0.0.6

## 0.0.5

### @runfusion/fusion

#### Patch Changes

- 41553a5: Harden agent lifecycle around closed tasks and heartbeat defaults.

  - `HeartbeatMonitor.executeHeartbeat()` now exits before session creation when the resolved task is done/archived (reason `task_closed`) and clears the stale `agent.taskId` linkage so the guard isn't re-tripped on every tick.
  - `HeartbeatTriggerScheduler.watchAssignments()` skips callback dispatch when the assigned task is already closed (when a `taskStore` is wired in).
  - `POST /api/agents/:id/runs` performs the same preflight check and returns 409 with a structured error naming the task id + column, keeping the existing active-run 409 precedence.
  - `AgentStore.createAgent()` now persists `runtimeConfig.heartbeatIntervalMs` (default 1h) on non-ephemeral agents so the dashboard's freshness signal matches the scheduler's effective cadence instead of depending on whether the user ever opened the heartbeat dropdown. Exports a new `DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS` constant.

### runfusion.ai

#### Patch Changes

- Updated dependencies [41553a5]
  - @runfusion/fusion@0.0.5

## 0.0.4

### @runfusion/fusion

#### Patch Changes

- 0da498a: Fix dashboard onboarding auth token controls, keep the AI planning modal footer visible on desktop, and add better terminal PTY spawn diagnostics.

### runfusion.ai

#### Patch Changes

- Bump the alias package to stay in sync with the current Fusion release.

## 0.0.3

### @runfusion/fusion

#### Patch Changes

- 1fc72d1: Improve the dashboard agents list views with shared empty-state actions, token-based state styling, and clearer board/tree/org-chart presentation.
- 46b8032: Make `fn agent import` import package skills alongside agents when importing from directory or archive sources. Skills are written to `{project}/skills/imported/{company-slug}/{skill-slug}/SKILL.md` with proper frontmatter formatting. Existing skill files are skipped rather than overwritten. Single AGENTS.md file imports do not include package skills.
- c1bc5b9: Fix CLI merge regressions in test/build verification: restore gh-cli test alias resolution, ensure daemon ignores invalid env tokens, and restore required changeset config.
- 06704cf: Fix the setup wizard directory browser and make terminal session startup more resilient.

### runfusion.ai

#### Patch Changes

- Updated dependencies [0da498a]
  - @runfusion/fusion@0.0.4

## 0.0.2

### @runfusion/fusion

#### Patch Changes

- Add `fusion` bin alias so `npx @runfusion/fusion` resolves to the CLI
  (the `fn` command is still available and unchanged).

### runfusion.ai

#### Patch Changes

- Updated dependencies [1fc72d1]
- Updated dependencies [46b8032]
- Updated dependencies [c1bc5b9]
- Updated dependencies [06704cf]
  - @runfusion/fusion@0.0.3

## 0.0.1

### @runfusion/fusion

#### Initial release

First public release under the `@runfusion` scope. Package was previously
developed under the `@gsxdsm/fusion` name; it was never published to npm,
so version history resets with `0.0.1`. Pre-release notes preserved below
for reference.

## 0.4.0 (pre-release, unpublished)

### @runfusion/fusion

#### Minor Changes

- 2d13b82: Add pi extension. Installing `@runfusion/fusion` via `pi install` now provides native tools (`fn_task_create`, `fn_task_list`, `fn_task_show`, `fn_task_attach`, `fn_task_pause`, `fn_task_unpause`) and a `/fn` command to start the dashboard and AI engine from within a pi session.
- 494de14: Changed `autoMerge` to default to `true` for new boards.
- 50821fc: Add global pause button to stop all automated agents and scheduling
- cac10af: Split engine control into Pause (soft) and Stop (hard). The dashboard Header now shows two buttons: "Pause AI engine" stops new work from being dispatched while letting in-flight agents finish gracefully, and "Stop AI engine" (previously the only Pause button) immediately kills all active agent sessions. A new `enginePaused` setting field controls the soft-pause state alongside the existing `globalPause` hard-stop.

#### Patch Changes

- d19b51f: Auto-assign random port when dashboard port is already in use instead of crashing with EADDRINUSE.
- ceb379d: Engine pause now terminates active agent sessions (matching global pause behavior) instead of letting them finish gracefully. Tasks are moved back to todo/cleared for clean resume on unpause.
- acb246a: Fix active agent glow disappearing when scheduling is soft-paused
- 43aada5: Fix scheduler to not count in-review worktrees against maxWorktrees limit. In-review tasks are idle (waiting to merge) and no longer block new tasks from starting.
- 9033a79: Fix InlineCreateCard cancelling when clicking dependency dropdown items with empty description.
- 96f1070: Fix double horizontal scrollbar on mobile board view by switching the board from a 5-column grid to a flex layout on narrow viewports (≤768px) with snap-scrolling.
- 3dc741c: Fix auto-pause on rate limit when pi-coding-agent exhausts retries. After `session.prompt()` resolves with exhausted retries, all four agent types (executor, triage, merger, reviewer) now detect the error on `session.state.error` and trigger `UsageLimitPauser` to activate global pause. Previously, rate-limit errors that pi-coding-agent handled internally were silently swallowed, causing tasks to be promoted to wrong columns with incomplete work.
- 2854553: Fix triage allowing tasks to reach executor before spec review approval
- 72a8953: Fix specifying agents not respecting maxConcurrent concurrency limit
- a2a12f9: Persist worktree pool across engine restarts. When `recycleWorktrees` is enabled, idle worktrees are rehydrated from disk on startup instead of being forgotten. When disabled, orphaned worktrees are cleaned up automatically.
- 65b9585: Add priority-based agent scheduling: merge agents are served before execution agents, which are served before specification agents, when competing for concurrency slots.
- 98ed082: Restructure README to lead with pi extension usage; move standalone CLI docs to STANDALONE.md.
- 2d13b82: Agents now declare dependencies when creating multiple related tasks during execution
- 0e0643a: Skip merger agent when squash merge stages nothing (branch already merged via dependency)
- d2e2e50: Make "Pause AI engine" a soft pause: only prevents new agents from starting while allowing currently running agents to finish their work naturally. "Stop AI engine" (global pause) still immediately terminates all active agents.
- 90764b9: Auto-pause engine when API usage limits are detected (rate limits, overloaded, quota exceeded). Prevents wasteful retries across concurrent agents.

## 0.3.1

### @runfusion/fusion

#### Patch Changes

- ae90be0: Bundle workspace packages into CLI for npm publish. The published package previously declared dependencies on private `@kb/core`, `@kb/dashboard`, and `@kb/engine` workspace packages, causing `npm install` to fail. Switched the CLI build from `tsc` to `tsup` (esbuild) to inline all `@kb/*` workspace code into a single bundled `dist/bin.js`, while keeping third-party packages (`express`, `multer`, `@mariozechner/pi-ai`) as external dependencies. Dashboard client assets are now copied into `dist/client/` so the published tarball is fully self-contained.
- 28bbcb9: Exclude Bun-compiled platform binaries from npm publish tarball, reducing package size significantly.

## 0.3.0

### @runfusion/fusion

#### Minor Changes

- fc7582d: Expand agent.log logging to all agent types, additionally capturing thinking, and agent roles
- cc999ef: RETHINK verdicts trigger git reset and conversation rewind, re-prompting the agent with feedback

#### Patch Changes

- f3c7f7d: CLI `task create` now supports a `--depends <id>` flag (repeatable) to declare task dependencies at creation time.
- fc7582d: Code review REVISE verdicts are now enforced such that agents can no longer advance steps without APPROVE
- cc999ef: Plan RETHINK triggers conversation rewind with REVISE enforcement on code reviews
- cc999ef: Dependent tasks can start from in-review dependency branches instead of waiting for merge

## 0.0.8

### runfusion.ai

#### Patch Changes

- Updated dependencies [39f7709]
- Updated dependencies [585e480]
- Updated dependencies [86fd24e]
- Updated dependencies [585e480]
- Updated dependencies [7d31b21]
- Updated dependencies
- Updated dependencies [ff5df16]
- Updated dependencies [df2836c]
- Updated dependencies [bbdd11a]
- Updated dependencies [0bb0100]
  - @runfusion/fusion@0.1.1

## 0.0.7

### runfusion.ai

#### Patch Changes

- Updated dependencies [25d44e1]
- Updated dependencies [a2ed6d0]
  - @runfusion/fusion@0.1.0

## 0.11.2

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.2

## 0.11.1

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.1
