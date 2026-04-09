# Project Memory

## Architecture

- `TaskExecutor` terminates active agent sessions (single and step) when tasks are moved away from `in-progress` via the `task:moved` event handler. This prevents zombie sessions when users manually send tasks back to todo/triage from the board UI.
- Agent preset templates in `NewAgentDialog.tsx` are a UI-only concept (`AgentPreset` interface), separate from the engine's `AgentPromptTemplate` type. Presets populate agent creation fields (name, icon, role, soul, instructionsText) but don't map to engine types.
- `soul` and `instructionsText` are already supported in `AgentCreateInput` and `AgentUpdateInput` — no API changes needed when adding these to presets.
- `CronRunner` uses dependency injection for AI prompt execution: an `AiPromptExecutor` function is injected via options. This keeps it decoupled from `createKbAgent` and testable without real agent sessions.
- `createAiPromptExecutor(cwd)` is an async factory function that creates a new agent session per call, uses `onText` for text accumulation, and disposes sessions in a `finally` block.
- The factory uses lazy `import("./pi.js")` to avoid pulling the pi SDK into the module graph when AI execution isn't needed.
- `HeartbeatMonitor.executeHeartbeat()` uses the Paperclip wake→check→work→exit model. The lazy `import("./pi.js")` pattern keeps pi SDK out of the module graph when only monitoring (not execution) is needed.
- Agent tool factories (`createTaskCreateTool`, `createTaskLogTool`) live in `agent-tools.ts` and are shared between `TaskExecutor` and `HeartbeatMonitor` to avoid duplication.
- Dashboard SSE clients (planning/subtask/mission interview) now use a shared keep-alive pattern: start a 25s `setInterval` in stream `onOpen` that `POST`s `/api/ai-sessions/:id/ping`, and always stop it on stream `close`, `complete`, and fatal errors.
- **Peer Gossip Protocol (FN-1224)**: Nodes exchange peer information via `POST /api/mesh/sync` endpoint. `PeerExchangeService` runs periodic sync cycles (default 60s interval) with all online remote nodes. `CentralCore.mergePeers()` handles peer data merging — new peers are registered via `registerGossipPeer()`, stale peers are updated with fresher data, and the local node is never overwritten. The service uses single-flight pattern to prevent overlapping syncs and refreshes local metrics before each sync.
- **Node Plugin Sync (FN-1246)**: Nodes track version information for plugin synchronization. Central schema v4 adds `versionInfo` and `pluginVersions` columns to the `nodes` table. `getAppVersion()` utility reads from nearest package.json. CentralCore methods: `updateNodeVersionInfo()`, `getNodeVersionInfo()`, `syncPlugins()`, `checkVersionCompatibility()`. Events: `node:version:updated`, `node:plugins:synced`. Key integration points for FN-1247 (API routes, CLI commands).

## Conventions

- When mocking function types with Vitest for the build (tsc), use `vi.fn().mockResolvedValue(x) as unknown as T` instead of `vi.fn<Parameters<T>, ReturnType<T>>()`. The generic syntax works at runtime but fails during `tsc` build.
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

## Color Theme System

- There are **48 unique color themes** in `packages/dashboard/app/styles.css` (default, ocean, forest, sunset, zen, berry, high-contrast, industrial, monochrome, slate, ash, graphite, silver, solarized, factory, ayu, one-dark, nord, dracula, gruvbox, tokyo-night, catppuccin-mocha, github-dark, everforest, rose-pine, kanagawa, night-owl, palenight, monokai-pro, slime, brutalist, neon-city, parchment, terminal, glass, horizon, vitesse, outrun, snazzy, porple, espresso, mars, poimandres, ember, rust, copper, foundry, carbon). Each has a dark variant `[data-color-theme="<name>"]` and a light variant `[data-color-theme="<name>"][data-theme="light"]`.
- When adding CSS custom properties that should be theme-aware (like `--accent`, `--status-*-bg`), add them to all 48 theme blocks plus `:root` and `[data-theme="light"]` base blocks. The test in `status-colors-theme.test.ts` iterates all blocks programmatically to prevent regressions.

## Plugin System (FN-1111 / FN-1400)

