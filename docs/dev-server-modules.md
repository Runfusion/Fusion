# Dev Server Module Audit (FN-2214)

[← Docs index](./README.md)

This document audits the two parallel dev-server module families under `packages/dashboard/src`, identifies production wiring vs disconnected modules, and proposes a concrete consolidation plan.

---

## 1) Overview

Fusion currently contains **two parallel module families** for dashboard dev-server functionality:

- **Legacy family (`dev-server-*`)** — the production path used by API routes and server shutdown.
- **Newer family (`devserver-*`)** — introduced in **FN-2183** as an alternative implementation, but not wired into production routes.

### Summary table (source files only)

| File | LOC | Status | Production importers |
|---|---:|---|---|
| `dev-server-detect.ts` | 190 | **Active** | `dev-server-routes.ts` |
| `dev-server-store.ts` | 234 | **Active** | `dev-server-routes.ts`, `dev-server-process.ts` |
| `dev-server-port-detect.ts` | 250 | **Active** | `dev-server-process.ts` |
| `dev-server-process.ts` | 355 | **Active** | `dev-server-routes.ts` |
| `dev-server-manager.ts` | 403 | **Orphaned from production** | _None_ (imported only by tests) |
| `dev-server-routes.ts` | 406 | **Active (entrypoint)** | `routes.ts`, `server.ts` |
| `devserver-types.ts` | 41 | **Disconnected** | _None_ (internal to `devserver-*` family only) |
| `devserver-detect.ts` | 165 | **Disconnected** | _None_ |
| `devserver-persistence.ts` | 100 | **Disconnected** | _None_ |
| `devserver-manager.ts` | 469 | **Disconnected** | _None_ |

---

## 2) Legacy `dev-server-*` Family — File-by-File Analysis

### 2.1 `dev-server-detect.ts`

**Responsibility**  
Detects candidate dev-server scripts from root/workspace `package.json` files and ranks them with confidence scoring.

**Exports**
- `DEV_SERVER_SCRIPT_NAMES` — priority-ordered script names: `dev`, `start`, `serve`, `web`, `frontend`, `preview`, `storybook`.
- `DEV_SCRIPT_NAMES` — deprecated alias to `DEV_SERVER_SCRIPT_NAMES`.
- `FRAMEWORK_INDICATORS` — dependency-name indicators used for framework confidence boosts.
- `DetectedScript` — candidate record shape.
- `DetectionResult` — result wrapper `{ candidates }`.
- `isCandidateScript(name)` — helper for script-name inclusion check.
- `detectDevServerScripts(projectRoot)` — main detection routine.

**Importers**
- **Production:** `dev-server-routes.ts`
- **Test-only:** `__tests__/dev-server-detect.test.ts`, `__tests__/dev-server-routes.test.ts`

**Key behavior**
- Reads root `package.json`, then scans `packages/*/package.json` and `apps/*/package.json` via `glob`.
- Computes confidence score (0–1) from:
  - script-name priority (`getScriptPriorityScore`),
  - dependency-based framework indicators,
  - `private` / missing `main` heuristics.
- Sorts by confidence desc, then `source`, then script name.

**Production wiring**
- Used by `GET /api/dev-server/detect` in `dev-server-routes.ts`.

---

### 2.2 `dev-server-store.ts`

**Responsibility**  
Persists and normalizes dev-server runtime state/config in `.fusion/dev-server.json`.

**Exports**
- `DevServerStatus` — `"starting" | "running" | "stopped" | "failed"`.
- `DevServerState` — process/session state shape.
- `DevServerConfig` — persisted user config shape.
- `DEV_SERVER_CONFIG_DEFAULTS` — config defaults.
- `DEV_SERVER_LOG_MAX_LINES` — ring-buffer cap (500).
- `DEV_SERVER_DEFAULT_STATE()` — state defaults.
- `DevServerStore` — class-based storage API.
- `loadDevServerStore(projectDir)` — singleton loader keyed by resolved project root.
- `resetDevServerStore()` — test reset helper.

