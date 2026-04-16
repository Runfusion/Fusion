# Interface Packages Audit — FN-1963

## Summary
Comprehensive read-only audit completed across `packages/cli`, `packages/tui`, `packages/desktop`, `packages/mobile`, and `packages/plugin-sdk`.

**Total findings: 22**
- **Critical:** 1
- **High:** 3
- **Medium:** 15
- **Low:** 3

The most severe issue is a **desktop API contract split** between preload and renderer codepaths that can disable native desktop integrations (window controls, IPC API transport, deep-link/update hooks). Secondary concerns cluster around lifecycle cleanup (`process.exit` in command helpers, non-disposed stores/listeners) and brittle API boundaries (direct source imports in plugin-sdk, string-based duplicate detection in extension imports).

## Critical Findings

### IF-001 — Desktop preload/renderer API contract drift breaks native bridge
- **Severity:** critical
- **Location:**
  - `packages/desktop/src/preload.ts:6-43`
  - `packages/desktop/src/renderer/hooks/useElectron.ts:15-19`
  - `packages/desktop/src/renderer/components/TitleBar.tsx:18-23`
  - `packages/desktop/src/renderer/api-electron.ts:141`
  - `packages/desktop/src/ipc.ts:5-59` (no `api-request` handler)
- **Description:** Preload exposes `window.fusionAPI`, but renderer stack checks `window.electronAPI` and expects methods/channels (`windowControl`, `getPlatform`, `invoke("api-request")`, `installUpdate`) that are not exposed/handled.
- **Impact:** Desktop-only functionality silently degrades or no-ops (custom title bar controls, Electron transport path, update/deep-link hooks), causing inconsistent behavior between web vs desktop shell.
- **Suggested fix:** Define one canonical bridge contract and align all layers (preload typings, renderer hooks/components, IPC handler channels). Add integration tests that boot preload+renderer together and assert bridge method parity.

## High Findings

### IF-002 — Daemon token printed in cleartext at startup
- **Severity:** high
- **Location:** `packages/cli/src/commands/daemon.ts:456-463` (despite `maskToken` at `daemon.ts:108-115`)
- **Description:** Startup banner logs full daemon bearer token.
- **Impact:** Token exposure in terminal recordings/log aggregation/shell history can allow unauthorized API access.
- **Suggested fix:** Mask token by default (show prefix/suffix only), add `--show-token` explicit override if full token display is truly needed.

### IF-003 — TaskStore lifecycle leaks in settings/backup command paths
- **Severity:** high
- **Location:**
  - `packages/cli/src/commands/settings-import.ts:28-119`
  - `packages/cli/src/commands/settings-export.ts:22-70`
  - `packages/cli/src/commands/backup.ts:27-54`
- **Description:** Commands construct `TaskStore` instances but never close them, and several branches terminate via `process.exit(...)`.
- **Impact:** In embedded/in-process usage (tests, extension-hosted command reuse), DB handles can leak and produce lock contention.
- **Suggested fix:** Wrap store usage in `try/finally` with `await store.close()`, and return structured results/errors to top-level runner instead of direct exits in helpers.

### IF-004 — Auto-updater listeners can be registered repeatedly
- **Severity:** high
- **Location:**
  - `packages/desktop/src/main.ts:97` (setup at boot)
  - `packages/desktop/src/ipc.ts:35-38` (setup again on each check)
  - `packages/desktop/src/native.ts:132-156`
- **Description:** `setupAutoUpdater()` registers event handlers each call with no idempotency guard/removal.
- **Impact:** Duplicate notifications/events and potential listener leak warnings over long sessions.
- **Suggested fix:** Add one-time registration guard (module-level boolean or `autoUpdater.listenerCount(...)` check) and separate "trigger check" from "register listeners".

## Medium Findings

