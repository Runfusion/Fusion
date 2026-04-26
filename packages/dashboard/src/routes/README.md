# Dashboard API route registrars

`packages/dashboard/src/routes.ts` remains the single public entrypoint (`createApiRoutes(store, options)`), but route definitions are registered by domain modules in this directory.

## Shared context contract

All registrars receive `ApiRoutesContext` from `./types.ts`, built by `createApiRoutesContext()` in `./context.ts`.

Registrars should be typed as `ApiRouteRegistrar` so modules share one explicit registration contract.

The context centralizes cross-cutting dependencies so registrars preserve behavior without re-implementing plumbing.

Some registrars (for example `register-task-workflow-routes.ts`) also take a narrow dependency-injection object for non-context helpers that must stay source-of-truth in `routes.ts` (git helpers, background refresh helpers, multer upload middleware). This avoids helper duplication while preserving runtime parity.

The context provides core cross-cutting plumbing:

- Request/project scoping: `getProjectIdFromRequest`, `getScopedStore`, `getProjectContext`
  - These are also exported from `context.ts` as canonical helpers for future extraction tasks.
- Engine-aware fallback behavior for project-bound and root-store APIs
- Runtime loggers and diagnostics emitters (`runtimeLogger`, `planningLogger`, `chatLogger`)
- Proxy/auth/audit helpers (`emitRemoteRouteDiagnostic`, `emitAuthSyncAuditLog`)
- Automation/routine resolvers and scope parsing helpers
- Shared error normalization (`rethrowAsApiError`)

## Registrar module map

- `register-settings-memory-routes.ts` — settings APIs and memory backend/file/insight routes (excluding node-to-node sync endpoints)
- `register-project-routes.ts` — `/projects` CRUD + `/projects/across-nodes`, `/projects/detect`, health/config/pause/resume routes
- `register-node-routes.ts` — `/nodes` CRUD + operational endpoints (`/health-check`, `/metrics`, `/version`, `/sync-plugins`, `/compatibility`)
- `register-settings-sync-routes.ts` — node settings/auth sync routes (`/nodes/:id/settings*`, `/nodes/:id/auth/sync`)
- `register-mesh-routes.ts` — mesh topology routes (`/mesh/state`, `/mesh/sync`)
- `register-discovery-routes.ts` — discovery routes (`/discovery/status|start|stop|nodes|connect`) with `options?.centralCore` reuse
- `register-settings-sync-inbound-routes.ts` — inbound sync/auth endpoints (`/settings/sync-receive`, `/settings/auth-receive`, `/settings/auth-export`)
- `register-settings-sync-helpers.ts` — shared sync-domain helpers (`fetchFromRemoteNode`, `readStoredAuthProvidersFromDisk`)
- `register-task-workflow-routes.ts` — task/workflow domain (`/tasks*`, `/documents`, task comments/docs/checkout/spec/attachments, PR+issue status, task lifecycle/workflow endpoints)
- `register-planning-subtask-routes.ts` — planning sessions and subtask breakdown routes
- `register-chat-routes.ts` — chat session/list/mutation/stream routes
- `register-messaging-scripts.ts` — scripts API and mailbox/message routes
- `register-git-github.ts` — git/GitHub workflows and related helpers
  - Git plumbing routes: `/git/remotes*`, `/git/status`, `/git/commits*`, `/git/branches*`, `/git/worktrees`, `/git/fetch|pull|push`, `/git/stashes*`, `/git/diff*`, `/git/changes`, `/git/stage|unstage|commit|discard`
  - GitHub import/integration routes: `/github/issues/*`, `/github/pulls/*`, `/github/webhooks`, `/github/batch/status` (includes shared batch-import rate limiter state + reset export)
  - Task-scoped GitHub routes: `/tasks/:id/pr/*` and `/tasks/:id/issue/*` status/refresh/create flows
