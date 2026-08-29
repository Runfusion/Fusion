# Even Realities Plugin API

Canonical plugin id: `fusion-plugin-even-realities-glasses`

All plugin routes are mounted under:

`/api/plugins/fusion-plugin-even-realities-glasses`

All companion-facing routes require:

`Authorization: Bearer <apiKey>`

## Endpoint Contract

### Board / Task Cards

- `GET /board/cards` → compact deck for selected columns (`columns`, `max`)
- `GET /board` → board summary counts and updated timestamp
- `GET /tasks/:id/cards` → single-task deck (`404` when missing)

### Quick Capture

- `POST /quick-capture`
- Body: `{ "text": string, "column"?: TaskColumn }`
- Creates a task using normalization + configured `quickCaptureDefaultColumn`

### Agent Actions

- `POST /actions/start-work`
- `POST /actions/request-review`
- `POST /actions/approve-plan`
- `POST /actions/accept-review`
- `POST /actions/return-to-agent`
- `POST /actions/retry`

Body: `{ "taskId": "FN-123" }`

### Notifications

- `GET /notifications` (`limit`, optional `drain=true`)
- `POST /notifications/ack` with `{ "taskIds": string[] }`
- `POST /notifications/poll-now`

### Transport Status / Control

- `GET /status` → `connected`, transport mode/config/error, last poll
- `POST /reconnect` → reconnect transport lifecycle
- `POST /transport/actions` → ingest companion actions (`start-work`, `request-review`, `quick-capture`)

## Transport Contract

Production transport is `WebhookGlassesTransport`:

- pushes cards to `${companionWebhookUrl}/cards`
- reports degraded status when webhook URL is missing/unreachable
- records `lastPushAt`, `lastActionAt`, and `lastError` for `/status`

## Test Coverage Map

- `src/__tests__/board-routes.test.ts` — auth + board/task card route contracts
- `src/__tests__/cards.test.ts` — card/deck projection budgets and formatting
- `src/__tests__/quick-capture-routes.test.ts` — quick capture auth/input/error behavior
- `src/__tests__/agent-action-routes.test.ts` + `agent-actions.test.ts` — action route contract and state transitions
- `src/__tests__/notification-routes.test.ts` + `notifier.test.ts` — polling queue, ack, forced poll behavior
- `src/__tests__/transport.test.ts` + `transport-routes.test.ts` — webhook push path, connection status, inbound action ingestion
- `src/__tests__/index.test.ts` — manifest/settings keys and plugin lifecycle initialization behavior