### IF-005 — `--port` parsing accepts missing/invalid values as `NaN`
- **Severity:** medium
- **Location:** `packages/cli/src/bin.ts:317-346`
- **Description:** `parseInt(args[pi + 1], 10)` is used without validating value presence/type.
- **Impact:** `fn dashboard --port` (no value) or invalid values can cascade into non-user-friendly runtime errors.
- **Suggested fix:** Use shared validated parser (`getFlagValueNumber`) and emit explicit usage errors when value missing/invalid.

### IF-006 — Async disposal callbacks in dashboard are not awaited
- **Severity:** medium
- **Location:** `packages/cli/src/commands/dashboard.ts:468-479` (with async callbacks added at `dashboard.ts:571-574`)
- **Description:** `disposeCallbacks` are typed/consumed as sync; async teardown work is fire-and-forget.
- **Impact:** Shutdown order becomes nondeterministic, and cleanup races can occur under signal handling.
- **Suggested fix:** Make `dispose` async and await each callback, or enforce sync-only callbacks.

### IF-007 — `runServe` repeatedly registers process listeners
- **Severity:** medium
- **Location:** `packages/cli/src/commands/serve.ts:146-188`
- **Description:** Diagnostics setup adds `beforeExit`/`exit`/`uncaughtExceptionMonitor`/`unhandledRejection` listeners each invocation without a registration guard.
- **Impact:** Duplicate logs and listener growth in programmatic multi-run scenarios.
- **Suggested fix:** Mirror dashboard’s `processDiagnosticsRegistered` guard pattern and unregister where appropriate.

### IF-008 — Extension store cache is cleared without disposing stores
- **Severity:** medium
- **Location:**
  - `packages/cli/src/extension.ts:40-49`
  - `packages/cli/src/extension.ts:1909-1916`
- **Description:** `storeCache.clear()` drops references but never closes cached `TaskStore` instances.
- **Impact:** Potential open DB handles across session lifecycles and stale connections after project switches.
- **Suggested fix:** Iterate cache values on shutdown and call `close()` before clearing.

### IF-009 — `fn_task_plan` monkey-patches global console and ignores `ctx.cwd`
- **Severity:** medium
- **Location:** `packages/cli/src/extension.ts:1000-1029`
- **Description:** Tool temporarily overrides global `console.log/error`; also calls `runTaskPlan(..., true)` without passing project context/cwd.
- **Impact:** Concurrent tool calls can interleave logs/race restore; planning may target wrong project when host cwd differs.
- **Suggested fix:** Avoid global console patching (return structured output from planner API) and thread explicit project/cwd into planner path.

### IF-010 — GitHub import duplicate detection is substring-based
- **Severity:** medium
- **Location:**
  - `packages/cli/src/extension.ts:771`
  - `packages/cli/src/extension.ts:848`
- **Description:** Existing import checks use `task.description.includes(sourceUrl)`.
- **Impact:** False positives/negatives with partial URL matches or edited descriptions can skip valid imports or duplicate tasks.
- **Suggested fix:** Parse canonical `Source:` metadata or persist source URL in a structured task field.

### IF-011 — `fn_skills_install` child process has no timeout/cancellation strategy
- **Severity:** medium
- **Location:** `packages/cli/src/extension.ts:1761-1784`
- **Description:** `spawn("npx", ...)` waits indefinitely for exit; no timeout or signal handling.
- **Impact:** Hung `npx` can stall tool execution indefinitely.
- **Suggested fix:** Add timeout with forced termination and user-facing timeout error.

### IF-012 — `/fn` command state is module-level and session-shared
- **Severity:** medium
- **Location:** `packages/cli/src/extension.ts:1820-1904`
- **Description:** `dashboardProcess`/`dashboardPort` are shared state for command handler instance.
- **Impact:** Multiple sessions in same runtime can interfere (status/start/stop collisions).
- **Suggested fix:** Scope process state per session/context or maintain keyed process registry.

