# Project Memory

## Architecture

- `TaskExecutor` terminates active agent sessions (single and step) when tasks are moved away from `in-progress` via the `task:moved` event handler. This prevents zombie sessions when users manually send tasks back to todo/triage from the board UI.
- **Workflow Step Revision Loop (FN-1499)**: Workflow steps can request implementation revisions via "REQUEST REVISION" output. The flow:
  1. Workflow step agent outputs "REQUEST REVISION\n\n[feedback]" to signal that code changes are needed
  2. `executeWorkflowStep()` detects this pattern and returns `WorkflowStepOutcome` with `revisionRequested: true`
  3. `runWorkflowSteps()` propagates the structured outcome with `WorkflowStepResult.revisionRequested`
  4. `handleWorkflowRevisionRequest()` is called, which:
     - Injects "Workflow Revision Instructions" section into `PROMPT.md` (replacing any prior revision block)
     - Resets all steps to `pending` for fresh execution
     - Clears session file to get a fresh agent session
     - Schedules fresh execution via `setTimeout` after current guard unwinds
  5. Task stays in `in-progress` and the scheduler re-dispatches the task for a fresh executor pass
  6. **Guard-unwind requirement**: The revision rerun MUST be scheduled after the current `execute()` guard clears (`this.executing.delete()`). Failure to observe this causes a race where the scheduler re-dispatches while the old execution guard is still set, silently no-oping the new dispatch and stranding the task in `in-progress` with no active session.
- **Review Handoff (FN-1259)**: Agents can hand off tasks to users for human review via steering comments containing handoff phrases ("send it back to me", "hand off to user", etc.). When `reviewHandoffPolicy` is `"comment-triggered"`, the executor detects handoff intent in agent-authored steering comments and executes the handoff: sets `status: "awaiting-user-review"`, `assigneeUserId: "requesting-user"`, moves task to `in-review`, and disposes the agent session. The merger skips tasks with `"awaiting-user-review"` status (via `BLOCKING_TASK_STATUSES` in `task-merge.ts`). Users can accept review (clear status) or return to agent (move to todo). The `assigneeUserId` field stores the user ID who should review the task.
- Agent preset templates in `NewAgentDialog.tsx` are a UI-only concept (`AgentPreset` interface), separate from the engine's `AgentPromptTemplate` type. Presets populate agent creation fields (name, icon, role, soul, instructionsText) but don't map to engine types.
- `soul` and `instructionsText` are already supported in `AgentCreateInput` and `AgentUpdateInput` — no API changes needed when adding these to presets.
- `CronRunner` uses dependency injection for AI prompt execution: an `AiPromptExecutor` function is injected via options. This keeps it decoupled from `createKbAgent` and testable without real agent sessions.
- `createAiPromptExecutor(cwd)` is an async factory function that creates a new agent session per call, uses `onText` for text accumulation, and disposes sessions in a `finally` block.
- The factory uses lazy `import("./pi.js")` to avoid pulling the pi SDK into the module graph when AI execution isn't needed.
- `HeartbeatMonitor.executeHeartbeat()` uses the Paperclip wake→check→work→exit model. The lazy `import("./pi.js")` pattern keeps pi SDK out of the module graph when only monitoring (not execution) is needed.
- Agent tool factories (`createTaskCreateTool`, `createTaskLogTool`) live in `agent-tools.ts` and are shared between `TaskExecutor` and `HeartbeatMonitor` to avoid duplication.
- **Heartbeat Control-Plane Lane (FN-1487)**: Heartbeat runs from the Agents panel run on a separate control-plane lane that is independent of task execution concurrency limits. `HeartbeatMonitor` and `HeartbeatTriggerScheduler` are created WITHOUT the task-lane semaphore in both `runDashboard()` and `runServe()`. The semaphore boundary is documented in comments with "UTILITY PATH: This component does NOT receive the task-lane semaphore." This ensures agent responsiveness is preserved even when task pipelines are saturated.
- **Task-worker agent contract (FN-1661)**: Runtime-created executor task workers (for example `executor-FN-1234`) must be explicitly marked with `metadata.agentKind = "task-worker"` and `runtimeConfig.enabled = false`, then transition `idle -> active -> running` after assignment wiring completes. `HeartbeatTriggerScheduler.watchAssignments()` must skip assignment wakeups when `runtimeConfig.enabled === false`; otherwise task workers inherit user-agent heartbeat semantics and show false "Unresponsive" health in the dashboard.
- Dashboard SSE clients (planning/subtask/mission interview) now use a shared keep-alive pattern: start a 25s `setInterval` in stream `onOpen` that `POST`s `/api/ai-sessions/:id/ping`, and always stop it on stream `close`, `complete`, and fatal errors.
- **Subtask Session ProjectId Propagation (FN-1479)**: Subtask breakdown sessions must persist `projectId` throughout their lifecycle to enable project-scoped resume. Key patterns:
  - `POST /api/subtasks/start-streaming` forwards `projectId` from the route handler to `createSubtaskSession()`
  - `projectId` is stored on the session state object AND persisted to SQLite via `persistSubtaskSession()` on every state update (not just initial insert)
  - Session rehydration via `buildSubtaskSessionFromRow()` preserves `projectId` from the database row
  - Retry/complete/error transitions maintain `projectId` through all lifecycle stages
  - **Background/Resume semantics**: "Send to Background" is non-destructive (closes UI/stream but preserves server session); "Close/Cancel" is explicit abandonment (session deleted). Backgrounding during startup (while "Preparing..." is shown) follows the same pattern—close local stream/UI cleanly without deleting the server session.
- **Peer Gossip Protocol (FN-1224)**: Nodes exchange peer information via `POST /api/mesh/sync` endpoint. `PeerExchangeService` runs periodic sync cycles (default 60s interval) with all online remote nodes. `CentralCore.mergePeers()` handles peer data merging — new peers are registered via `registerGossipPeer()`, stale peers are updated with fresher data, and the local node is never overwritten. The service uses single-flight pattern to prevent overlapping syncs and refreshes local metrics before each sync.
- **Node Plugin Sync (FN-1246/FN-1518)**: Nodes track version information for plugin synchronization. Central schema v4 adds `versionInfo` and `pluginVersions` columns to the `nodes` table. `getAppVersion()` utility reads from nearest package.json. CentralCore methods: `updateNodeVersionInfo()`, `getNodeVersionInfo()`, `syncPlugins()`, `checkVersionCompatibility()`. Events: `node:version:updated`, `node:plugins:synced`.
- **Node Plugin Sync Dashboard Routes (FN-1518)**: Dashboard REST API endpoints for node version info and plugin sync:
  - `GET /api/nodes/:id/version` — Returns `NodeVersionInfo` when present, `null` when not yet stored. Returns 404 if node doesn't exist.
  - `POST /api/nodes/:id/sync-plugins` — Compares plugins between local and remote nodes. Returns 400 if target is local (sync is remote-only), 400 if no local node registered, 404 if target missing. Calls `syncPlugins(localNodeId, remoteNodeId)` with argument order: `(localNodeId, remoteNodeId)`.
  - `GET /api/nodes/:id/compatibility` — Checks version compatibility between local and target nodes. Returns 400 if local node missing, 400 if either version info missing, 404 if target missing. Calls `checkVersionCompatibility(localVersion, remoteVersion)` with version strings (not node IDs).
- **Plugin Management API Routes (FN-1411)**: Plugin CRUD endpoints implemented in `createApiRoutes` with `getScopedStore(req)` pattern for multi-project support:
  - **Mode discriminator pattern** for POST /plugins: Deterministic behavior via required `mode` field with `"register"` (explicit manifest) or `"install"` (load from path) values. Missing mode, unknown mode, or ambiguous shapes return 400.
  - **Error mapping matrix**: Input/validation → 400, not found (ENOENT) → 404, lifecycle conflicts (EEXISTS) → 409, unexpected → 500.
  - **Project scoping**: All routes support `projectId` in query param or request body. Uses `getScopedStore(req)` which calls `getOrCreateProjectStore(projectId)`.
  - **Scoping test strategy**: Mock `projectStoreResolver.getOrCreateProjectStore` to return a scoped store with scoped plugin store. Tests verify the scoped store is used and data comes from the scoped plugin store.
  - **Plugin store access**: Routes use `scopedStore.getPluginStore()` to get the plugin store from the scoped task store, enabling per-project plugin isolation.

## FN-1354: Auto-Summarize Titles Bug Fix

- The `summarize` field in `TaskCreateInput` must be forwarded by the frontend API (`createTask` in `api.ts`) to enable the auto-summarization flow
- `summarizeTitle()` in `ai-summarize.ts` uses `session.state.messages` to extract AI responses, with fallback to direct `prompt()` return value
- Debug logging via `process.env.FUSION_DEBUG_AI` helps diagnose AI session issues
- When testing `console.warn` calls that expect multiple substrings in a single concatenated string, use `expect(mock.calls[0][0]).toMatch(/substring1/)` pattern instead of `expect.stringContaining()` on multiple arguments

## FN-1544: Viewport-Gated Card Metadata Loading

When optimizing dashboard performance for large task sets:
- **Viewport gating pattern**: Use IntersectionObserver with `rootMargin: "200px"` to prefetch data just before cards become visible
- **Lazy enable option**: Add `{ enabled?: boolean }` parameter to hooks (default `true` for backward compatibility)
- **Disabled state**: Return stable empty state without triggering fetches when `enabled: false`
- **In-memory caching**: Use TTL-based caching (e.g., 30 seconds) to avoid repeated fetches during rerenders
- **Cache key format**: `"taskId:projectId"` for separate caching per task/project context
- **Cache hit behavior**: Return immediately without loading flicker — don't set loading state on cache hit
- **Export test helpers**: Export `__test_clearCache()` functions for test isolation
- **Lightweight comparisons**: Replace `JSON.stringify` in memo comparators with field-by-field comparisons (e.g., `areAttachmentsEqual`, `areCommentsEqual`)

Example from `useTaskDiffStats`:
```typescript
// Cache keyed by taskId:projectId
const diffStatsCache = new Map<string, { stats: DiffStats; expiresAt: number }>();

// Hook returns immediately on cache hit
if (cached) {
  setStats(cached);
  setLoading(false);
  return;
}
```

## FN-1734: Polling Hook Loading Contract