- `register-model-routes.ts` — `/models` endpoint, favorites projection, and `useClaudeCli` filtering for `pi-claude-cli` entries
- `register-auth-routes.ts` — auth/provider domain (`/auth/status`, `/auth/login`, `/auth/logout`, `/auth/api-key`, `/auth/claude-cli`, `/providers/claude-cli/status`)
- `register-usage-routes.ts` — `/usage` endpoint with `fetchAllProviderUsage(options?.authStorage)` integration
- `register-files-terminal-workspaces.ts` — infrastructure aggregator for file/workspace + session-diff + terminal routes
  - Calls `register-session-diff-routes.ts` first (session changed files + task diff endpoints)
  - Calls `register-file-workspace-routes.ts` second (task/workspace file browsing and file operations)
  - Calls `register-terminal-routes.ts` last (terminal command/session + PTY lifecycle endpoints)
- `register-file-workspace-routes.ts` — task/workspace file domain:
  - Task files: `/tasks/:id/files`, `/tasks/:id/files/{*filepath}` (read/write)
  - Workspace discovery/files: `/workspaces`, `/files`, `/files/markdown-list`, `/files/search`, `/files/{*filepath}`
  - File operations: `/files/{*filepath}/copy|move|delete|rename`, `/files/{*filepath}/download`, `/files/{*filepath}/download-zip`
  - Generic wildcard write: `/files/{*filepath}` (must remain after operation routes)
  - Project markdown search: `/project-files/md`
- `register-session-diff-routes.ts` — task session/diff domain:
  - Session changed-file list: `/tasks/:id/session-files`
  - Aggregate task diff: `/tasks/:id/diff`
  - Per-file diffs: `/tasks/:id/file-diffs`
  - Caches: module-level `sessionFilesCache` and `fileDiffsCache` (10-second TTL)
- `resolve-diff-base.ts` — shared git diff-base utilities:
  - `runGitCommand(args, cwd, timeoutMs)`
  - `resolveDiffBase(task, cwd)` + `ResolveDiffBaseTaskInput` type
- `register-terminal-routes.ts` — terminal execution and PTY endpoints:
  - Command execution + streaming: `/terminal/exec`, `/terminal/sessions/:id`, `/terminal/sessions/:id/stream`, `/terminal/sessions/:id/kill`
  - PTY lifecycle: `/terminal/sessions` (create/list) and `/terminal/sessions/:id` (delete)
- `register-agent-core-routes.ts` — core agent CRUD, lookups, stats/org-tree, hierarchy aliases (`/agents/:id/children|employees`)
- `register-agent-runtime-routes.ts` — agent runtime/control-plane, heartbeats/runs, access/permissions, soul/memory, revisions/budget/keys, task/inbox surfaces
- `register-agent-reflection-rating-routes.ts` — reflection/performance/context endpoints and ratings APIs
- `register-agent-import-export-generation-routes.ts` — agent import/export, companies catalog, and `/agents/generate/*` session/spec lifecycle
- `register-agent-skills-routes.ts` — skills discovery/content/execution/catalog endpoints coupled to agent capability flow
- `register-plugins-automation.ts` — plugin CRUD, automation, routines/webhooks
- `register-proxy-routes.ts` — remote-node proxy forwarding and SSE proxy routes
  - Injected dependencies: `{ store, runtimeLogger }`
  - Endpoint inventory (must remain in this order):
    1. `GET /proxy/:nodeId/health`
    2. `GET /proxy/:nodeId/projects`
    3. `GET /proxy/:nodeId/tasks`
    4. `GET /proxy/:nodeId/project-health`
    5. `GET /proxy/:nodeId/events` (SSE pass-through, 30s timeout, client-disconnect cleanup)
    6. `ALL /proxy/:nodeId/{*splat}` (generic wildcard forwarder)
  - Shared diagnostics: imports `emitRemoteRouteDiagnostic` and `classifyRemoteRouteError` from `routes/context.ts` so proxy and non-proxy registrars (for example mesh/sync routes) keep one diagnostic classification contract.

