# Even Realities Glasses Plugin (Fusion)

`@fusion-plugin-examples/even-realities-glasses` is a standalone Fusion plugin that provides a task-centric card workflow for Even Realities glasses.

## Scope (v1)

- Quick capture text into new tasks
- Polling-based task transition notifications
- Selected task workflow actions from glasses

Out of scope in v1: missions, roadmaps, search, multi-project routing, cloud/remote deployment orchestration.

## Install (workspace local)

From repo root:

```bash
pnpm install
pnpm --filter @fusion-plugin-examples/even-realities-glasses build
pnpm --filter @fusion-plugin-examples/even-realities-glasses test
```

## Required settings

- `fusionApiBaseUrl` (default `http://localhost:4040`)
- `fusionApiToken` (required Bearer token)
- `apiKey` (required for plugin routes)
- `glassesDeviceId` (optional identifier)
- `companionWebhookUrl` (optional companion endpoint base URL for card push, e.g. `https://companion.example`)
- `pollingIntervalSeconds` (default 30, min 5)
- `notifyOnColumns` (default `["in-review"]`)
- `quickCaptureDefaultColumn` (default `triage`)
- `enableAgentActions` (default `true`)

## Quick capture

Use `POST /quick-capture` for one-gesture glasses capture (`POST /tasks` is still the general-purpose route).

Pipeline:
1. Strip leading wake phrase (`hey fusion`, `fusion`, `ok fusion`, `note`, `task`, `capture`)
2. Strip filler tokens (`um`, `uh`, `er`, `like`, `you know`) and transcript punctuation noise
3. Split first sentence into title + description (title capped at 80 chars; overflow moved into description)
4. Resolve column from request `column` or plugin setting `quickCaptureDefaultColumn` (fallback `triage`)

Example:

```bash
curl -X POST http://localhost:4040/api/plugins/fusion-plugin-even-realities-glasses/quick-capture \
  -H "Authorization: Bearer <apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"text":"hey fusion, file a bug about the merge gate"}'
```

## Agent actions

All action routes require `Authorization: Bearer <apiKey>` and `enableAgentActions=true`.

### Endpoints

| Method | Path |
| --- | --- |
| POST | `/actions/start-work` |
| POST | `/actions/request-review` |
| POST | `/actions/approve-plan` |
| POST | `/actions/accept-review` |
| POST | `/actions/return-to-agent` |
| POST | `/actions/retry` |

Request body:

```json
{ "taskId": "FN-123" }
```

Success response:

```json
{
  "task": { "id": "FN-123" },
  "card": { "kind": "task", "taskId": "FN-123" }
}
```

Error envelope:

```json
{ "error": "message" }
```

Status mapping:
- `401`: missing/wrong API key
- `403`: `enableAgentActions` disabled
- `400`: invalid input (for example empty `taskId`)
- `404`: task not found
- `409`: action not allowed for current column/status
- `500`: unexpected internal error

Preconditions and mutations:

| Action | Allowed preconditions | Mutation |
| --- | --- | --- |
| `start-work` | `column ∈ {triage, todo}` and `status` not in `{planning, needs-replan, awaiting-approval, awaiting-user-review}` | `moveTask(id, "in-progress")` |
| `request-review` | `column === "in-progress"` | `moveTask(id, "in-review")` |
| `approve-plan` | `column === "triage"` and `status === "awaiting-approval"` | `moveTask(id, "todo")` then `updateTask(id, { status: undefined })` |
| `accept-review` | `column === "in-review"` | `updateTask(id, { status: null, assigneeUserId: null })` |
| `return-to-agent` | `column === "in-review"` | `updateTask(id, { assigneeUserId: null, status: null, assignedAgentId: null })` then `moveTask(id, "todo")` |
| `retry` (in-review branch) | `column === "in-review"` and `status ∈ {failed, stuck-killed}` | `updateTask(id, { status: null, error: null, stuckKillCount: 0, mergeRetries: 0 })` |
| `retry` (triage/planning branch) | `column === "triage"` and (`status ∈ {failed, planning, needs-replan}` or `(stuckKillCount ?? 0) > 0`) | `updateTask(id, { status: "needs-replan", error: null, worktree: null, branch: null, baseBranch: null, baseCommitSha: null, stuckKillCount: 0, recoveryRetryCount: null, nextRecoveryAt: null })` |
| `retry` (general failed branch) | `status ∈ {failed, stuck-killed}` and not covered by branches above | `updateTask(id, { status: null, error: null, worktree: null, branch: null, baseBranch: null, baseCommitSha: null, stuckKillCount: 0, recoveryRetryCount: null, nextRecoveryAt: null })` then `moveTask(id, "todo")` |

Example:

```bash
curl -X POST http://localhost:4040/api/plugins/fusion-plugin-even-realities-glasses/actions/start-work \
  -H "Authorization: Bearer <apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"FN-123"}'
```

### Known limitations (v1)

- `startWork` does not allocate a worktree directly. Tasks can enter `in-progress` with `worktree: null`; executor `createWorktree` flow allocates on first dispatch.
- `approvePlan` performs move-then-clear; re-fetched responses may present `task.status == null`.
- `retry` triage/planning branch does not delete on-disk `PROMPT.md` and does not run dashboard retry step-reset / branch-inspection logic.

## Notifications

Notifications are produced by polling `taskStore.listTasks({ includeArchived: false })` on `pollingIntervalSeconds` and diffing against persisted snapshot rows in `even_realities_seen_tasks`.

Diff reasons:
- `new-task` (task first seen in a watched column)
- `entered-column` (task moved into a watched column)
- `left-column` (task moved out of a watched column)
- `completed` (supported by diff engine; currently disabled in notifier v1)

Snapshot rows survive plugin restarts, so previously-seen tasks are not re-notified after reload.

### Notification endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/notifications` | Read pending events (`limit`, optional `drain=true`) with rendered cards |
| POST | `/notifications/ack` | Ack events by `taskIds` |
| POST | `/notifications/poll-now` | Force immediate poll and return emitted events |

Example:

```bash
curl -X GET "http://localhost:4040/api/plugins/fusion-plugin-even-realities-glasses/notifications?limit=25" \
  -H "Authorization: Bearer <apiKey>"
```

## Security notes

- Uses `Authorization: Bearer <token>` for all API requests.
- Prefer local/self-hosted Fusion instances and avoid exposing dashboard APIs to public networks.
- Treat `fusionApiToken` as secret material and rotate regularly.

## Board/task card endpoints (merged canonical surface)

All companion-facing routes use `Authorization: Bearer <apiKey>` and are hosted under:

`/api/plugins/fusion-plugin-even-realities-glasses`

| Method | Path | Description |
| --- | --- | --- |
| GET | `/board/cards` | Card deck projection for selected columns (`columns`, `max`) |
| GET | `/board` | Board summary counts and status |
| GET | `/tasks/:id/cards` | Single-task card deck |

## Transport path (implemented)

Production transport uses `WebhookGlassesTransport`.

- `pushCard()` POSTs cards to `${companionWebhookUrl}/cards`
- `/status` reports `connected`, transport mode, webhook config presence, `lastPushAt`, `lastActionAt`, and `lastError`
- `POST /reconnect` forces disconnect/connect on the transport state machine
- `POST /transport/actions` ingests companion actions (`start-work`, `request-review`, `quick-capture`) into plugin action handlers

If `companionWebhookUrl` is unset, the plugin still serves authenticated routes and polling notifications, but card push remains degraded with `connected=false` and a status error until configured.
