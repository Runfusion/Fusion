# Task: KB-137 - Replace GitHub badge polling with GitHub App webhook ingestion

**Created:** 2026-03-30
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This task replaces the server-side change-detection path for GitHub badges, adds a signed external webhook ingress, and touches the dashboard server, GitHub integration layer, tests, and operator docs. The work is still localized to badge updates, but mistakes would silently break realtime badge delivery or weaken webhook verification.
**Score:** 7/8 — Blast radius: 2, Pattern novelty: 2, Security: 2, Reversibility: 1

## Mission

Replace the current subscription-driven `GitHubPollingService` badge refresh loop with verified GitHub App webhook ingestion so PR and issue badge updates become truly push-based. The existing `/api/ws` badge WebSocket, `WebSocketManager`, `useBadgeWebSocket()`, and `TaskCard` freshness merge behavior should stay intact from the browser’s perspective; what changes is the upstream source of truth on the server. A signed `POST /api/github/webhooks` endpoint should accept relevant GitHub App deliveries, fetch canonical badge snapshots with an installation token, update matching tasks via `store.updatePrInfo()` / `store.updateIssueInfo()`, and let the existing `task:updated` → websocket bridge push the refreshed snapshot to subscribed clients. Keep the existing 5-minute REST refresh endpoints as a fallback path when webhook delivery is unavailable.

## Dependencies

- **Task:** KB-063 (badge WebSocket baseline must already exist)
  - KB-063 delivered `setupBadgeWebSocket()` in `packages/dashboard/src/server.ts`, `packages/dashboard/src/websocket.ts`, `packages/dashboard/app/hooks/useBadgeWebSocket.ts`, the `TaskCard.tsx` freshness merge pattern, and the current `packages/dashboard/src/github-poll.ts` live-update path that this task is replacing.
  - If KB-135 or KB-136 have already landed before implementation starts, preserve their `/api/ws` auth/pubsub hooks while replacing only the GitHub change-detection mechanism.

## Context to Read First

- `package.json` — authoritative workspace commands: `pnpm test`, `pnpm build`
- `AGENTS.md` — current badge WebSocket architecture notes that still reference the focused GitHub poller
- `packages/dashboard/src/server.ts` — current `/api/ws` setup, `setupBadgeWebSocket()`, and poller wiring
- `packages/dashboard/src/routes.ts` — current PR/issue status endpoints and background refresh helpers
- `packages/dashboard/src/github.ts` — `GitHubClient`, current REST/GraphQL normalization, and badge status helpers
- `packages/dashboard/src/github-poll.ts` — the current live polling implementation being removed or reduced
- `packages/dashboard/src/websocket.ts` — current badge websocket protocol and subscription manager
- `packages/dashboard/app/hooks/useBadgeWebSocket.ts` — current shared browser socket behavior that should remain API-compatible
- `packages/dashboard/app/components/TaskCard.tsx` — current freshness comparison between websocket badge snapshots and task/SSE state
- `packages/dashboard/src/__tests__/websocket.test.ts` — existing websocket integration coverage that currently assumes poller lifecycle
- `packages/dashboard/src/__tests__/github-poll.test.ts` — existing poller tests that must be deleted or rewritten so stale polling assertions do not remain
- `packages/dashboard/src/routes.test.ts` — established route-test patterns and current PR/issue refresh expectations
- `packages/dashboard/src/github.test.ts` — existing GitHub client tests and mocking patterns
- `packages/dashboard/README.md` — current API + architecture docs for `/api/ws`
- `packages/cli/STANDALONE.md` — operator docs for running `kb dashboard` outside the monorepo
- `README.md` — root docs that mention real-time PR status and GitHub configuration

## File Scope

