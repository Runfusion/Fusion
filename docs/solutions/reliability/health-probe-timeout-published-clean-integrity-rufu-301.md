---
title: "A health-probe timeout published 'no corruption' — the canary was blind exactly when it was sick"
date: 2026-09-26
category: reliability
problem_type: reliability
module: "@fusion/core / @fusion/dashboard"
component: postgres connection / task-id-integrity / /api/health / dashboard banners
tags:
  - health-probe
  - statement-timeout
  - task-id-integrity
  - fail-open
  - fail-closed
  - corruption-detected
  - health-session
  - rufu-301
symptoms:
  - "/api/health reports degraded with a probe timeout while database.corruptionDetected is false"
  - "taskIdIntegrity.status is ok while taskIdIntegrity.errors (or the degraded status) names an unread database"
  - "the connectivity stage starts timing out after the integrity stage timed out once"
  - "pg_isready says accepting connections while the Fusion health probe keeps failing"
  - "the banner cluster shows a database-error banner beside an empty integrity banner"
---

## What happened

The task-ID integrity canary is the only automated check that catches an allocator regression
overwriting a card. It reports through `GET /api/health`, and its headline field is
`database.corruptionDetected`. When the probe failed, that field said `false`.

The reported capture, reproduced against a seeded corpus on a server `pg_isready` calls
`accepting connections`:

```
POLL1 5005ms status=error errors=["PostgreSQL task-ID integrity probe timed out after 5000ms"]
```

…and alongside that error, the same payload published `corruptionDetected: false` with zero
findings. Three independent layers each contributed, which is why no single layer's test
caught it.

| Layer | Defect | Effect |
| --- | --- | --- |
| transport | the `max: 1` health session had no server-side statement cap | an abandoned probe read kept executing on the only session and serialized every later readiness read behind it |
| detector | `detectTaskIdIntegrityAnomaliesAsync` caught *any* error and returned `buildReport(checkedAt, [])` | an unmeasured database was recorded as `status: "ok"` with no anomalies |
| display | `failedHealth()` hardcoded `corruptionDetected: false`, and `/api/health` forwarded it verbatim | every probe/connectivity failure published "no corruption" as its own conclusion |

## The transport part: a wedge, not a slow query

The obvious hypothesis — the detector's reads are too slow for the 5 s budget — is **false at
measured scale**. On a 60k-task / 9k-archived corpus built with the deployed index set and RLS
policies (`TEMPLATE` clone of the production schema):

| read | plan | DB execution |
| --- | --- | --- |
| scoped active ids (20k rows) | Index Only Scan on `tasks_pkey` (`(project_id, id)`) | 2.177 ms |
| scoped archived ids (9k rows) | Index Scan on `idxArchivedTasksProjectId` | 0.415 ms |
| allocator state (9 rows) | Seq Scan | 0.014 ms |
| unscoped active ids (60k rows) | Index Only Scan | 5.496 ms |

End-to-end through `detectTaskIdIntegrityAnomaliesAsync`: **21.6 ms scoped**, **68.4 ms
unscoped**. No bloat (0 dead tuples), no missing index. Raising the budget, adding an index, or
caching the reads would have treated a capacity problem that does not exist.

What actually happened is visible in `pg_stat_activity` right after the caller gives up:

```
ABANDONED WORK STILL HOLDING THE HEALTH SESSION:
  pid=1221690 state=active age=00:00:05.60 q=SELECT pg_sleep(9)              <- maintenance holder
  pid=1221757 state=active age=00:00:05.00 q=SELECT id FROM project.tasks WHERE project_i...
```

A client-side deadline abandons the *wait*, not the *query*. Consecutive polls then show the
failure migrating upstream and renewing itself:

```
poll 6025ms errors=["PostgreSQL task-ID integrity probe timed out after 6000ms"]
poll 6007ms errors=["PostgreSQL health probe timed out after 6000ms"]     <- connectivity stage now
poll 6007ms errors=["PostgreSQL health probe timed out after 6000ms"]
post-release poll 41ms healthy=true errors=[]
```

