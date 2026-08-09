# Signals Connectors

Fusion can receive signed external signals from GitHub, GitLab, Sentry, Datadog, PagerDuty, or a generic webhook at:

```text
POST /api/signals/:provider
```

Supported providers are `webhook`, `github`, `gitlab`, `sentry`, `datadog`, and `pagerduty`. Every connector requires a verification secret configured in the Fusion dashboard process environment. Generic webhook, GitHub, Sentry, Datadog, and PagerDuty use HMAC signatures; GitLab uses GitLab's `X-Gitlab-Token` secret-token header. Actionable open signals create triage tasks and write to the project-scoped `incidents` table so Command Center → Signals can show source, severity, and open/resolved status breakdowns. GitHub recovery-only green CI signals are the exception: they create neither a task nor a new incident.

## Runtime behavior

- **Open events** create or absorb an incident occurrence by `groupingKey` and preserve the normalized `source`, `severity`, optional `link`, and capped `meta` fields.
- **Resolved events** write/absorb the incident and then mark the matching `groupingKey` as `resolved`. Cold resolves are retained as resolved signal metrics instead of being dropped.
- **Duplicate deliveries** with the same provider external id are accepted as deduped and do not create a second task or incident write.
- **Re-fired incidents** with the same `groupingKey` are absorbed by the incidents store rather than double-counted as separate incidents.
- The connectors status endpoint, `GET /api/command-center/signals/connectors`, returns only `{ provider, configured }` booleans. It never returns secret values.

## Security model

- Secrets are environment variables; do not commit them to source control.
- HMAC verification uses the raw request body and constant-time comparison where the provider supplies an HMAC signature. GitHub uses `X-Hub-Signature-256`; GitLab secret-token verification compares `X-Gitlab-Token` to `FUSION_SIGNAL_GITLAB_SECRET` with constant-time comparison.
- Requests are capped at about 1 MB.
- Replay protection rejects stale timestamps where the provider supplies one and rejects repeated delivery ids within the replay window.
- Normalized `title`, `body`, `groupingKey`, `link`, and `meta` fields are capped by `signal-source.ts` before storage.
- Signal `link` values are SSRF-untrusted. Fusion stores safe external URLs as data for the UI and never fetches connector links server-side.
- `meta` is stored as JSON data only and must not be rendered as raw HTML.

## Generic webhook

Set:

```bash
export FUSION_SIGNAL_WEBHOOK_SECRET="replace-with-a-long-random-secret"
```

Headers:

- `X-Fusion-Signature`: `sha256=`-prefixed HMAC-SHA256 hex digest of the raw JSON body.
- `X-Fusion-Timestamp`: epoch milliseconds, used for the replay window.

Payload contract:

```json
{
  "id": "delivery-123",
  "title": "API error rate above threshold",
  "body": "5xx rate exceeded 10% for 5 minutes",
  "severity": "critical",
  "groupingKey": "api-error-rate",
  "link": "https://example.com/incidents/api-error-rate",
  "timestamp": 1790294400000,
  "status": "open",
  "meta": { "service": "api" }
}
```

Resolution mapping: `status: "resolved"`, `action: "resolved"`, or `action: "resolve"` resolves the grouped incident. Any other value opens/absorbs the incident.

Example signed request:

```bash
body='{"id":"delivery-123","title":"API error rate above threshold","severity":"critical","groupingKey":"api-error-rate","timestamp":'"$(date +%s000)"'}'
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$FUSION_SIGNAL_WEBHOOK_SECRET" -hex | awk '{print $2}')"
curl -X POST "http://127.0.0.1:4040/api/signals/webhook" \
  -H "Content-Type: application/json" \
  -H "X-Fusion-Timestamp: $(date +%s000)" \
  -H "X-Fusion-Signature: $sig" \
  --data-binary "$body"
```

## Sentry

Set:

```bash
export FUSION_SIGNAL_SENTRY_SECRET="sentry-integration-client-secret"
```