**Importers**
- **Production/runtime chain:** `dev-server-routes.ts`, `dev-server-process.ts` (types)
- **Non-test but not production-wired:** `dev-server-manager.ts`
- **Test-only:** `__tests__/dev-server-store.test.ts`, `__tests__/dev-server-process.test.ts`, `__tests__/dev-server-manager.test.ts`, `__tests__/dev-server-manager-persistence.test.ts`, `__tests__/dev-server-routes.test.ts`

**Key behavior**
- File path is fixed to `join(resolve(projectDir), ".fusion", "dev-server.json")`.
- Persists object shape `{ state, config }`.
- Normalizes invalid/malformed values defensively (`normalizeState`, `normalizeConfig`).
- Maintains bounded `logHistory` ring buffer and writes on every state/config/log mutation.

**Production wiring**
- `dev-server-routes.ts` uses it for config endpoints and status persistence.
- `DevServerProcessManager` writes lifecycle/log/URL detection updates through the store.

---

### 2.3 `dev-server-port-detect.ts`

**Responsibility**  
Extracts localhost preview URLs/ports from process output and probes common fallback ports.

**Exports**
- `PortDetectionResult` — `{ url, port, source }`.
- `FALLBACK_PREVIEW_PORTS` — 10 common ports: `5173,3000,4173,6006,8080,4200,4400,8888,4321,4000`.
- `detectPortFromLogLine(line)` — single-line parser.
- `detectPortFromLogs(lines)` — reverse scan from newest log line.
- `probeFallbackPorts(host?, timeoutMs?)` — sequential TCP probe of fallback ports.

**Importers**
- **Production:** `dev-server-process.ts`
- **Test-only:** `__tests__/dev-server-port-detect.test.ts`

**Key behavior**
- Reserved dashboard port `4040` is hard-excluded.
- Strips ANSI color codes before parsing.
- Dedicated framework parsers for **Vite, Next.js, Storybook, Angular** (multiple regex patterns each), then generic URL and generic keyword+port fallbacks.
- `probeFallbackPorts` normalizes host input and probes in deterministic order.

**Production wiring**
- `DevServerProcessManager` calls `detectPortFromLogLine` on each output line and schedules `probeFallbackPorts` after startup delay when no URL is announced.

---

### 2.4 `dev-server-process.ts`

**Responsibility**  
Manages child-process lifecycle for a single dev server (start/stop/restart), log streaming, and URL detection.

**Exports**
- `DevServerEvent` — event union (`started`, `output`, `stopped`, `failed`, `url-detected`).
- `DevServerProcessManagerOptions` — timeout/probe tuning options.
- `DevServerProcessManager` — `EventEmitter`-based process manager class.

**Importers**
- **Production/runtime chain:** `dev-server-routes.ts`
- **Non-test but not production-wired:** `dev-server-manager.ts`
- **Test-only:** `__tests__/dev-server-process.test.ts`

**Key behavior**
- Uses `spawn(command, [], { shell: true, stdio: ["pipe","pipe","pipe"] })`.
- Persists process lifecycle into `DevServerStore` (`starting` → `running` → `stopped`/`failed`).
- Streams stdout/stderr line-by-line into store log ring buffer and emits `output` events.
- Detects preview URL from logs via `detectPortFromLogLine`; if absent, schedules delayed fallback probing.
- Stop behavior sends `SIGTERM`, then escalates to `SIGKILL` after timeout.

**Production wiring**
- Instantiated directly inside `dev-server-routes.ts` runtime map (`getRuntime`).

---

### 2.5 `dev-server-manager.ts`

**Responsibility**  
Higher-level wrapper around `DevServerProcessManager` adding snapshot/log abstractions, SSE event buffering, and subscriber fan-out.