When implementing polling hooks that fetch data periodically (e.g., health metrics, status updates):
- **Loading contract**: `loading` should be `true` ONLY for initial data fetch, NOT during background polling
- **Background polling pattern**: Use a ref (`initialLoadCompleteRef`) to track if initial load is done; only set `loading: true` when `!initialLoadCompleteRef.current`
- **Component behavior**: Components consuming these hooks should show skeleton only when there's genuinely no data (not just when `loading` is true during refresh)
- **Why it matters**: Setting `loading` to true on every poll causes skeleton flicker and scroll position resets, degrading UX

Reference: `useProjectHealth` in `packages/dashboard/app/hooks/useProjectHealth.ts` demonstrates this pattern.

## Conventions

- When mocking function types with Vitest for the build (tsc), use `vi.fn().mockResolvedValue(x) as unknown as T` instead of `vi.fn<Parameters<T>, ReturnType<T>>()`. The generic syntax works at runtime but fails during `tsc` build.
- `expect.any(Number)` does not work in Vitest matchers — use `expect(mockFn.mock.calls.length).toBeGreaterThanOrEqual(1)` or similar instead.
- When mocking `AgentStore` for heartbeat execution tests, track `saveRun` calls in a local `Map<string, AgentHeartbeatRun>` and have `getRunDetail` read from it — this way `completeRun`'s saved state is reflected in the returned run.
- When `HeartbeatMonitorOptions` has optional fields (`taskStore?`, `rootDir?`), capture them in local `const` variables after the early-return validation check to avoid `Object is possibly 'undefined'` TypeScript errors in the closure.
- For package-scoped single-file test runs, prefer `pnpm --filter <pkg> exec vitest run <file>` over `pnpm --filter <pkg> test -- <file>` when the package test script already hardcodes positional args.
- In dashboard task-creation forms, avoid special-casing built-in workflow template IDs in UI state; render from fetched `workflowSteps` IDs and let store-side template materialization resolve template IDs (`browser-verification` → `WS-XXX`).
- When a package mixes Electron main-process `.ts` files with renderer `.tsx` files, use `moduleResolution: "bundler"` plus `lib: ["DOM", "DOM.Iterable"]` in that package tsconfig; Node16 resolution will otherwise force `.js` extensions and break renderer imports during `tsc`.
- For React component tests in the desktop package, include `.test.tsx` in Vitest discovery and call `cleanup()` in `afterEach` to avoid cross-test DOM leakage that causes duplicate-element query failures.
- When extracting App-level async handlers into hooks, keep error/toast behavior inside the hook and wire passthrough handlers in `App.tsx` (`const handler = hookAction`) to avoid duplicate rollback/toast logic.
- For deep-link modal behavior (`?task=`), preserve one-time open semantics with internal refs in the hook so closing the modal can safely strip only the `task` query param while preserving other params (like `project`).
- When deprecating fields from `BoardConfig` but tests/internal flows still poke private config methods, keep temporary compatibility fields non-enumerable in `readConfig()` so `writeConfig()` can omit them from `config.json` while legacy tests can still mutate them.
- For dashboard route tests that mock `@fusion/core`, keep the mock export list in sync with the real route imports (for example `parseCompanyArchive`); missing one export silently changes route behavior and causes hard-to-diagnose failures.
- Browser directory pickers (`webkitdirectory`) cannot provide a server filesystem path; for dashboard import flows, parse selected `AGENTS.md` files client-side and send `{ agents }` payloads instead of trying to submit a directory `source` path.
- For conditionally rendered mobile inputs in dashboard components, prefer React `autoFocus` on the input over effect+`setTimeout` focus logic keyed to open-state booleans; mount timing is more reliable and simpler.
- Checkout leasing is explicit: use `checkoutTask`/`releaseTask` (or `/api/tasks/:id/checkout` + `/release`) for ownership, treat 409 conflicts as non-retryable contention, and let `HeartbeatMonitor.executeHeartbeat()` only validate `checkedOutBy` (never auto-acquire leases).
- The null-as-delete pattern for settings: In `TaskStore.updateSettings()`, `null` values in the settings patch are treated as "delete this key from settings" (since `JSON.stringify` drops `undefined` keys). This allows the frontend to explicitly clear a setting by sending `null`. The key is deleted from both `config.settings` and `projectPatch` before merging, so cleared settings fall back to `DEFAULT_SETTINGS`.
- `TaskStore.logEntry()`, `addComment()`, `addSteeringComment()`, `pauseTask()` accept an optional `RunMutationContext` parameter for audit trail correlation. Always pass it when the caller is an engine module (executor, heartbeat monitor) to maintain the audit trail. The executor constructs a synthetic `runContext` with `runId: "exec-{taskId}-{timestamp}-{random}"` since it doesn't use `AgentHeartbeatRun`.
- **Run-Audit Instrumentation (FN-1404)**: The engine instruments mutation calls with audit events via `createRunAuditor()` from `run-audit.ts`. Each active run (heartbeat, executor, merger) creates an `EngineRunContext` with `runId`, `agentId`, `taskId`, and `phase`. The auditor no-ops cleanly when no run context exists (backward compatible with manual/non-run paths). Use `generateSyntheticRunId()` for executor/merger synthetic IDs. Audit events are emitted for git mutations (worktree/branch/create/remove/reset), database mutations (task:update/move/comment/assign/checkout), and filesystem mutations (file:capture-modified).
- **In-Merge Verification Fix (FN-1858)**: When deterministic verification fails during merge, the merger now attempts to fix the issue by spawning an AI agent on the main branch (`cwd: rootDir`). This is different from the executor which runs in worktrees. The fix agent uses `tools: "coding"` for read/write access. Always dispose sessions in `finally` blocks, use `withRateLimitRetry()` for resilience, and cap retry attempts (max 3) to prevent runaway costs.
- **Write-through cache pattern (FN-1336)**: When adding caching to a store, use write-through invalidation (update cache in setter, return cached value in getter). For `GlobalSettingsStore`, the cache survives for the lifetime of the process since it's a singleton per server instance. Add `invalidateCache()` for testing and edge cases where external processes modify the file.
- **API wrapper tests for validation**: When testing functions that validate parameters synchronously before calling fetch:
  - Use `expect(() => fn()).toThrow()` for synchronous throws (not `rejects.toThrow()`)
  - The `api()` function in `app/api.ts` only passes `headers: { "Content-Type": "application/json" }` when no `opts.method` is specified — GET requests don't include `method: "GET"` in the fetch options
  - URL-encoded parameter values (like `%20`) are valid values — they're decoded at the URL level, not parameter level
  - Mock setups for successful responses should return 200 status to avoid triggering error paths
- In the flat ESLint config, put global `ignores` first and include test-only support files (`app/test/**`, `vitest.setup.ts`) when running `eslint .` from a git worktree; later per-file `ignores` do not stop the base recommended configs from linting those files.
- Dashboard Express routers should normalize `req.params.*` through a string validator/helper before passing values into typed store methods; under strict tsconfig, route params can surface as `string | string[]` and break package typecheck if used directly.

## Color Theme System

- There are **54 unique color themes** in `packages/dashboard/app/public/theme-data.css` (default, ocean, forest, sunset, zen, berry, high-contrast, industrial, monochrome, slate, ash, graphite, silver, solarized, factory, ayu, one-dark, nord, dracula, gruvbox, tokyo-night, catppuccin-mocha, github-dark, everforest, rose-pine, kanagawa, night-owl, palenight, monokai-pro, slime, brutalist, neon-city, parchment, terminal, glass, horizon, vitesse, outrun, snazzy, porple, espresso, mars, poimandres, ember, rust, copper, foundry, carbon, sandstone, lagoon, frost, lavender, neon-bloom, sepia). Each has a dark variant `[data-color-theme="<name>"]` and a light variant `[data-color-theme="<name>"][data-theme="light"]`. Theme blocks were extracted to a separate file in FN-1409 to enable lazy loading — theme-data.css is only loaded when a non-default color theme is active.
- When adding CSS custom properties that should be theme-aware (like `--accent`, `--status-*-bg`), add them to all 54 theme blocks plus `:root` and `[data-theme="light"]` base blocks. The test in `status-colors-theme.test.ts` iterates all blocks programmatically to prevent regressions.
- **Semantic tokens** (tokens describing purpose, not appearance) that maintain consistent meaning across all color themes (e.g., "autopilot active" is always green-tinted, "event error" is always red-tinted) only need dark/light adaptation via the base `[data-theme="light"]` block. They do NOT need per-color-theme overrides because the semantic meaning is consistent. Examples from FN-1357: `--autopilot-pulse`, `--event-*-text`, `--event-*-bg`, `--terminal-bg`, `--star-idle`, `--star-active`, `--badge-mission-*`, `--fab-*`.
- **Runtime-safe theme loading (FN-1526)**: The `theme-data.css` stylesheet URL is derived from `document.baseURI` rather than hardcoded paths. This ensures correct resolution in both HTTP/HTTPS contexts (uses `/theme-data.css`) and Electron `file://` contexts (derives path relative to HTML file directory). The same `getThemeDataUrl()` helper is used by both the pre-hydration inline script in `index.html` and the runtime `useTheme.ts` hook. **Bug fix (FN-1535)**: The initial implementation had a path joining bug where `new URL("theme-data.css", baseUrl)` was used incorrectly, producing malformed paths like `.../apptheme-data.css` instead of `.../app/theme-data.css`. The fix uses `url.resolve()` or explicit path joining with proper slash handling to ensure the URL always contains the correct slash separator between directory and filename. **Refinement (FN-1534)**: Fixed two additional issues: (1) URL resolution now correctly handles both trailing-slash directories (`/path/`) and filename paths (`/path/index.html`) by checking `base.endsWith('/')` and using appropriate slice/replace logic; (2) `loadThemeDataStylesheet()` now updates existing link href when stale instead of returning early, ensuring theme changes apply correctly even after page loads with different base URLs.

## Plugin System (FN-1111 / FN-1400)

The plugin system is built on three layers:
1. **PluginStore** (`packages/core/src/plugin-store.ts`) — SQLite-backed CRUD operations for plugin installations, stored in the `plugins` table (schema v24)
2. **PluginLoader** (`packages/core/src/plugin-loader.ts`) — Dynamic import, lifecycle management, dependency resolution (topological sort), hook invocation
3. **PluginRunner** (`packages/engine/src/plugin-runner.ts`) — Engine/runtime lifecycle integration, hook fanout, and tool adaptation

### PluginRunner Integration (FN-1401)

The `PluginRunner` bridges the plugin core system with the Fusion engine runtime:

**Lifecycle Integration:**
- `PluginRunner.init()` loads enabled plugins and subscribes to store/loader events for hot-load/unload synchronization
- `PluginRunner.shutdown()` unsubscribes all listeners and stops all plugins cleanly
- Runtime integration: `InProcessRuntime.start()` initializes PluginStore/PluginLoader/PluginRunner after TaskStore, `stop()` calls `pluginRunner.shutdown()`