Configure the Sentry integration webhook target as `/api/signals/sentry`. Fusion verifies `Sentry-Hook-Signature` as the HMAC-SHA256 hex digest of the raw body. If Sentry sends `Sentry-Hook-Timestamp`, Fusion checks it against the replay window.

Normalization:

- `groupingKey`: Sentry `issue.id`.
- `source`: `sentry`.
- `severity`: `fatal`/`critical` → `critical`, `error` → `error`, `warning` → `warning`, `info`/`debug` → `info`.
- Resolution: payload `action === "resolved"` or `issue.status === "resolved"` resolves the grouped issue; other actions open/absorb it.

## Datadog

Set:

```bash
export FUSION_SIGNAL_DATADOG_SECRET="datadog-webhook-shared-secret"
```

Datadog webhooks do not provide a built-in HMAC header, so configure a custom header:

```text
X-Datadog-Signature: <HMAC-SHA256 hex digest of the raw body>
```

Optionally include `X-Datadog-Timestamp` as epoch milliseconds for replay-window validation. Configure the Datadog webhook target as `/api/signals/datadog`.

Normalization:

- `groupingKey`: `aggreg_key`, `alert_id`, or `id`.
- `source`: `datadog`.
- `severity`: `error` → `critical`, `warning`/`warn` → `warning`, `success`/`recovery`/`info` → `info`, default → `error`.
- Resolution: `alert_type` of `recovery` or `success` resolves the grouped monitor; other alert types open/absorb it.

## PagerDuty

Set:

```bash
export FUSION_SIGNAL_PAGERDUTY_SECRET="pagerduty-webhook-subscription-secret"
```

Configure the PagerDuty webhook subscription target as `/api/signals/pagerduty`. Fusion verifies `X-PagerDuty-Signature` and accepts the `v1=<hex>` signature form.

Normalization:

- `groupingKey`: PagerDuty incident `data.id`.
- `source`: `pagerduty`.
- `severity`: explicit `data.severity` when it is one of Fusion's normalized severities; otherwise high urgency maps to `critical` and other events map to `warning`.
- Resolution: `event.event_type === "incident.resolved"` or `data.status === "resolved"` resolves the grouped incident; other incident events open/absorb it.

## GitHub

Set `FUSION_SIGNAL_GITHUB_SECRET` and configure `https://<your-fusion-host>/api/signals/github` for GitHub `check_suite`, `workflow_run`, and `status` deliveries. Fusion verifies the raw body using `X-Hub-Signature-256`. Terminal outcomes are also stored in `github_check_states` by `(project, repo, head SHA, check name)`. When `requiredChecks` is configured, exact-head rows may fill a missing polled check or block a disagreement; missing heads, cross-project rows, and stale commits never substitute. Newer delivery timestamps win retries, and engine batch-1 `prune-github-check-states` removes rows after 14 days even when deliveries stop.

Normalization uses:

- `source`: `github`.
- `groupingKey`: `github:<repo>:<kind>:<check-name>:<head-sha>`.
- `externalId`: `delivery:<X-GitHub-Delivery>` when available; otherwise a grouping-key/outcome/timestamp fallback so a failure and recovery are distinct.
- `title`: repository, check name, and outcome; `link`: the safe GitHub run/target URL or repository commit URL fallback.
- `severity` and `resolution`: the terminal-outcome mapping below.

Terminal outcomes map as follows:

| Outcome | Severity | Resolution |
| --- | --- | --- |
| `failure`, `timed_out`, `startup_failure`, `stale`, `error` | error | open |
| `action_required`, `cancelled` | warning | open |
| `success`, `neutral`, `skipped` | info | resolved, recovery-only |
| unknown future outcome | warning | open (fail-visible) |

Pending, queued, in-progress, and ping deliveries are accepted without tasks or incidents. Recovery-only green outcomes create no triage task or incident: they atomically resolve only the newest already-open incident with a status-gated conditional update. Cold, redelivered, and concurrent greens write nothing; only one concurrent caller can resolve an open row, and no delivery can rewrite `resolvedAt` after that.