**Exports**
- `FALLBACK_PORTS` — fallback port list (matches legacy probe list; excludes 4040).
- `DevServerPersistedLogEntry`
- `DevServerPersistedState`
- `DevServerStartOptions`
- `DevServerSnapshot`
- `DevServerUrlDetectedEvent`
- `DevServerManagerEvent`
- `DevServerManagerOptions`
- `DevServerManager` — wrapper class with `SessionEventBuffer` support.
- `loadDevServerManager(rootDir)` — singleton loader.
- `shutdownAllDevServerManagers()` — shutdown helper.
- `resetDevServerManager()` — test reset helper.

**Importers**
- **Production:** _None_
- **Test-only:** `__tests__/dev-server-manager.test.ts`, `__tests__/dev-server-manager-persistence.test.ts`

**Key behavior**
- Wraps `DevServerProcessManager` events into higher-level state/log events.
- Buffers events with `SessionEventBuffer` (`getBufferedEvents(sinceId)`) for replay-friendly SSE semantics.
- Maintains in-memory subscriber set for push delivery.
- `initialize()` performs stale PID reconciliation: if persisted `running/starting` PID is dead, marks state stopped and appends recovery log.

**Production wiring**
- **Not wired**: routes do not instantiate this class; they use `DevServerProcessManager` directly.

---

### 2.6 `dev-server-routes.ts`

**Responsibility**  
Express router exposing `/api/dev-server/*` endpoints for detection, config, lifecycle, preview URL override, and SSE log stream.

**Exports**
- `DevServerRouterOptions` — requires `projectRoot`.
- `createDevServerRouter(options)` — router factory.
- `stopAllDevServers()` — stop+cleanup hook used by server shutdown.
- `destroyAllDevServerManagers()` — test teardown helper (clears route runtime map + store singleton).
- `getActiveProcessManagers()` — test introspection helper.

**Importers**
- **Production:** `routes.ts`, `server.ts`
- **Test-only:** `__tests__/dev-server-routes.test.ts`, `__tests__/dev-server-config-routes.test.ts`

**Key behavior**
- Maintains per-project runtime map `{ store, manager }` where manager is **`DevServerProcessManager`**.
- Endpoints:
  - `GET /detect`
  - `GET /config`, `PUT /config`
  - `GET /status`
  - `POST /start`, `POST /stop`, `POST /restart`
  - `PUT /preview-url`
  - `GET /logs/stream` (SSE)
- SSE stream writes raw events/history/heartbeat directly; no `SessionEventBuffer` replay path.

**Production wiring**
- Mounted in `routes.ts` via `router.use("/dev-server", createDevServerRouter(...))`.
- Server shutdown in `server.ts` calls `stopAllDevServers()` on HTTP server `close`.

---

## 3) Newer `devserver-*` Family — File-by-File Analysis

### 3.1 `devserver-types.ts`

**Responsibility**  
Defines branded IDs and strongly typed multi-server session/config/log models.

**Exports**
- `DevServerId` — branded string type.
- `createDevServerId(id)` — branding helper.
- `DevServerStatus` — includes `"stopping"` in addition to stopped/starting/running/failed.
- `DevServerConfig`
- `DevServerRuntime`
- `DevServerLogEntry`
- `DevServerSession`
- `MAX_LOG_ENTRIES` (500)
- `DevServerSessionMap`

**Importers**
- **Production:** _None_ (only imported by disconnected family files)
- **Test-only:** `__tests__/devserver-types.test.ts`, `__tests__/devserver-detect.test.ts`, `__tests__/devserver-manager.test.ts`

**Key behavior**
- Provides cleaner type boundary than inline legacy store types.
- Adds explicit `stopping` transitional status.

**Connection status**
- **Zero production imports.**

---

### 3.2 `devserver-detect.ts`

**Responsibility**  
Alternative script detector that scans root/apps/packages package manifests and returns executable command entries.