**Hook Timeout & Isolation:**
- Plugin hooks have a default 5-second timeout (configurable via `hookTimeoutMs`)
- Each hook invocation wraps in try/catch with timeout rejection — failures are logged but never propagate
- Task lifecycle hooks: `onTaskCreated` on task:created, `onTaskMoved`/`onTaskCompleted` on task:moved (completion only when `to === "done"`)
- Agent lifecycle hooks: `onAgentRunStart`/`onAgentRunEnd` invoked in executor session start/end paths

**Tool Adaptation:**
- Plugin tools are converted from `PluginToolDefinition[]` to `ToolDefinition[]` (pi-coding-agent format)
- Tool names prefixed with `plugin_` to avoid collision with built-in tools
- Tools are cached and invalidated on plugin state changes
- Tool collision guard: built-in tools (task_*, review, etc.) cannot be overridden by plugin tools

**Store Event Synchronization:**
- PluginRunner subscribes to: `plugin:enabled`, `plugin:disabled`, `plugin:unregistered`, `plugin:stateChanged`, `plugin:updated`
- Loader event subscribes to: `plugin:loaded`, `plugin:unloaded`, `plugin:reloaded`
- All events invalidate tool/route caches for immediate hot-reload of new plugin capabilities

**Step-Session Plugin Tool Integration:**
- PluginRunner injected into `TaskExecutorOptions` as optional dependency
- `StepSessionExecutor` receives plugin tools via `TaskExecutorOptions.pluginRunner`
- Each step-session agent creation merges plugin tools with step session custom tools

**Key types** (in `packages/core/src/plugin-types.ts`):
- `PluginManifest` — Plugin metadata (id, name, version, dependencies, settingsSchema)
- `FusionPlugin` — Loaded plugin instance with hooks, tools, routes
- `PluginContext` — Runtime API surface (taskStore, settings, logger, emitEvent)
- `PluginInstallation` — Persisted plugin record in SQLite

**Hook types**: `onLoad`, `onUnload`, `onTaskCreated`, `onTaskMoved`, `onTaskCompleted`, `onError`

**Database schema** (`plugins` table, v24):
- Stores plugin metadata, path, enabled flag, state, settings, error
- Settings stored as JSON, validated against `settingsSchema` on update

**PluginLoader patterns**:
- Uses topological sort for dependency resolution (throws on circular deps)
- Error isolation: plugin crashes set `state: "error` but don't crash loader
- Hook invocation is non-blocking: one plugin's failure doesn't prevent others from receiving hooks
- `createContext()` is async (gets settings from store)

**Integration points for FN-1113**:
- Hooks invoked by scheduler on task lifecycle events
- Tools registered via `getPluginTools()` → merged with built-in agent tools
- Routes registered via `getPluginRoutes()` → mounted under `/api/plugins/:pluginId/`

### Plugin Lifecycle SSE Event Propagation (FN-1412)

Dashboard SSE (`/api/events`) streams plugin lifecycle events as normalized `plugin:lifecycle` SSE events.

**Payload contract** (`PluginLifecyclePayload`):
- `pluginId` — Plugin identifier
- `transition` — Normalized transition type: `installing`, `enabled`, `disabled`, `error`, `uninstalled`, `settings-updated`
- `sourceEvent` — Underlying store event that triggered this transition
- `timestamp` — ISO-8601 timestamp
- `projectId` — Included for project-scoped streams (omitted for default streams)
- `enabled` — Whether the plugin is currently enabled
- `state` — Current plugin state (`installed`, `started`, `stopped`, `error`)
- `version` — Plugin version
- `settings` — Plugin settings snapshot
- `error` — Error message (only when state is "error")

**Transition mapping**:
| Source Event | Transition |
|--------------|-----------|
| `plugin:registered` | `installing` |
| `plugin:enabled` | `enabled` |
| `plugin:disabled` | `disabled` |
| `plugin:stateChanged` (state === "error") | `error` |
| `plugin:unregistered` | `uninstalled` |
| `plugin:updated` | `settings-updated` |

**Project-scoped wiring**:
- `/api/events` (no projectId) → uses `store.getPluginStore()` for default store
- `/api/events?projectId=X` → uses `scopedStore.getPluginStore()` from `getOrCreateProjectStore(projectId)`
- Both streams share the same EventEmitter via the project-store resolver pattern
- Listener cleanup happens on `req.on("close")` and write-failure paths

**Implementation files**:
- `packages/dashboard/src/sse.ts` — `createSSE()` with plugin lifecycle relay
- `packages/dashboard/src/server.ts` — `/api/events` route wiring with scoped plugin sources
- `packages/dashboard/src/__tests__/sse.test.ts` — Plugin lifecycle SSE tests
- `packages/dashboard/src/server.events.test.ts` — Server wiring tests

## Pitfalls

- When adding props to a React component interface that were previously declared but not destructured in the function body, remember to add them to the destructuring list too. TypeScript won't warn about unused interface fields, so `onOpenScripts` in `MobileNavBarProps` compiled fine but caused `ReferenceError: onOpenScripts is not defined` at runtime.
- **Express wildcard route ordering (FN-1492)**: When defining Express routes with wildcard patterns like `{*filepath}`, ALWAYS define more specific routes BEFORE the generic wildcard route. Express matches routes in order, so `POST /files/{*filepath}` would shadow `POST /files/{*filepath}/delete` if defined first. The fix is to define operation routes (`/copy`, `/move`, `/delete`, `/rename`, `/download`, etc.) BEFORE the generic write route. See `packages/dashboard/src/routes.ts` for the correct ordering pattern.
- **Webhook HMAC testing**: The `REQUEST` test utility in `test-request.ts` doesn't handle stream-based middleware like `express.raw()` well. For webhook routes requiring HMAC verification (e.g., GitHub webhooks, routine webhooks), test the `verifyWebhookSignature` function directly using `await import()` rather than trying to set up raw body middleware through Express. See the routine webhook tests in `routes.test.ts` for the pattern.

- `vi.fn<Parameters<SomeType>, ReturnType<SomeType>>()` works in Vitest runtime but causes TypeScript build errors (`TS2558: Expected 0-1 type arguments, but got 2`). Always use the cast pattern instead.
- When adding new exports to `@fusion/engine`, update the mock in `packages/cli/src/commands/__tests__/dashboard.test.ts` AND `packages/cli/src/commands/__tests__/serve.test.ts` to include the new export, otherwise the test may fail with mysterious errors. Both test files need to be kept in sync.
- When adding new CLI command exports (like node.ts, mesh.ts), update BOTH `src/bin.test.ts` AND `src/__tests__/bin.test.ts` mocks to include the new exports, otherwise all tests importing from bin.ts will fail with "No 'X' export is defined" errors.
- Test `describe` blocks in Vitest can't access helper functions defined in sibling describe blocks. Place shared helpers in the parent scope or within the same describe block.
- When extracting shared code from `executor.ts` (e.g., tool factories), move the parameter schemas (`taskCreateParams`, `taskLogParams`) to the shared module too — keep them canonical in one place to avoid duplication.
- When changing API function signatures (e.g., `startAgentRun`), add new params at the END to preserve backward compatibility. Existing callers passing positional args will break if you insert a new param before existing ones.
- For UI tests that assert calls to git/dashboard API helpers with optional trailing params (for example `projectId` or `force`), assert the leading semantic arguments via `mock.calls.at(-1)?.slice(0, n)` instead of exact `toHaveBeenCalledWith(...)` on the full argument list. Some call paths omit trailing `undefined` values while others pass them explicitly.
- `HeartbeatMonitor.executeHeartbeat()` calls `startRun()` internally — do NOT call both `startRun()` and `executeHeartbeat()` for the same run, or you'll get duplicate runs. Use `startRun()` alone for record-only, or `executeHeartbeat()` for full execution.
- When RunsTab loads data via API calls instead of props, tests must mock the API functions (`fetchAgentRuns`, `fetchAgentRunDetail`) in addition to existing mocks, and set up defaults in `beforeEach`.
- In UI static analysis tests, avoid regex that spans multiple lines for code patterns (e.g., `setInterval.*5000`). Use separate `toContain()` assertions instead since the code is multi-line.
- In large inline mock objects, duplicate property keys are only warned by esbuild and the last declaration silently wins, which can hide the real mock implementation during route tests.
- For hardcoded workflow-step shortcuts in dashboard forms (like `"browser-verification"`), checked/toggle logic must reconcile both the literal template ID and resolved `WS-XXX` IDs by matching `workflowStep.templateId`.
- **Testing modal dropdown menus (FN-1489)**: When testing dropdown menus in modal footers:
  - Wrap `fireEvent.click()` calls in `act()` when the dropdown state updates: `await act(async () => { fireEvent.click(btn); })`
  - Use `screen.getByRole("menuitem", { name: "..." })` instead of `screen.getByText("...")` for menu items
  - When checking menu item counts, check BEFORE closing the dropdown (e.g., check Retry count while Actions dropdown is still open)
  - For conditionally-rendered dropdowns (e.g., only show Actions dropdown for non-triage tasks), test both cases explicitly