Polls 2 and 3 never reach the integrity stage: their connectivity `SELECT 1` queues behind the
*previous* poll's abandoned detector query on the same single session. Each abandoned poll adds
another query to the pile, so the condition survives long after the triggering stall ends. That
is how a canary stays blind for far longer than the incident.

The fix is to make the health session cancel its own work: a `statement_timeout` supplied as a
connection parameter on the `max: 1` health session, computed strictly below the probe budget
(`healthSessionStatementTimeoutMs(DEFAULT_HEALTH_PROBE_BUDGET_MS)` = 4750 ms of a 5000 ms probe,
leaving the client room to report the cancellation). Validation on the same harness:

```
health session statement_timeout = 1500ms
blocked read released at 1504ms error="canceling statement due to statement timeout"
abandoned detector queries still on the session: 0
next statement on same session waited 1ms
healthy scoped read 20000 rows in 15ms
```

The cap is applied **only** to the health session: a pool-wide cap would cancel real scheduler
work, so PostgreSQL keeps its shipped `statement_timeout = 0` ("never cancel") everywhere else.
The computed cap is also never zero, because zero would mean "no cap" — an absurd budget clamps
to 1 ms instead of disabling the protection it exists to provide.

## The display part: `false` has to mean something

The boolean was chosen deliberately over tri-state `corruptionDetected: null`, because every
consumer truthiness-checks it — `null` would have read as falsy-clean, the same blindness in a
new costume. Instead:

- `/api/health` enforces a pair invariant at publication: any blocking condition (non-empty
  `corruptionErrors`, `healthy: false`, or `taskIdIntegrity.status: "error"`) forces
  `corruptionDetected: true`. A builder that drifts back to `false` cannot ship a clean-looking
  degraded payload.
- NOT-VERIFIED travels in `taskIdIntegrity.status: "error"` plus a `failure` class —
  `unconfigured` | `unreachable` | `incomplete` — so the three causes stay distinguishable after
  the boolean collapses them. `incomplete` means "PostgreSQL answered, the measurement did not",
  which is why its recommended action says to retry rather than to restore connectivity.
- the detector now rejects a cancelled/failed measurement (`TaskIdIntegrityMeasurementError`)
  instead of resolving an empty report, so "unmeasured" cannot be recorded as "clean".
- the banner cluster shows exactly one banner per failure: an `incomplete` integrity result
  suppresses the generic database banner (connectivity is fine; a "cannot read your database"
  warning would be a false statement about the wrong thing), while `unconfigured` / `unreachable`
  keep it.

## How to tell the three states apart

| payload | meaning |
| --- | --- |
| `corruptionDetected: false`, `taskIdIntegrity.status: "ok"`, `corruptionErrors: []` | completed clean — the only shape that claims clean |
| `taskIdIntegrity.status: "anomaly"` + `anomalies[]` | measured and sick: allocator regression, investigate |
| `taskIdIntegrity.status: "error"` + `failure` class, `corruptionDetected: true` | not verified: retry the probe; do not read this as clean or as corruption |

## Reachability boundary

This fixes the async PostgreSQL canary, which is the path `/api/health` uses. The synchronous,
SQLite-era detector in `packages/core/src/tasks/task-id-integrity.ts` retains a fail-open shape
(empty report on error) with no production caller found for the health path; it was left alone
rather than changed under this task's acceptance gate, and is filed as a follow-up.

`*.pg.test.ts` — `packages/core/src/__tests__/postgres/health-session-statement-cap.pg.test.ts` —
asserts the cap against a real server (wiring, cancellation inside the budget, immediate reuse of
the session, and a `statement_timeout = 0` control). Deleting the cap turns only the wiring
assertion red: `expected '0' to be '4750ms'`.