## createApiRoutes mount sequence (current)

`createApiRoutes()` mounts registrars in this precedence-sensitive order:

1. `registerSettingsMemoryRoutes(...)`
2. `registerTaskWorkflowRoutes(...)`
3. `registerPlanningSubtaskRoutes(...)`
4. `registerChatRoutes(...)`
5. `registerMessagingScriptRoutes(...)`
6. `registerGitGitHubRoutes(...)`
7. `registerFilesTerminalWorkspaceRoutes(...)`
8. `registerAgentsProjectsNodesRoutes(...)`
9. `registerPluginsAutomationRoutes(...)`
10. (later) `registerAgentSkillsRoutes(...)`
11. (last) `registerProxyRoutes(...)`

Compatibility re-exports that must remain on `routes.ts` for tests and existing importers:

- `resolveDiffBase` + `ResolveDiffBaseTaskInput` (from `resolve-diff-base.ts`)
- `__resetBatchImportRateLimiter` (from `register-git-github.ts`)
- `__setCreateFnAgentForRefine` (defined in `routes.ts`)

## Ordering rules (critical)

Express matches in registration order. Keep registrar and in-registrar route ordering stable:

1. **Specific operation routes before generic parameterized routes** (`/runs`, `/runs/:id`, `/copy`, `/delete` before `/:id` style handlers)
2. **Specific operation routes before wildcard paths** (`/files/{*filepath}/copy|move|delete|rename|download|download-zip` before `POST /files/{*filepath}`)
   - Why: Express route matching is first-win. If the wildcard write route is registered first, paths like `/files/somefolder/delete` will be treated as file writes instead of delete operations.
3. **Do not move proxy/script/message/file wildcards ahead of specific routes**
   - For proxy routes specifically, keep all explicit `GET /proxy/:nodeId/*` handlers ahead of `ALL /proxy/:nodeId/{*splat}` and keep proxy registration last in `createApiRoutes()`.
4. **Project/node/sync/discovery ordering constraints must stay intact**:
   - `/projects/across-nodes` and `/projects/detect` must be registered before `/projects/:id`
   - `/nodes/:id/settings` must be registered before `/nodes/:id/settings/push|pull|sync-status` and before `/nodes/:id/auth/sync`
   - `/mesh/state` must be registered before `/mesh/sync`
   - Discovery routes stay grouped after mesh routes
   - Inbound `/settings/sync-receive|auth-receive|auth-export` routes mount after discovery routes
5. **Auth/model/usage ordering constraints must stay intact**:
   - Keep `/models` registration before auth-dependent picker/settings flows that rely on consistent model filtering
   - Keep auth registrar routes grouped as currently mounted (status/diagnostic + mutation endpoints) so no wildcard handler can shadow `/providers/claude-cli/status`
   - Keep `/usage` mounted as a standalone registrar route (not under auth paths) with unchanged error mapping semantics
6. **Agent ordering constraints must stay intact**:
   - `/agents/stats`, `/agents/org-tree`, `/agents/resolve/:shortname` before `/agents/:id`
   - `/agents/:id/runs/stop` before `/agents/:id/runs/:runId`
   - `/agents/:id/reflections/latest` before `/agents/:id/reflections`

If adding a new endpoint, place it in the domain registrar and verify it does not shadow existing handlers.

## Integrated routers

Integrated routers are mounted through `register-integrated-routers.ts` and intentionally called from `routes.ts` at precedence-sensitive points:

- `registerIntegratedRouters(...)` mounts:
  - `createMissionRouter` → `/api/missions`
  - `createRoadmapRouter` → `/api/roadmaps`
  - `createInsightsRouter` → `/api/insights`
- `registerIntegratedDevServerRouter(...)` mounts:
  - `createDevServerRouter` → `/api/dev-server`

Keep these calls in their current positions inside `createApiRoutes()` unless an explicit route-ordering migration is planned and regression-tested.