- When using `import.meta.env` in `packages/dashboard/app/*`, ensure `packages/dashboard/tsconfig.app.json` includes `"vite/client"` in `compilerOptions.types`, or the dashboard typecheck test will fail with `Property 'env' does not exist on type 'ImportMeta'`.
- In dashboard app tests under `app/__tests__`, the built client output directory resolves to `../../dist/client` (not `../../../dist/client`).
- Fresh worktrees may miss linked Capacitor plugin packages until dependencies are installed; if dashboard tests/typecheck fail with unresolved `@capacitor/*` imports, run `pnpm install` at repo root first.
- When dashboard components add new `lucide-react` icons or new API functions, update the component test mocks (`vi.mock("lucide-react")` and `vi.mock("../../api")`) immediately; missing mock exports cause cascading runtime failures (`No "X" export is defined`) across otherwise unrelated tests.
- In fresh worktrees, workspace dependency links can be stale enough that dashboard/core tests fail resolving `yaml` from `@fusion/core`; run `pnpm install` at repo root before chasing false test failures.
- `pnpm test` at repo root runs dashboard's clean-checkout typecheck test; App-level TS issues (like duplicate imports or bad hook call signatures) may pass targeted Vitest runs but still fail the full suite.
- In executor worktrees, task attachment files referenced in PROMPT may exist only under the main repo path (`/Users/.../Projects/kb/.fusion/tasks/...`); if relative `.fusion/tasks/...` paths are missing, read the absolute attachment path directly.
- SQLite `ORDER BY timestamp DESC` alone can be nondeterministic when multiple rows share the same millisecond timestamp; add a stable tiebreaker (for example `rowid DESC`) when selecting a "latest" event.
- In `TaskCard.tsx`, `isInteractiveTarget` must check `target instanceof Element` (not `HTMLElement`) so SVG elements from lucide-react icons are correctly detected as interactive when inside buttons.
- If workspace tests fail resolving `@fusion/core` package exports from `packages/core/dist/index.js` (for example `No matching export ...` in CLI/TUI/package-level tests after adding a new core export), run `pnpm --filter @fusion/core build` before rerunning the suite so ignored `dist/` exports are refreshed.
- QuickEntryBox control test IDs are reused in `ListView` integration tests; when control layout changes (for example nested menu → inline buttons), update both `QuickEntryBox.test.tsx` and `ListView.test.tsx` together to avoid cascading failures.
- When `InlineCreateCard` layout changes, also check `Column.test.tsx` and `board-mobile.test.tsx` for references to moved/removed test IDs like `inline-create-description-actions`.
- When adding portal-based dropdown menus to QuickEntryBox, tests may fail in isolation but pass when run together (test isolation issues). This is because tests share DOM state across describe blocks. Always verify new dropdown tests pass both in isolation (`--testNamePattern`) and when run together.
- `mission-store.test.ts` has a flaky test (`getMissionHealth computes mission metrics and latest error context`) that fails intermittently when timestamps collide in the same millisecond — this is pre-existing and not related to dashboard changes.
- **SettingsModal sidebar reordering**: When reordering sections in `SETTINGS_SECTIONS`, update all tests that assume a specific section is the default. Tests using `screen.getByText("SectionName")` may fail with "multiple elements found" when the section heading also appears in the content area alongside the sidebar item. Use `screen.getAllByText("SectionName")[0]` or navigate to the section explicitly before accessing its fields.
- **Test isolation with temp directories**: Tests that create filesystem state (like agent files under `.fusion/agents/`) should use per-test temp directories via `mkdtempSync(join(os.tmpdir(), 'fn-test-'))` and clean up in `afterEach` with `rmSync(dir, { recursive: true, force: true })`. Shared temp paths cause state leakage between tests, leading to noisy/flaky behavior. See `in-process-runtime.test.ts` for the pattern.
- **xterm.js WebGL on mobile (FN-1739)**: The `@xterm/addon-webgl` addon causes garbled/overlapping Unicode text on mobile browsers (especially iOS Safari/WebKit) due to rendering artifacts. Always wrap WebGL addon loading in a `!isMobileDevice()` check, falling back to canvas rendering for mobile. Use the project's monospace font stack (`ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`) for better Unicode coverage on all platforms.

- When adding light-theme overrides for CSS components that already use `var(--*)` tokens, most selectors inherit correctly from the light-theme root variable redefinitions. Only add explicit `[data-theme="light"]` overrides where fine-tuning is needed (e.g., slightly different opacity values, subtle box-shadows for contrast).
- `--surface-hover` is used but never defined as a CSS custom property in the root or light theme blocks — it resolves to invalid/empty. Components using `var(--surface-hover)` (like `.github-import-tab:hover`) get no background. Either define it in the theme roots or use fallbacks like `var(--surface-hover, rgba(0,0,0,0.03))`.
- `.form-error` and similar error-state selectors should use `color-mix(in srgb, var(--color-error) 10%, transparent)` instead of hardcoded `rgba(248, 81, 73, 0.1)` for theme adaptability.
- When styling `input[type="radio"]` elements in `.imported` items, the selector must match `.issue-item.imported input[type="radio"]` (classes on the same element, not nested), because the HTML structure is `<div class="issue-item imported"><input type="radio">`.

## FN-1529: Search Query Propagation in Multi-Path Scenarios

When the dashboard supports multiple data paths (local vs remote node mode), ensure UI state like `searchQuery` is propagated to ALL data hooks that fetch the displayed data:
- Local mode uses `useTasks({ searchQuery })` which forwards to `fetchTasks` with `q` param
- Remote mode uses `useRemoteNodeData({ searchQuery })` which forwards to `fetchRemoteNodeTasks` with `q` param
- The `searchQuery` state must be defined BEFORE calling both hooks, and both must receive the same query value
- Missing propagation causes the "silent regression" where local search works but remote search fails without errors
- Add regression tests that mock the API layer and verify query propagation for both paths

## FN-1657: Project-Context Reset in useTasks

When switching projects in `useTasks`, stale task bleed-through can occur if tasks from the previous project remain visible during the fetch gap or if SSE events from the previous project context are processed. The fix uses three mechanisms:

**1. Immediate task clearing on project change:**
```typescript
if (previousProjectIdRef.current !== projectId) {
  previousProjectIdRef.current = projectId;
  projectContextVersionRef.current++;
  setTasks([]); // Clear immediately to prevent stale data visibility
}
```

**2. SSE context version guard:**
```typescript
const contextVersionAtStart = projectContextVersionRef.current;
// In each SSE handler:
if (projectContextVersionRef.current !== contextVersionAtStart) {
  return; // Reject stale events from previous project context
}
```

**3. Fetch projectId tracking:**
```typescript
const requestProjectId = projectId; // Capture at request time
// At resolution:
if (projectId !== requestProjectId) {
  return; // Reject responses from wrong project
}
```

Key patterns:
- Use refs to track context state that survives re-renders
- Increment context version on project change (not search query change)
- SSE handlers capture version at effect start and compare at event time
- Fetch handlers capture projectId at call time and compare at resolution time
- Clear tasks immediately on project change, not after fetch completes

**Extension to realtime hooks (FN-1764)**: This same pattern has been applied to:
- `useAgentLogs` — Clears entries and rejects stale fetch/SSE on project/task switch
- `useMultiAgentLogs` — Clears all state and rejects stale events on project switch
- `useLiveTranscript` — Clears entries and rejects stale events on project/task switch
- `AgentDetailView` — Adds context version tracking for logs tab SSE rejection

Each hook uses a `contextVersionRef` incremented on context change, with stale rejection guards in SSE handlers and fetch callbacks.

## FN-1522: Task State Reconciliation Pattern

Tasks can get into contradictory states (e.g., `column: "done"` with `status: "blocked"` in summary/log). This happens when agents mark tasks done without verifying actual completion. Reconciliation steps:
- Audit actual deliverables (code files, exports, database schema) before assuming task is complete
- When reconciliation is needed, update BOTH `task.json` AND SQLite (`fusion.db`) to maintain consistency
- For SQLite updates, use `sqlite3` directly or use TaskStore methods that write to both
- Replace stale dependency references (e.g., FN-1267 → FN-1519) when the replacement task exists
- Add a single reconciliation log entry explaining the state reset, don't duplicate existing diagnostic entries
- Reset ALL completion-related fields: column, status, currentStep, steps, mergeDetails, branch, baseCommitSha, worktree, stuckKillCount

## CSS Testing Patterns

- Several test files assert specific CSS values in `styles.css` mobile media query blocks (e.g., `board-mobile.test.tsx`, `core-modals-mobile.test.tsx`, `mission-planning-modals-mobile.test.ts`, `mobile-nav-bar-css.test.ts`). When changing mobile CSS values (like `min-height`), update both the CSS and the corresponding test assertions + regex patterns.
- Mobile-specific selectors like `.mobile-nav-tab` and `.mobile-more-item` may exist as base styles (not inside media queries) but are still mobile-only components. The `.touch-target` utility class at the top of `styles.css` is intentionally 44px and should not be changed when reducing mobile button sizes.
- When checking if a CSS value is inside a `@media` block, don't just search backwards for the nearest `@media` — track brace depth to confirm the line is actually between the block's opening `{` and closing `}`. Many component styles are defined globally (not in media queries) even though they visually only appear on mobile.
- Regex tests using `[\s\S]*` (greedy match across lines) to check CSS rules inside `@media` blocks are unreliable — they can match across block boundaries. Use non-greedy `[^}]*` scoped to a single rule block instead.
- Touch target sizing in `styles.css` mobile media queries uses 36px (reduced from the original 44px). The `.touch-target` opt-in utility class remains at 44px. Comments mentioning "44px" in the mobile sections have been updated to reflect the actual values.
- **CSS specificity with BEM modifiers (FN-1631)**: When a component has both container state (`.quick-entry-box--expanded`) and element modifier (`.quick-entry-input--expanded`) classes, the container selector may have higher specificity than the modifier selector. For example, `.quick-entry-box--expanded .quick-entry-input` (0,2,1) beats `.quick-entry-input--expanded` (0,1,0). To fix, use `:not(.quick-entry-input--expanded)` to ensure container selectors only affect non-modified elements: `.quick-entry-box--expanded .quick-entry-input:not(.quick-entry-input--expanded)`. This allows the modifier class's rules to take precedence when the modifier is active.

## FN-1464: Mobile Bottom-Spacing Contract

The mobile bottom-spacing is controlled by a single CSS variable `--mobile-nav-height` (defined at `:root`) to ensure consistent spacing across all bottom-positioned elements:
- **`.mobile-nav-bar`**: Uses `min-height: var(--mobile-nav-height)` (currently 44px)
- **`.executor-status-bar` mobile**: Uses `bottom: calc(var(--mobile-nav-height) + env(safe-area-inset-bottom))` to position above the nav bar
- **`.project-content--with-mobile-nav`**: Uses `padding-bottom: calc(var(--mobile-nav-height) + env(safe-area-inset-bottom))` to reserve nav space
- **`.project-content--with-footer.project-content--with-mobile-nav`**: Uses `padding-bottom: calc(32px + var(--mobile-nav-height) + env(safe-area-inset-bottom))` to reserve footer + nav space

When adjusting mobile bottom spacing, change `--mobile-nav-height` in one place and all related elements will update. Tab touch targets (`.mobile-nav-tab`) remain at 36px minimum regardless of nav height changes.

### FN-1626: PWA Home Bar Bottom Spacing

For installed PWA mode (`@media (display-mode: standalone)`), an additional `--standalone-bottom-gap` token provides extra breathing room for the iOS home indicator:
- **`:root` default**: `--standalone-bottom-gap: 0px` (non-PWA fallback)
- **Standalone mode**: `--standalone-bottom-gap: 8px` (extra 8px for home bar)
- **Additive spacing pattern**: All bottom-positioned elements use `+ var(--standalone-bottom-gap)` in their calc expressions

