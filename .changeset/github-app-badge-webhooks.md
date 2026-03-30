---
"@dustinbyrne/kb": patch
---

Replace GitHub badge polling with GitHub App webhook ingestion

- Added `POST /api/github/webhooks` endpoint for verified GitHub App webhook delivery
- Webhook signature verification using `X-Hub-Signature-256` header
- Support for `pull_request`, `issues`, and `issue_comment` (on PRs) events
- GitHub App installation token authentication for canonical badge fetches
- Multi-task resource matching by parsed badge URL (supports cross-repo badges)
- Idempotent freshness updates without duplicate websocket broadcasts
- Retained 5-minute REST refresh endpoints as fallback path
- Removed live `/api/ws` dependency on `GitHubPollingService` lifecycle

**Configuration:**
- `KB_GITHUB_APP_ID` - GitHub App ID
- `KB_GITHUB_APP_PRIVATE_KEY` or `KB_GITHUB_APP_PRIVATE_KEY_PATH` - PEM private key
- `KB_GITHUB_WEBHOOK_SECRET` - Webhook secret for signature verification

**Required GitHub App Permissions:**
- Metadata: Read
- Pull requests: Read
- Issues: Read

**Webhook Events:** `pull_request`, `issues`, `issue_comment`