The plugin system is built on three layers:
1. **PluginStore** (`packages/core/src/plugin-store.ts`) — SQLite-backed CRUD operations for plugin installations, stored in the `plugins` table (schema v24)
2. **PluginLoader** (`packages/core/src/plugin-loader.ts`) — Dynamic import, lifecycle management, dependency resolution (topological sort), hook invocation
3. **Plugin SDK** (`packages/plugin-sdk/`) — Type re-exports and `definePlugin()` helper for third-party plugins

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

## Pitfalls

- When adding props to a React component interface that were previously declared but not destructured in the function body, remember to add them to the destructuring list too. TypeScript won't warn about unused interface fields, so `onOpenScripts` in `MobileNavBarProps` compiled fine but caused `ReferenceError: onOpenScripts is not defined` at runtime.

- `vi.fn<Parameters<SomeType>, ReturnType<SomeType>>()` works in Vitest runtime but causes TypeScript build errors (`TS2558: Expected 0-1 type arguments, but got 2`). Always use the cast pattern instead.
- When adding new exports to `@fusion/engine`, update the mock in `packages/cli/src/commands/__tests__/dashboard.test.ts` AND `packages/cli/src/commands/__tests__/serve.test.ts` to include the new export, otherwise the test may fail with mysterious errors. Both test files need to be kept in sync.
- When adding new CLI command exports (like node.ts, mesh.ts), update BOTH `src/bin.test.ts` AND `src/__tests__/bin.test.ts` mocks to include the new exports, otherwise all tests importing from bin.ts will fail with "No 'X' export is defined" errors.
- Test `describe` blocks in Vitest can't access helper functions defined in sibling describe blocks. Place shared helpers in the parent scope or within the same describe block.
- When extracting shared code from `executor.ts` (e.g., tool factories), move the parameter schemas (`taskCreateParams`, `taskLogParams`) to the shared module too — keep them canonical in one place to avoid duplication.
- When changing API function signatures (e.g., `startAgentRun`), add new params at the END to preserve backward compatibility. Existing callers passing positional args will break if you insert a new param before existing ones.
- `HeartbeatMonitor.executeHeartbeat()` calls `startRun()` internally — do NOT call both `startRun()` and `executeHeartbeat()` for the same run, or you'll get duplicate runs. Use `startRun()` alone for record-only, or `executeHeartbeat()` for full execution.
- When RunsTab loads data via API calls instead of props, tests must mock the API functions (`fetchAgentRuns`, `fetchAgentRunDetail`) in addition to existing mocks, and set up defaults in `beforeEach`.
- In UI static analysis tests, avoid regex that spans multiple lines for code patterns (e.g., `setInterval.*5000`). Use separate `toContain()` assertions instead since the code is multi-line.
- In large inline mock objects, duplicate property keys are only warned by esbuild and the last declaration silently wins, which can hide the real mock implementation during route tests.
- For hardcoded workflow-step shortcuts in dashboard forms (like `"browser-verification"`), checked/toggle logic must reconcile both the literal template ID and resolved `WS-XXX` IDs by matching `workflowStep.templateId`.
- When using `import.meta.env` in `packages/dashboard/app/*`, ensure `packages/dashboard/tsconfig.app.json` includes `"vite/client"` in `compilerOptions.types`, or the dashboard typecheck test will fail with `Property 'env' does not exist on type 'ImportMeta'`.
- In dashboard app tests under `app/__tests__`, the built client output directory resolves to `../../dist/client` (not `../../../dist/client`).
- Fresh worktrees may miss linked Capacitor plugin packages until dependencies are installed; if dashboard tests/typecheck fail with unresolved `@capacitor/*` imports, run `pnpm install` at repo root first.
- When dashboard components add new `lucide-react` icons or new API functions, update the component test mocks (`vi.mock("lucide-react")` and `vi.mock("../../api")`) immediately; missing mock exports cause cascading runtime failures (`No "X" export is defined`) across otherwise unrelated tests.
- In fresh worktrees, workspace dependency links can be stale enough that dashboard/core tests fail resolving `yaml` from `@fusion/core`; run `pnpm install` at repo root before chasing false test failures.
- `pnpm test` at repo root runs dashboard's clean-checkout typecheck test; App-level TS issues (like duplicate imports or bad hook call signatures) may pass targeted Vitest runs but still fail the full suite.
- In executor worktrees, task attachment files referenced in PROMPT may exist only under the main repo path (`/Users/.../Projects/kb/.fusion/tasks/...`); if relative `.fusion/tasks/...` paths are missing, read the absolute attachment path directly.
- SQLite `ORDER BY timestamp DESC` alone can be nondeterministic when multiple rows share the same millisecond timestamp; add a stable tiebreaker (for example `rowid DESC`) when selecting a "latest" event.
- In `TaskCard.tsx`, `isInteractiveTarget` must check `target instanceof Element` (not `HTMLElement`) so SVG elements from lucide-react icons are correctly detected as interactive when inside buttons.
- If root `pnpm test` fails in `@gsxdsm/fusion` with `No matching export ... exportAgentsToDirectory` from `@fusion/core/dist/index.js`, run `pnpm --filter @fusion/core build` before rerunning tests so the core dist exports are refreshed for Bun compile tests.
- QuickEntryBox control test IDs are reused in `ListView` integration tests; when control layout changes (for example nested menu → inline buttons), update both `QuickEntryBox.test.tsx` and `ListView.test.tsx` together to avoid cascading failures.
- When `InlineCreateCard` layout changes, also check `Column.test.tsx` and `board-mobile.test.tsx` for references to moved/removed test IDs like `inline-create-description-actions`.
- `mission-store.test.ts` has a flaky test (`getMissionHealth computes mission metrics and latest error context`) that fails intermittently when timestamps collide in the same millisecond — this is pre-existing and not related to dashboard changes.