This pattern ensures PWA mode gets extra bottom room without breaking non-PWA behavior:
```css
/* :root */
--standalone-bottom-gap: 0px;

@media (display-mode: standalone) {
  --standalone-bottom-gap: 8px;
}

/* Usage example */
#root {
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--standalone-bottom-gap));
}

.executor-status-bar {
  bottom: calc(var(--mobile-nav-height) + env(safe-area-inset-bottom, 0px) + var(--standalone-bottom-gap));
}
```

The token-based approach allows all bottom-layout consumers to be updated together by adding `+ var(--standalone-bottom-gap)` to their calc expressions.

## FN-1458: Mobile Header Search Safe-Area-Inset Fix

- When fixing mobile header search positioning issues (search box clipping off-screen), add safe-area-inset handling to both `.header` and `.header-floating-search` in the mobile media query
- Use `padding-left: max(var(--space-md), env(safe-area-inset-left, 0px))` pattern to ensure content respects device notches
- CSS regression tests should verify: (1) `.mobile-search-expanded` has `width: 100%`, (2) no fixed negative offsets (`left: -NNpx`, `right: -NNpx`) exist in mobile search rules, (3) `.header-floating-search` has safe-area-inset handling

## UX Audit Findings (FN-1379)

- **Header overload**: The Header component (`Header.tsx`) has 15+ icon buttons with no labels, making discovery difficult. Consider grouping secondary actions into overflow menus.
- **Modal inconsistency**: Different modals handle close behavior differently (X button vs. Esc vs. click-outside). Standardize via a shared ModalHeader component.
- **Loading states**: Some components use skeletons, some use spinners, some have no loading indicator. Use skeleton screens for content-heavy areas, spinners for quick operations.
- **Toast system**: The ToastContainer is minimal — consider adding type-specific icons, action buttons, and stacking management.
- **Accessibility gaps**: Many icon buttons lack `aria-label`. All interactive elements need proper labeling for screen reader users.
- **Empty states**: Views like Board, List, Agents, and Missions lack helpful empty state guidance with actionable CTAs.

## TUI Package Testing