**Exports**
- `DetectedCommand`
- `PRIORITY_SCRIPTS` — `dev,start,web,frontend,serve,storybook`
- `FRAMEWORK_PATTERNS` — regex map for command-string framework detection.
- `detectFramework(scriptCommand)`
- `detectDevServerCommands(projectRoot)`

**Importers**
- **Production:** _None_
- **Test-only:** `__tests__/devserver-detect.test.ts`

**Key behavior**
- Reads package JSON using `execAsync(node -e ...)` and then JSON parses stdout.
- Discovers workspace manifests by directory traversal of `apps/*` and `packages/*`.
- Dedupes by `cwd::scriptName` and sorts by priority script index, then directory depth, then cwd.

**Connection status**
- **Zero production imports.**

---

### 3.3 `devserver-persistence.ts`

**Responsibility**  
Alternative persistence layer for multi-config dev servers.

**Exports**
- `projectDevServerFile(projectDir)` — path resolver for `.fusion/devserver.json`.
- `loadDevServerConfigs(projectDir)`
- `saveDevServerConfigs(projectDir, configs)`
- `reconstructSessions(configs)`
- `type PersistenceData`

**Importers**
- **Production:** _None_
- **Test-only:** `__tests__/devserver-detect.test.ts`

**Key behavior**
- Persists `{ configs: DevServerConfig[] }` instead of `{ state, config }`.
- Parses optional `env` object safely, brands IDs via `createDevServerId`.
- Save operation is intentionally graceful no-op on write failure.

**Connection status**
- **Zero production imports.**

---

### 3.4 `devserver-manager.ts`

**Responsibility**  
Alternative multi-server runtime manager with typed events, inline URL detection, and inline port probing.

**Exports**
- `DevServerManagerEvents` — typed event map (`log`, `status`, `preview`, `exit`).
- `DevServerManager` — multi-session process manager.
- `getDevServerManager(projectRoot)` — singleton getter.
- `destroyDevServerManager(projectRoot)`
- `destroyAllDevServerManagers()`

**Importers**
- **Production:** _None_
- **Test-only:** `__tests__/devserver-manager.test.ts`

**Key behavior**
- Supports multiple concurrent server sessions keyed by `DevServerId`.
- Parses command strings with custom quote-aware `parseCommand()` split.
- Detects URLs from output via inline localhost regex and probes `COMMON_DEV_PORTS` (6 ports).
- Uses Windows-aware terminate/kill paths (`process.kill(pid)` on Windows; `SIGTERM`/`SIGKILL` elsewhere).
- Explicit `stopping` state and stop timeout escalation.

**Connection status**
- **Zero production imports.**

---

## 4) Overlapping Responsibilities

| Concern | Legacy file(s) | Newer file(s) | Overlap description |
|---|---|---|---|
| Script detection | `dev-server-detect.ts` | `devserver-detect.ts` | Both scan package manifests for likely dev scripts. |
| Config persistence | `dev-server-store.ts` | `devserver-persistence.ts` | Both persist dev-server configuration under `.fusion/` JSON files. |
| Process management | `dev-server-process.ts` + `dev-server-manager.ts` | `devserver-manager.ts` | Both families manage child processes, lifecycle transitions, logs, and URL detection/probing. |
| Port detection | `dev-server-port-detect.ts` | Inline in `devserver-manager.ts` | Both parse localhost URL/port from logs and probe fallback ports. |
| Type definitions | Inline in `dev-server-store.ts` | `devserver-types.ts` | Both define runtime/session/config/status concepts. |

### Specific differences

#### Script detection
- **Legacy** (`dev-server-detect.ts`)
  - 7 script names (`dev,start,serve,web,frontend,preview,storybook`).
  - Confidence scoring (priority boost + dependency-based framework indicators + `private`/`main` heuristic).
  - Uses `glob` workspace discovery.
- **Newer** (`devserver-detect.ts`)
  - 6 script names (`dev,start,web,frontend,serve,storybook`).
  - Framework detection from script-command regex only.
  - Sorts by `PRIORITY_SCRIPTS` index + directory depth.
  - Reads `package.json` via spawned `node -e` command (`execAsync`).