- When adding light-theme overrides for CSS components that already use `var(--*)` tokens, most selectors inherit correctly from the light-theme root variable redefinitions. Only add explicit `[data-theme="light"]` overrides where fine-tuning is needed (e.g., slightly different opacity values, subtle box-shadows for contrast).
- `--surface-hover` is used but never defined as a CSS custom property in the root or light theme blocks — it resolves to invalid/empty. Components using `var(--surface-hover)` (like `.github-import-tab:hover`) get no background. Either define it in the theme roots or use fallbacks like `var(--surface-hover, rgba(0,0,0,0.03))`.
- `.form-error` and similar error-state selectors should use `color-mix(in srgb, var(--color-error) 10%, transparent)` instead of hardcoded `rgba(248, 81, 73, 0.1)` for theme adaptability.
- When styling `input[type="radio"]` elements in `.imported` items, the selector must match `.issue-item.imported input[type="radio"]` (classes on the same element, not nested), because the HTML structure is `<div class="issue-item imported"><input type="radio">`.

## CSS Testing Patterns

- Several test files assert specific CSS values in `styles.css` mobile media query blocks (e.g., `board-mobile.test.tsx`, `core-modals-mobile.test.tsx`, `mission-planning-modals-mobile.test.ts`, `mobile-nav-bar-css.test.ts`). When changing mobile CSS values (like `min-height`), update both the CSS and the corresponding test assertions + regex patterns.
- Mobile-specific selectors like `.mobile-nav-tab` and `.mobile-more-item` may exist as base styles (not inside media queries) but are still mobile-only components. The `.touch-target` utility class at the top of `styles.css` is intentionally 44px and should not be changed when reducing mobile button sizes.
- When checking if a CSS value is inside a `@media` block, don't just search backwards for the nearest `@media` — track brace depth to confirm the line is actually between the block's opening `{` and closing `}`. Many component styles are defined globally (not in media queries) even though they visually only appear on mobile.
- Regex tests using `[\s\S]*` (greedy match across lines) to check CSS rules inside `@media` blocks are unreliable — they can match across block boundaries. Use non-greedy `[^}]*` scoped to a single rule block instead.
- Touch target sizing in `styles.css` mobile media queries uses 36px (reduced from the original 44px). The `.touch-target` opt-in utility class remains at 44px. Comments mentioning "44px" in the mobile sections have been updated to reflect the actual values.

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

- When adding database schema migrations, increment `SCHEMA_VERSION` and add migration blocks with `applyMigration(N, () => { ... })`. Also update hardcoded schema version assertions in `db.test.ts` and other test files (e.g., `task-documents.test.ts`) to expect the new version. Missing updates cause test failures like `expected 22 to be 21`.

## Agent Skills

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