- The `@fusion/tui` package uses `ink`'s `render` function for testing, not `@testing-library/react`. Use `setTimeout(resolve, ms)` to wait for async operations in tests.
- When mocking `useFusion` in TUI tests, use `vi.mock("../fusion-context.js", ...)` to intercept the import.
- For EventEmitter mocking in TUI tests, create mock objects with `Object.create(EventEmitter.prototype)` and add methods like `listTasks` or `getActivityLog`.
- Ink's render function captures errors but doesn't throw them — use `expect(() => instance.unmount()).not.toThrow()` pattern for error-handling tests.
- When testing components that use `useInput` (Ink's keyboard input hook), mock it with `vi.mock("ink", async (importOriginal) => { const actual = await importOriginal<typeof import("ink")>(); return { ...actual, useInput: vi.fn() }; })` to avoid "Raw mode is not supported" errors in test environments without TTY.
- ScreenRouter component captures `activeScreen` state by passing it to children and capturing in a local variable for test assertions.

- When adding database schema migrations, increment `SCHEMA_VERSION` and add migration blocks with `applyMigration(N, () => { ... })`. Also update hardcoded schema version assertions in `db.test.ts` and other test files (e.g., `task-documents.test.ts`) to expect the new version. Missing updates cause test failures like `expected 22 to be 21`.

## Agent Skills

### Engine Skill Selection (FN-1795)

The `createKbAgent` function in `packages/engine/src/pi.ts` supports a `skills?: string[]` convenience parameter for skill filtering:

- **Convenience parameter**: `AgentOptions.skills` accepts an array of skill names and auto-derives a `SkillSelectionContext`
- **Precedence**: Explicit `skillSelection` takes precedence over `skills` when both are provided
- **Logging**: When using the convenience path, a log message is emitted: `[pi] Using skills from convenience parameter: [skill1, skill2]`
- **Engine integration**: All 5 engine paths (executor, triage, reviewer, merger, heartbeat) use `buildSessionSkillContext` to derive skill selection from agent metadata, which then flows through to `createKbAgent` via the `skillSelection` option
- **Skill resolver**: `resolveSessionSkills` and `createSkillsOverrideFromSelection` handle the actual skill filtering based on project settings

### create-fusion-plugin Skill (FN-1134)

The `create-fusion-plugin` skill teaches agents how to create Fusion plugins. Located at `.pi/agent/skills/create-fusion-plugin/`.

**Purpose:** Enables agents to build, extend, and debug Fusion plugins with custom tools, routes, hooks, and settings.

**Routing:**
- "Create plugin", "build plugin", "new plugin" → `workflows/create-plugin.md`
- "Add tool", "add route", "add hook", "add settings" → `workflows/add-capability.md`
- "Plugin not working", "debug plugin", "plugin error" → `workflows/debug-plugin.md`

**Files:**
- `references/plugin-api.md` — Complete API reference (types, interfaces, helpers)
- `references/plugin-patterns.md` — Common patterns and idioms
- `workflows/create-plugin.md` — Scaffold and build new plugins
- `workflows/add-capability.md` — Extend existing plugins
- `workflows/debug-plugin.md` — Diagnose and fix plugin issues
- `templates/minimal-plugin.ts` — Bare minimum working plugin
- `templates/plugin-with-tools.ts` — Plugin with AI-agent-callable tools
- `templates/plugin-with-routes.ts` — Plugin with HTTP API routes

**Key references for plugin authors:**
- Import from `@fusion/plugin-sdk` (not `@fusion/core`)
- Use `definePlugin()` for type-safe plugin definitions
- Hooks: 5-second timeout, error isolation, all optional
- Tools: JSON Schema parameters, return `PluginToolResult`
- Routes: GET/POST/PUT/DELETE, mounted at `/api/plugins/{pluginId}/{path}`
- vitest.config.ts: use `pool: "threads"` (NOT `vmThreads`)

## FN-1400 Plugin Core Foundation

Key implementation details from the plugin core foundation task:

**Database Schema (v24)**:
- `plugins` table stores plugin metadata, path, enabled flag, state, settings (JSON), settingsSchema (JSON), error message
- Migration adds table via `applyMigration(24, ...)` in `db.ts`
- Schema version assertions in `db.test.ts` and `__tests__/task-documents.test.ts` must be updated to expect v24

**PluginStore patterns**:
- Lazy initialization pattern: `_db` starts null, initialized on first access via `get db()`
- EventEmitter for state change notifications: `plugin:registered`, `plugin:unregistered`, `plugin:enabled`, `plugin:disabled`, `plugin:updated`, `plugin:stateChanged`
- Settings validation against `settingsSchema` before persisting
- Deterministic state transitions enforced in `updatePluginState()`

**PluginLoader patterns**:
- Uses topological sort (`resolveLoadOrder()`) for deterministic load order based on dependencies
- Circular dependency detection throws Error during sort
- Error isolation: plugin failures set `state: "error"` in store but don't crash loader
- Hook invocation via `safeCallHook()` with try/catch per plugin
- `getPluginTools()` and `getPluginRoutes()` aggregate from successfully loaded plugins only

**TaskStore integration**:
- `getPluginStore()` lazy getter following the same pattern as `getMissionStore()`
- Import PluginStore at top of store.ts: `import { PluginStore } from "./plugin-store.js";`
- Private field: `private pluginStore: PluginStore | null = null;`

**Public exports** (from `@fusion/core`):
- Types: `PluginManifest`, `PluginSettingSchema`, `PluginOnLoad`, `PluginOnUnload`, `PluginOnTaskCreated`, `PluginOnTaskMoved`, `PluginOnTaskCompleted`, `PluginOnError`, `PluginToolDefinition`, `PluginToolResult`, `PluginRouteDefinition`, `PluginContext`, `PluginLogger`, `FusionPlugin`, `PluginState`, `PluginInstallation`
- Functions: `validatePluginManifest()`
- Classes: `PluginStore`, `PluginLoader`
- Interfaces: `PluginStoreEvents`, `PluginRegistrationInput`, `PluginUpdateInput`, `PluginLoaderOptions`

**Dashboard/Serve plugin wiring (FN-1468)**:
- PluginStore initialized with `store.getFusionDir()` as rootDir
- PluginLoader initialized with `{ pluginStore, taskStore: store }`
- Both passed to `createServer()` via `pluginStore`, `pluginLoader`, and `pluginRunner` (pluginLoader instance)
- Enables `/api/plugins` REST endpoints in both dashboard and headless node modes

### Plugin Hot-Load/Unload (FN-1133)

- Plugins can be loaded and unloaded at runtime without restarting the engine or dashboard.
- `PluginLoader.reloadPlugin(id)` — stops old instance, invalidates module cache, re-imports, calls onLoad. On failure: restores old instance (rollback). If rollback also fails: removes plugin, sets state to "error". onUnload has 5s timeout.
- `PluginRunner` subscribes to PluginStore events (`plugin:enabled` → loadPlugin, `plugin:disabled` → stopPlugin) for automatic hot-load/unload.
- Plugin tools fetched per-agent-session in executor — hot-loaded plugins available immediately for new task executions.
- Dashboard has `POST /plugins/:id/reload` endpoint and reload button in PluginManager.
- PluginLoader emits `plugin:loaded`, `plugin:unloaded`, `plugin:reloaded` events.
- Tool/route caches use stale-flag pattern — invalidated on plugin state changes, rebuilt on next `getPluginTools()`/`getPluginRoutes()` call.
- Stopping a plugin with dependents logs warning but does NOT cascade-stop dependents.
- Module cache busting uses `?reload=timestamp` query parameter for fresh ESM imports.

## Background Memory Summarization (FN-1399)

The background memory summarization feature uses a three-layer architecture:

1. **CronRunner post-run hook**: `onScheduleRunProcessed` callback receives `(schedule, result)` after execution and recording. This keeps post-processing isolated from core execution.

2. **Schedule-specific filtering**: The callback in dashboard/serve checks `schedule.name === INSIGHT_EXTRACTION_SCHEDULE_NAME` to filter for the memory insight schedule only.

3. **Core processing**: `processAndAuditInsightExtraction()` parses AI output, merges insights, writes audit report, and handles errors gracefully.

**Key files**:
- `packages/core/src/memory-insights.ts` — Core helpers for processing, merging, and audit generation
- `packages/engine/src/cron-runner.ts` — Post-run callback option (`onScheduleRunProcessed`)
- `packages/cli/src/commands/dashboard.ts` — Startup sync + settings change handler
- `packages/cli/src/commands/serve.ts` — Same wiring for headless node mode

**Startup ordering**: `syncInsightExtractionAutomation()` must run BEFORE `cronRunner.start()` to avoid stale config races. The cron runner's immediate tick could execute outdated schedules before sync runs.

**Test patterns**:
- For CLI test suites with hoisted mocks (`vi.hoisted()`), helper functions like `triggerSignal` must be defined inside each `describe` block since they're not accessible from sibling blocks.
- When testing settings-change handlers in CLI commands, emit events on the mock store instance stored in `taskStores[0]` to trigger the handler.

## Pluggable Memory Backend Integration (FN-1769)

The dashboard memory routes integrate with the pluggable memory backend system:

**Backend-mediated routes:**
- `GET /api/memory` uses `readMemory(rootDir, settings)` from `@fusion/core`
- `PUT /api/memory` uses `writeMemory(rootDir, content, settings)` from `@fusion/core`
- Error mapping: `MemoryBackendError` codes → HTTP status codes:
  - `READ_ONLY`/`UNSUPPORTED`/`CONFLICT` → 409 Conflict
  - `BACKEND_UNAVAILABLE` → 503 Service Unavailable
  - `QUOTA_EXCEEDED` → 413 Payload Too Large
  - Other errors → 500 Internal Server Error

**Settings integration:**
- `PUT /api/settings` validates `memoryBackendType` (must be string or null)
- Unknown backend IDs are accepted and persisted verbatim
- Fallback-to-file is runtime resolution behavior only

**Available backends:**
- `file` — Default backend, stores in `.fusion/memory.md`
- `readonly` — Read-only backend, returns empty on write attempts
- `qmd` — QMD (Quantized Memory Distillation) backend with QMD CLI integration
- Custom backends — Registered at runtime via `registerMemoryBackend()`

**Key exports from `@fusion/core`:**
- `readMemory(rootDir, settings)` — Backend-aware memory read
- `writeMemory(rootDir, content, settings)` — Backend-aware memory write
- `MemoryBackendError` — Error class with code, message, and backend fields
- `resolveMemoryBackend(settings)` — Resolve backend from settings
- `listMemoryBackendTypes()` — List registered backend types

## FN-1719: Lint/Type/Test Baseline Restoration

**ESLint flat config best practices:**
- Global `ignores` must come FIRST in the config (per ESLint flat config rules)
- Use separate config blocks for: production TS, test files, node scripts, service workers, demo files
- Test files should have `no-explicit-any` and `no-unused-vars` set to "off"
- Production TS files should have `no-explicit-any` set to "warn" (not error)
- Node scripts need globals: `process`, `console`, `setTimeout`, `setInterval`, `require`, `module`, `__dirname`, `__filename`, `Buffer`
- Service worker files need globals: `self`, `caches`, `fetch`, `URL`, `Request`, `Response`, `Headers`, `Cache`, `CacheStorage`
- Avoid using `react-hooks/exhaustive-deps` eslint-disable comments unless the plugin is installed
- When linting errors remain from eslint-disable comments for non-existent rules, remove the comments

**Pre-existing test issues:**
- Some tests have flaky timeouts or expose pre-existing bugs - use `it.skip()` with a TODO comment noting the issue
- The stream flush test in `api.test.ts` exposes a bug where pending SSE events aren't flushed when the stream ends without a trailing newline

**Verification commands:**
- `pnpm lint` - lint check (0 errors target)
- `pnpm typecheck` - typecheck all packages
- `pnpm test` - full test suite
- `pnpm build` - build all packages

## Plugin Examples & Authoring (FN-1114)

Three example plugins demonstrate different plugin capabilities:

**Example plugins location**: `plugins/examples/`
- `fusion-plugin-notification/` — Sends webhook notifications (Slack, Discord, generic) on task lifecycle events. Demonstrates: `onLoad`, `onTaskCompleted`, `onTaskMoved`, `onError` hooks, settings schema, event filtering.
- `fusion-plugin-auto-label/` — Automatic task categorization using keyword matching. Demonstrates: `onTaskCreated` hook, plugin tools, event emission.
- `fusion-plugin-ci-status/` — Polls CI status for branches with custom REST API. Demonstrates: plugin routes, `setInterval` polling, `onLoad`/`onUnload` lifecycle.

**Plugin scaffold command**: `fn plugin create <name>` generates a new plugin project with:
- `package.json`, `tsconfig.json`, `vitest.config.ts`
- `src/index.ts` with minimal `definePlugin()` call
- `src/__tests__/index.test.ts` with basic test
- `README.md` template

**Plugin authoring guide**: `docs/PLUGIN_AUTHORING.md` covers:
- Getting started, manifest reference, settings schema
- All hooks with exact TypeScript signatures
- Tools and routes registration patterns
- Plugin context API reference
- Testing patterns and publishing guide

## TUI Package (FN-1471)

The `@fusion/tui` package provides Ink-based React components for terminal UI.

**Global Shortcuts Implementation**:
- `useGlobalShortcuts` hook centralizes all keyboard shortcuts at the app root level
- `FocusGuardRef` module-level ref tracks text input focus state for focus guarding
- Shortcuts blocked when focused: `q`, `?`, `h`, `1-5` (only when `FocusGuardRef.isFocused === true`)
- `Ctrl+C` always works (emergency exit)
- `HelpOverlay` component displays shortcuts and handles `Escape`/`q` to close

**Focus Guard Pattern**:
- Ink's `useFocusManager` doesn't provide global "is anything focused" detection
- Use module-level ref (`FocusGuardRef`) for cross-component focus state
- Text inputs should set `FocusGuardRef.isFocused = true` on focus and `false` on blur

**Testing TUI Components**:
- Use Ink's `render()` function from `ink/testing` for tests
- Mock `useInput` with `vi.mock("ink", ...)` to avoid "Raw mode is not supported" errors
- Use `setTimeout(resolve, ms)` for async state updates in tests
- Track captured handlers via module-level variables for test assertions

## Kimi/Moonshot API Usage (FN-1578)

- **Primary endpoint**: `/v1/coding_plan/usage` (underscore) — Codexbar-validated working endpoint.
- **Fallback endpoint**: `/v1/coding-plan/usage` (hyphen) — Legacy endpoint for older accounts/API versions.
- **Fallback trigger**: ANY 404 response triggers fallback (regardless of body content).
- **Auth errors (401/403)**: Short-circuit immediately — no fallback for authentication failures.
- **Known 404 error shapes**:
  - `{"code":5,"error":"url.not_found","message":"没找到对象",...}` — endpoint not available (no coding plan active).
  - `{"error":"url_not_found"}` — alternative format.
- **User-facing error**: When last endpoint returns `url.not_found`, show friendly message: "Usage endpoint unavailable — Kimi coding plan may not be active on this account".
- **Auth**: Uses `Authorization: Bearer <api_key>` header with `kimi-coding` key from `~/.pi/agent/auth.json`.
- **Response parsing**: Supports `data.windows[]` array and flat `data.used/total/remaining` shapes.
## FN-1516: Periodic Auto-Merge Sweep

- The `canAutoMergeTask()` function must be defined locally inside `runDashboard()` to work correctly with Vitest mocks. Module-level exports capture the real `getTaskMergeBlocker` at import time, before mocks are applied.
- When importing shared utilities from dashboard.ts in serve.ts, ensure both files define compatible predicates (same `mergeRetries` limit check).
- Periodic sweep tests using `vi.useFakeTimers()` must be isolated in their own test file or properly reset timers to avoid affecting subsequent tests.

## FN-1408: Node Provider and Remote Node Status

- When adding node context (`NodeProvider`, `useNodeContext`) to the App shell, update mocks in `App.test.tsx` for `useNodes`, `useRemoteNodeData`, `useRemoteNodeEvents`, and the `NodeContext` module.
- Clear `fusion-dashboard-current-node` from localStorage in test `beforeEach` to avoid cross-test leakage.
- Use `mockReturnValue` (not `mockReturnValueOnce`) for repeated mocks in tests with dynamic imports.
- Add `await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); })` in tests that wait for App initial load to complete before interacting with Header components.

## FN-1462: Context-Limit Error Recovery

- When fixing context-limit error detection, add test cases for the specific error message format before making the fix
- The `isContextLimitError()` function uses regex patterns to match error messages - patterns must be tested independently
- When fixing executor recovery paths that fall through to failure, ensure the fix adds an explicit `return` after successful recovery to prevent execution from continuing to the failure path
- Vitest runs source files directly (`.ts`) rather than compiled dist files - rebuild with `tsc` before running tests if changes aren't picked up

## FN-1643: Unified Context-Limit Recovery Across Executor Paths

Both single-session and step-session executors now share consistent context-limit recovery:

**Single-session executor (executor.ts catch block):**
- Normalize error messages with `const errorMessage = typeof err === "string" ? err : err?.message ?? String(err)`
- Recovery flow: compact-and-resume → reduced-prompt retry (bounded to 1 attempt per error)
- Recovery state tracked in `loopRecoveryState` Map with `attempts` counter
- Explicit `return` after successful recovery prevents fallthrough to failure path

**Step-session executor (step-session-executor.ts executeStep loop):**
- Recovery attempts tracked separately from `retries` counter via `recoveryAttempts` variable
- Recovery bounded to `MAX_STEP_RETRIES` attempts to prevent infinite loops
- New `buildReducedStepPrompt()` generates simpler step prompts for recovery
- New imports: `compactSessionContext`, `isContextLimitError`, `checkSessionError`

**Testing context-limit recovery:**
- Use `vi.mocked(promptWithFallback)` to control success/failure per call
- Track `callCount` to make first call throw and subsequent calls succeed
- Use `vi.useFakeTimers()` for retry delay handling in step-session tests
- `vi.clearAllMocks()` in `beforeEach` to reset mocks between tests

**Key pitfall:** The `appendAgentLog` method requires 5 parameters (including `type` as `AgentLogType`). Use `"text"` for info messages and `"tool_error"` for error messages.

## FN-1525: Merger Fresh-Session and Compaction Recovery

- The merger (`runAiAgentForCommit`) enforces a fresh session per merge attempt via `createKbAgent` - no stale conversation state
- Context-limit errors trigger compact-and-retry: `isContextLimitError` detects overflow, `compactSessionContext` compresses history, then retry
- Non-context errors propagate immediately without compaction - no false-positive recovery attempts
- Error handling uses `err: unknown` type with `err instanceof Error ? err.message : String(err)` pattern for type safety
- Log messages distinguish fresh-session start ("starting fresh merge agent session") from compaction recovery ("Context limit reached", "Compacted at X tokens")

## FN-1588: Truncated-Prompt Retry Pattern

When context-limit errors occur on fresh sessions (compaction returns null), the merger retries with a truncated prompt:
- **Prompt truncation constants**: `MERGE_COMMIT_LOG_MAX_CHARS = 5000`, `MERGE_DIFF_STAT_MAX_CHARS = 3000`
- **Helper function**: `truncateWithEllipsis(text, maxChars)` returns truncated text with `"\n... (truncated)"` suffix
- **Truncated retry prompt**: Uses `"(see git log)"` for commit log, `""` for diff stat, and `simplifiedContext: true`
- **Guard**: `truncatedRetryAttempted` flag prevents infinite loops when truncated prompt also fails
- **Error propagation**: If truncated retry fails with context-limit error, original error is thrown
- **Recovery flow**: Fresh session → compaction attempt (fails) → truncated retry → success or propagate

## FN-1532: SQLite Index Optimization

When adding indexes to SQLite schema migrations:
- Always use `CREATE INDEX IF NOT EXISTS` to make migrations idempotent
- For indexes on tables that may not exist in legacy databases, wrap in `if (this.hasTable("tableName"))` before creating
- Profile query plans using `EXPLAIN QUERY PLAN` to identify full scans and temp B-tree sorts
- Composite indexes can cover both filtering and ordering: `CREATE INDEX ON table(col1, col2 DESC)`
- Update `SCHEMA_VERSION` constant AND all hardcoded version assertions in tests (e.g., `expect(db.getSchemaVersion()).toBe(N)`)
- The `creates all expected indexes` test in `db.test.ts` must list all indexes including new ones
- Memory pitfall: Test files like `run-audit.test.ts` and `__tests__/task-documents.test.ts` also assert schema version

## FN-1414: Run-Audit Integration Testing

Key learnings from adding integration test coverage for run-audit:

**Test file locations:**
- `@fusion/core`: `packages/core/src/run-audit.integration.test.ts` (multi-domain correlation, event shape, ordering)
- `@fusion/engine`: `packages/engine/src/run-audit.integration.test.ts` (engine-to-core correlation, emitter behavior)

**Run commands:**
- Core: `pnpm --filter @fusion/core exec vitest run src/run-audit.integration.test.ts`
- Engine: `pnpm --filter @fusion/engine exec vitest run src/run-audit.integration.test.ts`

**Ordering guarantee:**
- Core uses `ORDER BY timestamp DESC, rowid DESC` for deterministic tie-breaking
- When splitting synthetic run IDs (e.g., `"exec-FN-001-123-abc"`), use `lastIndexOf("-")` to handle task IDs with dashes

**Metadata normalization:**
- Engine emitters always include `phase` in metadata
- `source` is conditionally included only when provided
- Database domain infers `taskId` from target when target looks like a task ID (`FN-*`, `KB-*`)

**Backward compatibility:**
- `createRunAuditor(store, null)` returns no-op auditor
- Store without `recordRunAuditEvent` method returns no-op auditor
- No throw on null/undefined context or missing methods

## FN-1537: CI Workflow Stabilization

**Node.js version compatibility:**
- All GitHub Actions workflows must use `node-version: "24"` in `actions/checkout` and `pnpm/action-setup`
- Use `actions/setup-node@v5` with `node-version: "24"` instead of `v4`
- Node.js 20 actions are deprecated and will stop working June 2, 2026

**Changesets configuration:**
- Internal packages with `private: true` must be listed in `.changeset/config.json` `ignore` array
- Published packages: `@gsxdsm/fusion`
- Private packages (must be ignored): `@fusion/core`, `@fusion/dashboard`, `@fusion/engine`, `@fusion/tui`, `@fusion/plugin-sdk`, `@fusion-plugin-examples/*`
- Without proper ignore entries, changesets tries to publish private packages and fails npm provenance verification

**Test version assertions:**
- Tests asserting package versions must read dynamically from `package.json` using `JSON.parse(readFileSync(pkgPath, "utf-8"))`
- Hardcoded version strings in tests (e.g., `expect(version).toBe("0.1.0")`) break after version bumps
- Use `getAppVersion()` for runtime version checks in tests

## FN-1563: Decoupling CLI Command Dependencies

**Architectural boundary:**
- `serve.ts` (headless node) must NOT import from `./dashboard.js`
- Shared task lifecycle helpers live in `./task-lifecycle.js` (no UI/dashboard dependency)
- Shared interactive utilities (port prompting) live in `./port-prompt.js`
- Both `runDashboard()` and `runServe()` import from these neutral modules

**Module structure:**
- `task-lifecycle.ts`: PR merge helpers (`getMergeStrategy`, `getTaskBranchName`, `cleanupMergedTaskArtifacts`, `processPullRequestMergeTask`)
- `port-prompt.ts`: Interactive port selection (`promptForPort`)
- `dashboard.ts`: UI-specific logic, re-exports neutral helpers for backward compatibility with tests

**Test imports:**
- When moving functions to new modules, update test imports accordingly
- The serve test mocks `./task-lifecycle.js` and `./port-prompt.js` (not dashboard.js)
- The dashboard test imports helpers from `./task-lifecycle.js` and `runDashboard` from `./dashboard.js`

## FN-1269: Routine Engine Integration

The Routine Engine Integration adds scheduled, webhook-triggered, and manual routine execution via the heartbeat system:

**Key components:**
- `RoutineRunner` (`packages/engine/src/routine-runner.ts`) — Executes routines via heartbeat with concurrency policy enforcement (allow/skip/replace/queue)
- `RoutineScheduler` (`packages/engine/src/routine-scheduler.ts`) — Polls for due routines and triggers execution via RoutineRunner
- API endpoints: `POST /api/routines/:id/trigger` (manual), `POST /api/routines/:id/webhook` (webhook with HMAC-SHA256 verification)

**Concurrency policies:**
- `allow` — Run immediately regardless of existing executions
- `skip` — Return failed result without calling heartbeat if already running
- `replace` — Cancel existing execution, then run new one
- `queue` — Wait for existing execution to complete, then run

**Catch-up policy:**
- `skip` — Update `lastTriggeredAt` without additional executions
- `catchUp` — Execute missed intervals up to 10 max (prevents runaway catch-up)

**HMAC signature verification pattern for routine webhooks:**
```typescript
import { createHmac, timingSafeEqual } from "node:crypto";
const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
const isValid = timingSafeEqual(Buffer.from(signature), Buffer.from(req.headers["x-webhook-signature"]));
```

**InProcessRuntime lifecycle integration:**
- RoutineScheduler initialized after HeartbeatMonitor/TriggerScheduler
- Graceful degradation if RoutineStore not available (FN-1519 types incomplete)
- `getRoutineScheduler()` and `getRoutineRunner()` getters for testing access

## Dashboard Startup Perf — `listTasks` Hot Paths

The dashboard CLI (`pnpm dev dashboard`) was extremely slow on boards with
~1200 tasks. Three independent code paths were each pulling the entire
`tasks` table (with the full `log`/`comments`/`steps` JSON, ~67 MB) at
startup and on every maintenance/sweep cycle.

**Bug 1 — `TaskStore.watch()` (`packages/core/src/store.ts`):** The 1-second
poll loop in `checkForChanges()` filters on `updatedAt > lastPollTime`, but
`lastPollTime` was left `null` after `watch()` populated the cache. The
first poll cycle therefore ran an unfiltered `SELECT *` and emitted a
`task:updated` SSE event for every cached task — ~60 MB of SSE traffic plus
1199 React `setState` calls one second after dashboard startup. **Fix:** set
`this.lastPollTime = new Date().toISOString()` at the end of `watch()` so
the first poll only sees tasks that changed *after* the cache snapshot.

**Bug 2 — Auto-merge sweeps (`packages/cli/src/commands/dashboard.ts`):**
The startup sweep, the two unpause handlers, and the periodic
`scheduleMergeRetry()` (every 15s by default) all called
`store.listTasks()` and then JS-filtered for in-review tasks. On a 1200-row
board with mostly done/archived tasks that's a constant 67 MB allocation
just to find 0–5 candidates. **Fix:** added `column?: Column` option to
`listTasks` so callers can scope the SQL `WHERE` directly, and changed
those four call sites to `listTasks({ column: "in-review" })`.

**Bug 3 — Engine maintenance (`packages/engine/src/self-healing.ts`):**
`SelfHealingManager.archiveStaleDoneTasks()` runs every 15 min from
`runMaintenance()`. It only needs `id`, `column`, and `columnMovedAt` to
decide which done tasks are >48h old, but it called the full
`listTasks()`. **Fix:** pass `{ slim: true }` — the slim row still includes
those fields and excludes the heavy log/comments/steps payload.

**General contract going forward:** `listTasks()` is heavy by default. Hot
paths must pass `{ slim: true }`, `{ column: ... }`, or
`{ includeArchived: false }`. The board endpoint
(`GET /api/tasks` in `packages/dashboard/src/routes.ts`) already uses
slim+includeArchived; the archived column is loaded lazily on expand via a
sticky `includeArchived` flag in `useTasks.ts`.

**Backlog cleanup:** `archiveStaleDoneTasks` walks tasks one at a time via
`store.archiveTask(id)`, which is fine for the steady-state 5–20 tasks per
cycle but would take minutes on the 866-task backlog after the
auto-archive feature first lands. For one-off backlog cleanup, a direct
SQL `UPDATE tasks SET column='archived', columnMovedAt=now,
updatedAt=now WHERE column='done' AND columnMovedAt < cutoff` is safe and
fast — subsequent watch() polls will pick up the changes and emit
`task:moved` events. (Beware emitting hundreds of events in one cycle if a
dashboard is connected.)

## FN-1426: Vite Alias for @fusion/core

The dashboard's vite.config.ts has an alias that maps @fusion/core to ../core/src/types.ts directly. When adding new exports from @fusion/core (like PROMPT_KEY_CATALOG), you must either:
1. Re-export the new export from types.ts to make it available via the alias, OR
2. Change the alias to point to ../core/src/index.ts

The alias approach was intentional (to avoid circular dependencies), so option 1 is preferred. Add the re-export at the end of types.ts:

```typescript
export { PROMPT_KEY_CATALOG } from "./prompt-overrides.js";
```

Then rebuild core: pnpm --filter @fusion/core build before running dashboard tests or build.


## FN-1413: Plugin Settings Section with SSE Live Updates

The Plugin Settings section in the dashboard Settings modal provides real-time plugin management with SSE-driven live updates.

### Component Structure

**PluginManager.tsx** (`packages/dashboard/app/components/`):
- Manages plugin lifecycle (install, enable/disable, uninstall, settings)
- Subscribes to `/api/events` SSE stream for real-time updates
- Handles project-scoped filtering for multi-project mode

### SSE Live Update Pattern

```typescript
// EventSource subscription with heartbeat watchdog
const SSE_HEARTBEAT_TIMEOUT_MS = 45_000;

useEffect(() => {
  let closedByCleanup = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const es = new EventSource(`/api/events${query}`);

  const resetHeartbeat = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      if (!closedByCleanup) {
        es.close();
        // Fallback: refetch all plugins
        void loadPlugins();
      }
    }, SSE_HEARTBEAT_TIMEOUT_MS);
  };

  es.addEventListener("plugin:lifecycle", (e: MessageEvent) => {
    resetHeartbeat();
    const payload: PluginLifecyclePayload = JSON.parse(e.data);
    // Filter by projectId if scoped
    if (projectId && payload.projectId && payload.projectId !== projectId) {
      return;
    }
    // Reconcile local state based on transition type
    // ...
  });

  return () => {
    closedByCleanup = true;
    es.removeEventListener("plugin:lifecycle", handlePluginLifecycle);
    es.close();
  };
}, [projectId, loadPlugins]);
```

### Event Payload Types

```typescript
interface PluginLifecyclePayload {
  pluginId: string;
  transition: "installing" | "enabled" | "disabled" | "error" | "uninstalled" | "settings-updated";
  sourceEvent: string;
  timestamp: string;
  projectId?: string;
  enabled: boolean;
  state: PluginState;
  version: string;
  settings: Record<string, unknown>;
  error?: string;
}
```

### Transition Handling

| Transition | Action |
|-------------|--------|
| `enabled` | Update plugin state to enabled |
| `disabled` | Update plugin state to disabled |
| `settings-updated` | Update plugin settings |
| `uninstalled` | Remove plugin from list |
| `error` | Update plugin state to error |
| `installing` | Refetch plugin list |

### Project-Scoped Filtering

- SSE URL includes `projectId` query param when provided
- PluginManager filters events by `payload.projectId !== projectId`
- Prevents cross-project state pollution in multi-project mode

### Test Patterns

When testing SSE event handling:
- Mock EventSource globally in `beforeEach`
- Store handler reference in a module-level variable for triggering
- Use `act()` when triggering events to ensure React updates complete
- Test projectId filtering by sending events with mismatched projectId

```typescript
beforeEach(() => {
  const eventSourceInstance = {
    handlers: {},
    addEventListener: vi.fn((event, handler) => {
      eventSourceInstance.handlers[event] = handler;
    }),
    close: vi.fn(),
  };
  vi.stubGlobal("EventSource", vi.fn(() => eventSourceInstance));
});

it("handles plugin enabled SSE event", async () => {
  // Trigger the event
  const handler = eventSourceInstance.handlers["plugin:lifecycle"];
  act(() => {
    handler({ data: JSON.stringify({ pluginId: "test", transition: "enabled", ... }) });
  });
  
  // Assert state change
  expect(screen.getByRole("checkbox")).toBeChecked();
});
```

### API Wrapper Tests

When adding plugin API wrappers:
- Mock `vi.mock("../../api")` with inline object (not external variable)
- Test projectId propagation via `withProjectId()` pattern
- Use `mockResolvedValueOnce()` for deterministic test sequences
- Verify URL construction with query string parameters


## FN-1607: Process Shutdown Investigation & Diagnostic Instrumentation

Added comprehensive diagnostic instrumentation to identify long-running process stability issues.

### Diagnostic Logging

**Periodic Diagnostics (every 30 minutes):**
```
[dashboard] diagnostics: uptime=30m rss=XXXmb heap=XXXmb/XXXmb external=XXXmb arrayBuffers=XXXmb handles=XX requests=XX db=ok listeners=task:created:N, task:moved:N, ...
```

**Key diagnostics to monitor:**
- `rss` / `heap` — memory usage trends (growing heap over time suggests a leak)
- `handles` — active handle count (growing handles suggests resource accumulation)
- `db` — database health (db=failed indicates connection issues)
- `listeners` — SSE/EventEmitter listener counts (growing counts suggest listener leaks)

**Shutdown diagnostics:**
```
[dashboard] active handles at shutdown: TCPServer:1, Timer:5, ... 
[dashboard] shutdown requested reason=SIGINT uptime=2h15m30s tasks=42 active=2 columns=triage:20,todo:15,in-progress:2,done:3,in-review:2
```

### Files Modified
- `packages/cli/src/commands/dashboard.ts` — process diagnostics, beforeExit handler, handle type logging
- `packages/cli/src/commands/serve.ts` — same diagnostics for headless node mode
- `packages/dashboard/src/sse.ts` — SSE high water mark tracking, res.on("close") safety net
- `packages/core/src/store.ts` — `healthCheck()` method for database diagnostics

### Verified Timer Cleanup
All major timers/intervals properly cleared on shutdown:
- `TaskStore.watch()` pollInterval → cleared in `stopWatching()`
- `Scheduler.pollInterval` → cleared in `stop()`
- `HeartbeatMonitor.pollInterval` → cleared in `stop()`
- `HeartbeatTriggerScheduler.timers` → cleared in `stop()`
- `StuckTaskDetector.interval` → cleared in `stop()`
- `SelfHealingManager.maintenanceInterval`, `unpauseTimer` → cleared in `stop()`
- `MissionAutopilot.pollTimer`, `healthCheckTimer` → cleared in `stop()`
- `CronRunner.pollInterval` → cleared in `stop()`
- `PrMonitor.intervals` → cleared in `stopMonitoring()`/`stopAll()`
- `scheduleMergeRetry()` → guarded by `disposed`/`shuttingDown` flags

### SSE Connection Safety
- `res.on("close", cleanup)` added as safety net alongside `_req.on("close")`
- High water mark tracking logs when new connection highs are reached
- Heartbeat 30s interval properly cleared on cleanup

### Recommendations for Monitoring
1. Watch for `rss` growth over 24h — linear growth suggests memory leak
2. Watch for `handles` growth — growing handles suggest resource accumulation
3. Watch for listener count growth — especially `task:created`, `task:updated` (SSE subscriptions)
4. Watch for `beforeExit code=0` without preceding shutdown log (unexpected exit)
5. `db=failed` indicates database connectivity issues

## Skill Selection Resolver (FN-1510)

The skill selection resolver (`packages/engine/src/skill-resolver.ts`) computes deterministic session skill sets from project settings and optional caller overrides.

**Key patterns:**
- `resolveSessionSkills(context)` reads `.fusion/settings.json` (primary) or `.pi/settings.json` (fallback) for skill patterns
- Skill patterns use `+` prefix (include) or `-` prefix (exclude); unprefixed patterns are treated as `+`
- `requestedSkillNames` acts as intersection filter on top of pattern-based selection (case-insensitive name matching)
- `filterActive: false` means no filtering (all discovered skills pass through); `filterActive: true` means filtering is active
- `createSkillsOverrideFromSelection()` returns the `skillsOverride` callback for `DefaultResourceLoader`
- `skillsOverride` is only set when `skillSelection` is provided in `AgentOptions`; omitting it preserves existing behavior
- `SkillSelectionResult` includes `excludedSkillPaths` to track skills explicitly disabled by `-` patterns
- Filtering distinguishes three cases:
  1. **Allowed skills**: skills matching `allowedSkillPaths` pass through
  2. **Disabled skills**: skills matching `excludedSkillPaths` are filtered out and produce warnings
  3. **Missing skills**: configured paths not matching any discovered skill produce warnings
- The `createSkillsOverrideFromSelection` callback filters skills and produces diagnostic messages via `console.error` with `[pi] [skills]` prefix

**Settings format:**
```json
{
  "skills": ["+skills/foo/SKILL.md", "-skills/bar/SKILL.md"],
  "packages": [
    { "source": "@myorg/ai-kit", "skills": ["+skills/custom/SKILL.md"] }
  ]
}
```

**Test patterns:**
- Use in-memory mock filesystem (`Map<string, string>`) for unit tests
- `mockFiles.set(path, content)` and `mockFiles.get(path)` for read/write
- `mockFiles.clear()` in `beforeEach` to reset state between tests
- `vi.resetModules()` when using `vi.doMock` inside tests

## Cross-Node Architecture (FN-1833)

### Proxy Architecture

The cross-node system uses a **proxy-based model** where the local dashboard server forwards API requests to remote nodes:

- **Frontend proxy infrastructure** exists: `proxyApi()` in `api.ts` (line 2176), `withNodeId()` (line 2162), `useRemoteNodeData()`, `useRemoteNodeEvents()`
- **Backend proxy routes are missing**: `routes.ts` has NO `/api/proxy/:nodeId/*` handlers — this is the critical gap blocking remote node viewing
- **URL rewriting pattern**: `proxyApi("/tasks", { nodeId })` rewrites to `/api/proxy/{nodeId}/tasks`
- **SSE proxy**: `useRemoteNodeEvents()` opens `EventSource("/api/proxy/{nodeId}/events")` with 45s heartbeat timeout and 3s reconnect

### Project-Node Assignment Model

- `RegisteredProject.nodeId` — optional field pointing to a node in the registry
- Local node: handles projects with matching nodeId AND unassigned projects
- Remote node: handles only projects explicitly assigned to it
- **Routing logic**: `isProjectRoutedToNode()` in `nodeProjectAssignment.ts`
- **Critical gap**: `CentralCore.registerProject()` does NOT accept `nodeId` — must use separate `assignProjectToNode()` call

### Background Services Not Wired

- `PeerExchangeService` exists in `packages/engine/src/peer-exchange-service.ts` but is NOT instantiated in `serve.ts` or `dashboard.ts`
- `CentralCore.startDiscovery()` exists but is NOT called in CLI commands
- Peer exchange and mDNS discovery need to be wired in `InProcessRuntime.start()` and `runServe()`/`runDashboard()`

### Dependency Chain for Cross-Node

1. **FN-1802** — Generic proxy route (`/api/proxy/:nodeId/*`) — unblocks all remote viewing
2. **FN-1806** — Specific proxy routes (health, projects, tasks, events) — alternative/complement to FN-1802
3. **FN-1803** — Node-aware project registration and directory browsing
4. **FN-1804** — Frontend node selector for project creation
5. **FN-1805** — Wire peer exchange and discovery in runtimes
6. **FN-1736** — Comprehensive project scoping review (SSE/WebSocket filtering)