### IF-013 — TUI terminal sizing clamps to minimum, masking real narrow widths
- **Severity:** medium
- **Location:** `packages/tui/src/utils/terminal.ts:65-69`
- **Description:** Width/height are forced to min (80x24), then used as effective dimensions.
- **Impact:** Very narrow terminals can render as if wider than reality, leading to overflow/wrapping artifacts.
- **Suggested fix:** Expose both actual and clamped dimensions; render logic should respect actual bounds and optionally warn/fallback when below minimum.

### IF-014 — TUI truncation is not display-width aware (Unicode/emoji)
- **Severity:** medium
- **Location:** `packages/tui/src/utils/truncate.ts:37-55`
- **Description:** Uses `string.length`/`slice` for terminal width.
- **Impact:** Wide characters and grapheme clusters misalign table columns and produce visual corruption.
- **Suggested fix:** Use wcwidth/grapheme-aware measurement/truncation utilities.

### IF-015 — Number-key routing is duplicated and not focus-guarded in router
- **Severity:** medium
- **Location:**
  - `packages/tui/src/components/screen-router.tsx:114-123`
  - `packages/tui/src/hooks/use-global-shortcuts.tsx:141-146`
  - `packages/tui/src/index.tsx:65-67,82-85`
- **Description:** Screen switching is handled in both router and global shortcuts; router path ignores focus guard.
- **Impact:** Double state updates and accidental screen changes while typing in focused inputs.
- **Suggested fix:** Centralize screen-switch handling and enforce focus guard in a single input handler path.

### IF-016 — `useActivityLog` live conversion loses type fidelity and cancellation is ineffective
- **Severity:** medium
- **Location:** `packages/tui/src/hooks/use-activity-log.ts:76-86,98-110`
- **Description:** Live `agent:log` events are coerced to `type: "task:updated"`; async fetch still mutates state after effect cancellation.
- **Impact:** Type filtering becomes misleading for live updates; potential set-state-after-unmount warnings.
- **Suggested fix:** Preserve/log original event kind (or explicit mapping), and gate state updates by cancellation/version guard.

### IF-017 — Mobile `initializePlugins` lacks rollback on partial init failure
- **Severity:** medium
- **Location:** `packages/mobile/src/index.ts:61-104`
- **Description:** Managers initialize sequentially; if later init fails, earlier managers remain active.
- **Impact:** Partial startup can leave intervals/listeners running without returned references/cleanup coordination.
- **Suggested fix:** Add transactional init with rollback (`destroy`) for already-started managers on failure.

### IF-018 — Push manager `start()` is not idempotent
- **Severity:** medium
- **Location:** `packages/mobile/src/plugins/push-notifications.ts:82-86` + listener accumulation at `89-98`
- **Description:** Repeated `start()` calls re-register listeners without guard.
- **Impact:** Duplicate notification events and multiplied side effects.
- **Suggested fix:** Track started state and short-circuit or teardown before re-init.

### IF-019 — Deep-link PWA fallback misses initial hash and leaves encoded IDs in custom-scheme path parsing
- **Severity:** medium
- **Location:**
  - `packages/mobile/src/plugins/deep-links.ts:91-118`
  - `packages/mobile/src/plugins/deep-links.ts:184-192`
- **Description:** Handler listens to `hashchange` only (no initial hash consume); custom scheme segments are assigned without decoding.
- **Impact:** First-load deeplink can be dropped; encoded task/project IDs can propagate incorrectly.
- **Suggested fix:** Invoke bound hash handler once during initialize and decode path segments when constructing payload.

### IF-020 — Plugin SDK imports core source via relative paths (bypasses package boundary)
- **Severity:** medium
- **Location:**
  - `packages/plugin-sdk/src/index.ts:57-61`
  - `packages/plugin-sdk/src/index.test.ts:3-5`
- **Description:** SDK depends on `../../core/src/...` internals rather than stable package entrypoints.
- **Impact:** Core refactors can break SDK consumers; publish-time portability is brittle.
- **Suggested fix:** Re-export/import from public package exports (`@fusion/core`) and keep SDK isolated from internal source layout.