#### Persistence
- **Legacy** (`dev-server-store.ts`)
  - File: `.fusion/dev-server.json`
  - Shape: `{ state, config }`
  - Class API: `DevServerStore`
- **Newer** (`devserver-persistence.ts`)
  - File: `.fusion/devserver.json`
  - Shape: `{ configs: DevServerConfig[] }`
  - Function API: `loadDevServerConfigs` / `saveDevServerConfigs`

#### Process management
- **Legacy**
  - `DevServerProcessManager`: single server per instance; delegates detection to `dev-server-port-detect.ts`.
  - `DevServerManager`: adds buffering/subscribers/stale PID recovery, but is not route-wired.
  - Routes instantiate `DevServerProcessManager` directly.
- **Newer** (`devserver-manager.ts`)
  - Multi-server sessions, typed event contract, built-in parsing/probing, `stopping` status.
  - Includes Windows-specific stop/kill handling.

#### Port detection
- **Legacy** (`dev-server-port-detect.ts`)
  - Dedicated detection module.
  - Framework-specific parsers for Vite/Next/Storybook/Angular plus generic URL/keyword fallbacks.
  - Probes 10 fallback ports (`FALLBACK_PREVIEW_PORTS`).
- **Newer** (`devserver-manager.ts`)
  - Inline regex: `https?://(localhost|127\.0\.0\.1)(?::(\d+))?`
  - Probes 6 common ports (`COMMON_DEV_PORTS`).

---

## 5) Production Import Graph

```text
routes.ts ──→ dev-server-routes.ts ──→ dev-server-detect.ts
                                  ├──→ dev-server-store.ts
                                  └──→ dev-server-process.ts ──→ dev-server-port-detect.ts
                                                               └──→ dev-server-store.ts (type import)

server.ts ──→ dev-server-routes.ts (stopAllDevServers)

dev-server-manager.ts ──→ dev-server-process.ts
                       ├──→ dev-server-store.ts
                       └──→ sse-buffer.ts
  ⚠ Not imported by routes.ts; exercised only via dedicated tests

devserver-types.ts ──→ devserver-manager.ts, devserver-persistence.ts (internal only)
devserver-detect.ts ──→ (no production importers)
devserver-persistence.ts ──→ devserver-types.ts (internal only)
devserver-manager.ts ──→ devserver-types.ts (internal only)
  ⚠ Entire `devserver-*` family has ZERO production imports
```

Verified production wiring points:
- `packages/dashboard/src/routes.ts:54` imports `createDevServerRouter`; `routes.ts:17299` mounts `/dev-server`.
- `packages/dashboard/src/server.ts:45` imports `stopAllDevServers`; `server.ts:827` calls it during server close cleanup.

---

## 6) Test Coverage Summary

- **Legacy family tests:** 8 files, **1911 LOC total**
  - `dev-server-detect.test.ts` (187)
  - `dev-server-store.test.ts` (338)
  - `dev-server-port-detect.test.ts` (241)
  - `dev-server-process.test.ts` (239)
  - `dev-server-manager.test.ts` (173)
  - `dev-server-manager-persistence.test.ts` (131)
  - `dev-server-routes.test.ts` (493)
  - `dev-server-config-routes.test.ts` (109)
- **Newer family tests:** 3 files, **620 LOC total**
  - `devserver-types.test.ts` (125)
  - `devserver-detect.test.ts` (140)
  - `devserver-manager.test.ts` (355)

Notes on legacy manager coverage:
- `dev-server-manager.ts` is directly tested by:
  - `dev-server-manager.test.ts`
  - `dev-server-manager-persistence.test.ts`
- Route-level behavior (including SSE and config persistence) is tested in:
  - `dev-server-routes.test.ts`
  - `dev-server-config-routes.test.ts`

---

## 7) Consolidation Plan