Upstream evidence: [GitHub webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads) and [signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

## GitLab

Set:

```bash
export FUSION_SIGNAL_GITLAB_SECRET="gitlab-webhook-secret-token"
```

Configure a GitLab project or group webhook with:

- **URL**: `https://<your-fusion-host>/api/signals/gitlab`
- **Secret token**: the same value as `FUSION_SIGNAL_GITLAB_SECRET`
- **Triggers**: Issue events and/or Merge request events

Fusion verifies GitLab's `X-Gitlab-Token` header. GitLab's webhook docs now recommend signing tokens for new webhooks, but this connector intentionally supports the documented secret-token compatibility path required by existing GitLab.com and self-managed GitLab installations. This task introduces no GitLab binary, CLI, download, or checksum-managed artifact.

Broader GitHub-to-GitLab parity (issue import, linked tracking, lifecycle automation, and Command Center analytics) is mapped in [GitLab Parity Inventory](./gitlab-parity-inventory.md). These signal webhooks are the GitLab side of that parity surface.

Supported GitLab events:

- Project and group **Issue Hook** payloads with `object_kind`/`event_type` of `issue`.
- Project and group **Merge Request Hook** payloads with `object_kind`/`event_type` of `merge_request`.
- Work item issue payloads (`object_kind: "work_item"`) are treated as issue signals when they provide issue-shaped `object_attributes`.

Normalization:

- `source`: `gitlab`.
- `groupingKey`: `gitlab:<project-or-group>:<issue|merge_request>:<iid>` using `project.path_with_namespace`, project id, group full path, or group id when available.
- `externalId`: GitLab delivery headers such as `X-Gitlab-Event-UUID`, `Idempotency-Key`, `webhook-id`, or `X-Request-Id` when present; otherwise a stable fallback that includes grouping key, action, state, and timestamp so open and recovery events for the same IID are not deduped together.
- `title`: `GitLab issue #<iid>: <title>` or `GitLab merge request !<iid>: <title>`.
- `link`: `object_attributes.url` when safe, otherwise a project URL fallback. Fusion supports both GitLab.com and self-managed instance URLs and never fetches these links server-side.
- `severity`: GitLab issue severity values such as `critical`, `high`, `medium`, and `low` map to Fusion's normalized severities; merge requests default to `info`.
- Resolution: issue `action`/`state` of `close`/`closed` resolves the grouped signal; merge request `merge`/`merged` or `close`/`closed` resolves it; `open`, `update`, and `reopen` open/absorb it.

Non-actionable or unsupported GitLab events, including push/test/ping/system-hook-style payloads, are accepted as non-actionable and do not create tasks. Malformed actionable issue/MR payloads, such as missing `object_attributes.iid` or `object_attributes.title`, return a 4xx response and do not create tasks.

Relevant upstream evidence:

- GitLab upstream project: <https://gitlab.com/gitlab-org/gitlab>
- GitLab webhook docs: <https://docs.gitlab.com/user/project/integrations/webhooks/>
- GitLab webhook event reference: <https://docs.gitlab.com/user/project/integrations/webhook_events/>
- GitLab group webhooks: <https://docs.gitlab.com/user/group/webhooks/>
- GitLab releases: <https://gitlab.com/gitlab-org/gitlab/-/releases>

## Command Center Signals

Command Center → Signals reads aggregated incidents through `GET /api/command-center/signals`. Once a connector secret is configured and signed events arrive, the area displays total, open, resolved, MTTR, by-source, by-severity, and by-status metrics from local incident rows.

The empty state is intentionally explicit:

- no configured connector secret: prompt operators to connect GitLab, Sentry, Datadog, PagerDuty, or the generic webhook;
- at least one configured connector secret but no rows in the selected range: report that Fusion is configured and awaiting signals.

## Separate monitor ingest path

`FUSION_MONITOR_INGEST_SECRET` protects the separate bearer-token route for `/api/monitor/incidents`. It is not used by `/api/signals/:provider`; signal connectors use the provider-specific `FUSION_SIGNAL_*_SECRET` variables above.