- `packages/dashboard/src/server.ts`
- `packages/dashboard/src/routes.ts`
- `packages/dashboard/src/github.ts`
- `packages/dashboard/src/github-webhooks.ts`
- `packages/dashboard/src/github-poll.ts`
- `packages/dashboard/src/rate-limit.ts`
- `packages/dashboard/src/__tests__/github-webhooks.test.ts`
- `packages/dashboard/src/__tests__/server-webhook.test.ts`
- `packages/dashboard/src/__tests__/websocket.test.ts`
- `packages/dashboard/src/__tests__/github-poll.test.ts`
- `packages/dashboard/src/routes.test.ts`
- `packages/dashboard/src/github.test.ts`
- `packages/dashboard/app/hooks/useBadgeWebSocket.ts`
- `packages/dashboard/README.md`
- `packages/cli/STANDALONE.md`
- `AGENTS.md`
- `README.md`
- `.changeset/github-app-badge-webhooks.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied
- [ ] Confirm the checked-out tree still contains the KB-063 badge websocket baseline (`/api/ws`, `WebSocketManager`, `useBadgeWebSocket()`, `TaskCard` freshness merge, and `github-poll.ts`) before replacing only the live polling portion
- [ ] Confirm whether KB-135 and/or KB-136 have already landed; if so, preserve their websocket auth/pubsub behavior instead of reintroducing a polling-only or single-instance special case

### Step 1: Add verified GitHub App webhook and installation-auth helpers

- [ ] Create `packages/dashboard/src/github-webhooks.ts` with badge-webhook-specific helpers for reading GitHub App config, validating `X-Hub-Signature-256` against the raw request body using `KB_GITHUB_WEBHOOK_SECRET`, classifying supported events (`ping`, `pull_request`, `issues`, and `issue_comment` on PRs), and extracting the repo/number/installation data needed for canonical refreshes
- [ ] Extend `packages/dashboard/src/github.ts` so existing badge normalization can be reused with GitHub App installation tokens minted from `KB_GITHUB_APP_ID` plus either `KB_GITHUB_APP_PRIVATE_KEY` or `KB_GITHUB_APP_PRIVATE_KEY_PATH`; webhook-triggered canonical badge fetches must use an API-only/app-authenticated path and must **never** fall back to the operator’s `gh` session
- [ ] Extract a shared badge-URL parsing helper from the existing server-only logic so `routes.ts`, `server.ts`, and the new webhook handler all resolve `owner`, `repo`, `number`, and `resourceType` (`pr` vs `issue`) from stored badge URLs the same way instead of duplicating repo parsing
- [ ] Match tasks by parsing `task.prInfo.url` / `task.issueInfo.url` into exact `owner/repo/number` triples so imported issues and PRs from repositories other than the dashboard’s local git remote still update correctly; update **all** matching tasks for the same PR/issue and make repeated deliveries idempotent by persisting a newer `lastCheckedAt` for fallback freshness while avoiding websocket broadcasts when badge-relevant fields are otherwise unchanged
- [ ] Add automated tests in `packages/dashboard/src/__tests__/github-webhooks.test.ts` and `packages/dashboard/src/github.test.ts` covering signature verification, config validation, installation-token request formation, the API-only webhook auth mode, supported/ignored event classification, shared badge-URL parsing, multi-task resource matching, and duplicate/no-op delivery behavior
- [ ] Run targeted tests for changed files: `pnpm --filter @kb/dashboard test -- src/__tests__/github-webhooks.test.ts src/github.test.ts`

**Artifacts:**
- `packages/dashboard/src/github-webhooks.ts` (new)
- `packages/dashboard/src/github.ts` (modified)
- `packages/dashboard/src/__tests__/github-webhooks.test.ts` (new)
- `packages/dashboard/src/github.test.ts` (modified)

### Step 2: Wire the webhook route and retire focused live badge polling

- [ ] Add `POST /api/github/webhooks` in `packages/dashboard/src/routes.ts` and the necessary raw-body plumbing in `packages/dashboard/src/server.ts` so webhook signature verification happens before normal JSON parsing; respond `200` to valid `ping`, `202` to valid but unsupported/irrelevant events, `401` for missing required webhook auth headers, `403` for signature mismatch/tamper, and a clear `503`/`500` when GitHub App configuration is missing or installation-token refresh fails
- [ ] Fetch canonical badge state on relevant webhook deliveries and update every matching task with refreshed `lastCheckedAt` timestamps via `store.updatePrInfo()` / `store.updateIssueInfo()`, letting the existing `task:updated` bridge continue broadcasting `badge:updated` websocket payloads without changing the browser protocol
- [ ] Remove the live `/api/ws` dependency on `githubPoller.start()`, `replaceTaskWatches()`, `unwatchTask()`, and periodic badge polling; if `packages/dashboard/src/github-poll.ts` remains only for shared rate-limiter utilities, make sure no live badge-update path still depends on `watchTask()`/`pollOnce()` semantics
- [ ] Remove the remaining fallback-route coupling to in-memory poller state: `GET /api/tasks/:id/pr/status` and `GET /api/tasks/:id/issue/status` must compute staleness from persisted badge timestamps (`task.prInfo.lastCheckedAt` / `task.issueInfo.lastCheckedAt`, then `task.updatedAt`) rather than `githubPoller.getLastCheckedAt()`
- [ ] Keep `GET /api/tasks/:id/pr/status`, `POST /api/tasks/:id/pr/refresh`, `GET /api/tasks/:id/issue/status`, and `POST /api/tasks/:id/issue/refresh` as the documented 5-minute/manual fallback path, but make their repo resolution prefer the task’s badge URL before falling back to `GITHUB_REPOSITORY` or the local git remote so webhook and fallback refreshes use the same repository source of truth
- [ ] Update automated route coverage in `packages/dashboard/src/routes.test.ts` for supported event handling, malformed-body and invalid-signature rejection, missing-config behavior, persisted-timestamp staleness behavior, and unchanged fallback refresh endpoints
- [ ] Add explicit regression tests for multi-repo correctness in both PR and issue fallback paths: when `task.prInfo.url` / `task.issueInfo.url` points at a different repository than `GITHUB_REPOSITORY` or the local git remote, the status/refresh logic must call the GitHub client with the repo parsed from the badge URL
- [ ] Delete or rewrite `packages/dashboard/src/__tests__/github-poll.test.ts` so the suite no longer asserts live websocket badge polling behavior; if the file remains, it should cover only any retained shared utilities such as `GitHubRateLimiter`
- [ ] Run targeted tests for changed files: `pnpm --filter @kb/dashboard test -- src/routes.test.ts`

**Artifacts:**
- `packages/dashboard/src/server.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/github-poll.ts` (modified or removed)
- `packages/dashboard/src/rate-limit.ts` (modified if the webhook route needs dedicated rate-limit handling)
- `packages/dashboard/src/routes.test.ts` (modified)
- `packages/dashboard/src/__tests__/github-poll.test.ts` (modified or removed)

### Step 3: Prove webhook-to-websocket delivery without poller activity

- [ ] Add a real `createServer()` integration test in `packages/dashboard/src/__tests__/server-webhook.test.ts` that posts a signed webhook body through the production server stack, proves verification uses the actual raw bytes before JSON parsing, and rejects a payload whose bytes no longer match the signature even if the parsed JSON shape is equivalent
- [ ] Update `packages/dashboard/src/__tests__/websocket.test.ts` so a subscribed `/api/ws` client receives `badge:updated` after a valid signed webhook POST, with no assertions that depend on `githubPoller` lifecycle methods or subscription-driven watch sets
- [ ] Add end-to-end automated coverage for at least these badge-relevant cases: a `pull_request` event that changes PR status/title, an `issue_comment` event on a PR that refreshes `commentCount` / `lastCommentAt`, an `issues` event that changes `issueInfo.state` / `stateReason`, a same-resource delivery that updates multiple linked tasks, and an invalid-signature delivery that does not update the store or broadcast anything
- [ ] Add a no-op freshness regression test: send two valid deliveries for the same resource where the second canonical fetch changes only `lastCheckedAt`, assert the newer timestamp is persisted, and prove subscribed websocket clients do **not** receive a second `badge:updated` message for freshness-only changes
- [ ] Preserve the existing websocket contract and browser-side merge behavior: `/api/ws` still emits only timestamped `badge:updated` snapshots, `useBadgeWebSocket()` remains API-compatible, and `TaskCard.tsx` continues to prefer fresher websocket data over older task/SSE badge state
- [ ] Run targeted tests for changed files: `pnpm --filter @kb/dashboard test -- src/__tests__/server-webhook.test.ts src/__tests__/websocket.test.ts`

**Artifacts:**
- `packages/dashboard/src/__tests__/server-webhook.test.ts` (new)
- `packages/dashboard/src/__tests__/websocket.test.ts` (modified)
- `packages/dashboard/app/hooks/useBadgeWebSocket.ts` (verify unchanged or modify only if tests prove it is required for compatibility)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Update `AGENTS.md` to replace the current “focused GitHub poller drives `/api/ws`” guidance with the new webhook-ingestion architecture while preserving the existing badge-websocket client expectations and 5-minute fallback route note
- [ ] Update `packages/dashboard/README.md` and `packages/cli/STANDALONE.md` with the GitHub App setup flow for badge updates: required env vars (`KB_GITHUB_APP_ID`, `KB_GITHUB_APP_PRIVATE_KEY` or `KB_GITHUB_APP_PRIVATE_KEY_PATH`, `KB_GITHUB_WEBHOOK_SECRET`), webhook URL (`POST /api/github/webhooks`), minimum GitHub App permissions/event subscriptions (Metadata read, Pull requests read, Issues read, and the `pull_request`, `issues`, and `issue_comment` webhook events), and what fallback behavior remains when webhook delivery is unavailable
- [ ] Update `README.md` if its GitHub/dashboard section still implies realtime badge freshness comes from polling rather than webhook ingestion
- [ ] Add `.changeset/github-app-badge-webhooks.md` describing the published `@dustinbyrne/kb` dashboard improvement as a patch release
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — remove the badge-websocket server note that says websocket subscriptions drive the focused GitHub poller, and replace it with webhook-ingestion expectations plus the unchanged fallback/manual refresh guidance
- `packages/dashboard/README.md` — document `POST /api/github/webhooks`, the GitHub App env vars, required GitHub App permissions/event subscriptions, supported live badge events, and the unchanged `/api/ws` `badge:updated` snapshot contract
- `packages/cli/STANDALONE.md` — add operator setup instructions for GitHub App webhook delivery when running `kb dashboard`, including the minimum app permissions/event subscriptions needed for badge refreshes
- `.changeset/github-app-badge-webhooks.md` — patch release note for the published CLI/dashboard package

**Check If Affected:**
- `README.md` — update if the root GitHub integration docs still describe realtime badge freshness as polling-based or omit the new GitHub App webhook configuration path

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Valid signed GitHub App webhook deliveries update every matching task’s `prInfo` / `issueInfo` with canonical GitHub data and refreshed `lastCheckedAt` timestamps
- [ ] Repeated webhook deliveries for unchanged badge data still keep persisted freshness accurate (`lastCheckedAt`) without causing duplicate websocket broadcasts when badge-relevant fields did not change
- [ ] Subscribed `/api/ws` clients receive the existing `badge:updated` snapshot shape after webhook-driven task updates, without relying on `GitHubPollingService` watch/poll lifecycle
- [ ] Invalid or tampered webhook deliveries are rejected before they can mutate task data or broadcast badge updates, and the real `createServer()` test stack proves signature verification uses raw request bytes rather than parsed JSON
- [ ] PR/issue status refresh endpoints still work as the 5-minute/manual fallback path when webhook delivery is unavailable, and their staleness logic depends only on persisted badge timestamps instead of `githubPoller.getLastCheckedAt()`
- [ ] Multi-repo badge links continue to resolve correctly by parsing stored badge URLs instead of assuming the dashboard’s local git remote, and multiple tasks linked to the same resource all refresh together

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-137): complete Step N — description`
- **Bug fixes:** `fix(KB-137): description`
- **Tests:** `test(KB-137): description`

## Do NOT

- Expand task scope
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Keep `GitHubPollingService` in the live `/api/ws` badge-update path or leave dead poller wiring behind in `setupBadgeWebSocket()`
- Remove the existing PR/issue refresh endpoints or the 5-minute fallback behavior documented in `AGENTS.md`
- Trust webhook payload fields for canonical badge state when a follow-up GitHub fetch is required to preserve the existing `PrInfo` / `IssueInfo` contract
- Let webhook-triggered canonical refreshes read through the operator’s `gh` session; they must use GitHub App installation auth only
- Accept unsigned webhook requests, skip `X-Hub-Signature-256` verification, or verify against a parsed/re-serialized body instead of the raw request bytes
- Change the `/api/ws` client message protocol or the `badge:updated` server payload shape
- Assume there is only one task per PR/issue or only one repository involved; update all matching tasks by parsed badge URL
- Expand into websocket authorization hardening (KB-135) or cross-instance badge pub/sub scaling (KB-136) beyond preserving their behavior if already merged
- Persist installation tokens, webhook secrets, or GitHub App private keys in task data or browser state