| File | Recommendation | Rationale |
|---|---|---|
| `dev-server-routes.ts` | **Keep** | Sole production entry point and API contract owner. |
| `dev-server-detect.ts` | **Keep** | Already route-integrated; richer scoring and dependency-based framework heuristics. |
| `dev-server-store.ts` | **Keep** | Existing persisted contract (`.fusion/dev-server.json`) and route/process integration. |
| `dev-server-port-detect.ts` | **Keep** | Dedicated parsing/probing module with broader detection behavior and explicit 4040 exclusion. |
| `dev-server-process.ts` | **Keep** | Core runtime manager used directly by routes. |
| `dev-server-manager.ts` | **Remove or integrate** | Not production-wired; useful capabilities (buffering + stale PID recovery) should be migrated before deletion if needed. |
| `devserver-types.ts` | **Adopt ideas (possibly as `dev-server-types.ts`)** | Branded IDs and explicit `stopping` status are cleaner than ad-hoc inline type evolution. |
| `devserver-detect.ts` | **Remove** | Duplicates detection concern with narrower heuristics and no production wiring. |
| `devserver-persistence.ts` | **Remove** | Competing persistence path (`devserver.json`) conflicts with current persisted contract. |
| `devserver-manager.ts` | **Cherry-pick patterns, then remove** | Multi-server/session abstractions and typed events are valuable, but module is disconnected from runtime. |

---

## 8) Risks & Invariants

### Risks to address during consolidation

- **Persistence path divergence:**
  - Legacy: `.fusion/dev-server.json`
  - Newer: `.fusion/devserver.json`
  - Consolidation must not silently flip active persistence format.
- **SSE buffering mismatch:**
  - `dev-server-manager.ts` has `SessionEventBuffer` replay support.
  - `dev-server-routes.ts` SSE stream is direct writes + heartbeat only.
  - If manager wrapper is removed, either preserve buffering elsewhere or explicitly accept behavior change.
- **Stale PID recovery gap:**
  - Present in `DevServerManager.initialize()` (legacy manager wrapper).
  - Not present in route path that uses `DevServerProcessManager` directly.
- **Test cleanup coupling:**
  - Removing disconnected `devserver-*` files requires removing their 3 dedicated tests.
  - `dev-server-manager.ts` behavior is covered directly by `dev-server-manager.test.ts` and `dev-server-manager-persistence.test.ts`, and related route/SSE behavior is covered in `dev-server-routes.test.ts` / `dev-server-config-routes.test.ts`.
  - Any removal/integration of `dev-server-manager.ts` requires replacing equivalent buffering/recovery coverage in whichever layer keeps that behavior.

### Invariants that must be preserved

- `/api/dev-server/*` routes and response shapes remain stable.
- `.fusion/dev-server.json` format remains backward-compatible.
- Port **4040** is never used as fallback preview suggestion.
- `stopAllDevServers()` remains callable from `server.ts` shutdown lifecycle.

---

## 9) Implementation Checklist for Follow-up Task

### Removal / consolidation actions

- [ ] Remove `devserver-types.ts`, `devserver-detect.ts`, `devserver-persistence.ts`, `devserver-manager.ts`
- [ ] Remove `devserver-types.test.ts`, `devserver-detect.test.ts`, `devserver-manager.test.ts`
- [ ] Decide fate of `dev-server-manager.ts` (remove, integrate SSE buffering into routes, or wire into routes)
- [ ] Remove/replace associated manager tests if `dev-server-manager.ts` is removed
- [ ] If adopting branded types, introduce `dev-server-types.ts` and migrate legacy inline type usage
- [ ] Run full test suite and verify no regressions
- [ ] Verify no imports remain to removed files

### Validation checks

- [ ] Documented ownership for all 10 source files remains accurate after refactor
- [ ] Production import graph matches actual import statements
- [ ] Route API contract and persisted storage invariants are unchanged
- [ ] No references to deleted `devserver-*` modules remain in source or tests