### IF-021 — Plugin SDK omits key plugin-store/loader public types
- **Severity:** medium
- **Location:**
  - Missing from `packages/plugin-sdk/src/index.ts`
  - Present in core at `packages/core/src/plugin-store.ts:18-36`, `packages/core/src/plugin-loader.ts:31-40`
- **Description:** `PluginStoreEvents`, `PluginRegistrationInput`, `PluginUpdateInput`, `PluginLoaderOptions` are not exposed by SDK.
- **Impact:** Plugin/tooling authors must import from core internals, reinforcing boundary violations.
- **Suggested fix:** Re-export these types in SDK index and add export-surface tests.

## Low Findings

### IF-022 — `definePlugin` helper loses specific subtype inference
- **Severity:** low
- **Location:** `packages/plugin-sdk/src/index.ts:99-100`
- **Description:** Signature is `FusionPlugin -> FusionPlugin` instead of generic identity `<T extends FusionPlugin>(plugin: T) => T`.
- **Impact:** Reduced literal-type preservation and weaker IntelliSense in advanced plugin authoring scenarios.
- **Suggested fix:** Make helper generic and add TS assertion tests for inferred literal preservation.

### IF-023 — macOS activate path doesn’t restore existing hidden window
- **Severity:** low
- **Location:** `packages/desktop/src/main.ts:124-129` with hide-on-close at `main.ts:63-72`
- **Description:** `activate` only handles `mainWindow === null`; hidden-but-existing window is not shown.
- **Impact:** Dock re-activation can appear unresponsive after hide-to-tray behavior.
- **Suggested fix:** On activate, show/focus existing hidden window when present.

### IF-024 — Utility duplication across CLI commands increases drift risk
- **Severity:** low
- **Location:**
  - `packages/cli/src/commands/dashboard.ts:27-47`
  - `packages/cli/src/commands/serve.ts:51-71`
  - `packages/cli/src/commands/daemon.ts:49-69`
- **Description:** `formatBytes`/`formatUptime` are copy-pasted across modules.
- **Impact:** Behavior drift and repeated maintenance effort.
- **Suggested fix:** Move shared formatters to a common utility module in CLI package.

## Package-by-Package Details

### CLI (`packages/cli`)
- IF-002, IF-003, IF-005, IF-006, IF-007, IF-024
- Additional consistency note: helper-level `process.exit(...)` usage is pervasive across command modules (`task.ts`, `mission.ts`, `project.ts`, `node.ts`, `settings-import.ts`, `settings-export.ts`, `backup.ts`), making command functions hard to reuse safely outside direct CLI execution.

### Pi Extension (`packages/cli/src/extension.ts`)
- IF-008, IF-009, IF-010, IF-011, IF-012

### TUI (`packages/tui`)
- IF-013, IF-014, IF-015, IF-016

### Desktop (`packages/desktop`)
- IF-001, IF-004, IF-023

### Mobile (`packages/mobile`)
- IF-017, IF-018, IF-019

### Plugin SDK (`packages/plugin-sdk`)
- IF-020, IF-021, IF-022

### Cross-Cutting
- **Import consistency:** IF-001 and IF-020 show boundary drift (desktop bridge naming divergence, plugin-sdk source-relative imports).
- **Shared type alignment:** desktop has parallel incompatible API types (`fusionAPI` vs `electronAPI` contracts), and plugin-sdk misses public core plugin lifecycle/store types (IF-001, IF-021).
- **Error handling patterns:** CLI/extension mix thrown errors, `process.exit`, and `{ isError: true }` result contracts, creating inconsistent caller behavior.
- **Resource cleanup:** recurring lifecycle issues across CLI commands, extension cache disposal, desktop updater listeners, and mobile manager startup rollback/idempotency.
- **Test coverage gaps:** plugin-sdk tests focus on runtime identity but do not assert SDK export completeness or boundary integrity (IF-021/IF-022). A single skipped CLI bundle asset test exists at `packages/cli/src/__tests__/bundle-output.test.ts:49`.
