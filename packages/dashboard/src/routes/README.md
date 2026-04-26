# Dashboard API route registrars

`packages/dashboard/src/routes.ts` remains the single public entrypoint (`createApiRoutes(store, options)`), but route definitions are registered by domain modules in this directory.

## Shared context contract

All registrars receive `ApiRoutesContext` from `./types.ts`, built by `createApiRoutesContext()` in `./context.ts`.

Registrars should be typed as `ApiRouteRegistrar` so modules share one explicit registration contract.

The context centralizes cross-cutting dependencies so registrars preserve behavior without re-implementing plumbing.

Some registrars (for example `register-task-workflow-routes.ts`) also take a narrow dependency-injection object for non-context helpers that must stay source-of-truth in `routes.ts` (cache maps, git diff helpers, background refresh helpers, multer upload middleware). This avoids helper duplication while preserving runtime parity.

The context provides core cross-cutting plumbing:

- Request/project scoping: `getProjectIdFromRequest`, `getScopedStore`, `getProjectContext`
  - These are also exported from `context.ts` as canonical helpers for future extraction tasks.
- Engine-aware fallback behavior for project-bound and root-store APIs
- Runtime loggers and diagnostics emitters (`runtimeLogger`, `planningLogger`, `proxyLogger`, `chatLogger`)
- Proxy/auth/audit helpers (`proxyToRemoteNode`, `emitRemoteRouteDiagnostic`, `emitAuthSyncAuditLog`)
- Automation/routine resolvers and scope parsing helpers
- Shared error normalization (`rethrowAsApiError`)

## Registrar module map

- `register-settings-memory-routes.ts` — settings APIs and memory backend/file/insight routes
- `register-task-workflow-routes.ts` — task/workflow domain (`/tasks*`, `/documents`, task comments/docs/checkout/spec/attachments, PR+issue status, task file/diff endpoints)
- `register-planning-subtask-routes.ts` — planning sessions and subtask breakdown routes
- `register-chat-routes.ts` — chat session/list/mutation/stream routes
- `register-messaging-scripts.ts` — scripts API and mailbox/message routes
- `register-git-github.ts` — git/GitHub workflows and related helpers
- `register-files-terminal-workspaces.ts` — files, terminal, workspace file operations
- `register-agents-projects-nodes.ts` — agents, project metadata, node routes
- `register-plugins-automation.ts` — plugin CRUD, automation, routines/webhooks
- `register-proxy.ts` — remote-node proxy forwarding and SSE proxy routes

## Ordering rules (critical)

Express matches in registration order. Keep registrar and in-registrar route ordering stable:

1. **Specific operation routes before generic parameterized routes** (`/runs`, `/runs/:id`, `/copy`, `/delete` before `/:id` style handlers)
2. **Specific operation routes before wildcard paths** (`/files/{*filepath}/copy|move|delete` before catch-all file write routes)
3. **Do not move proxy/script/message/file wildcards ahead of specific routes**

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
