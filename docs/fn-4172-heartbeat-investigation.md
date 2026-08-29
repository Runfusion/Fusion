# FN-4172 heartbeat investigation

User steering comment from FN-4119 at `2026-05-12T18:01:35.010Z`:

> Heartbeats are set to 1 hour so this isn’t a problem

## Hypothesis

The six CTO direct reports only look stale because their durable heartbeat interval is `3600000` ms (1 hour), so sub-hour heartbeat ages are expected rather than unhealthy.

## Current persisted measurements

Generated from `../../.fusion/fusion.db` at `2026-05-13T02:21:43.854057+00:00`.

| Agent | State | Interval ms | Timeout ms | Last heartbeat | Age min | Active run | Classification |
|---|---|---:|---:|---|---:|---|---|
| Frontend Engineer | active | 3600000 | 60000 | 2026-05-13T02:14:35.060Z | 7.15 | — | expected |
| Backend Engineer | active | 3600000 | 60000 | 2026-05-13T02:04:04.380Z | 17.66 | — | expected |
| Executor | running | 3600000 | 300000 | 2026-05-13T02:17:51.250Z | 3.88 | run-23a05323 (`active`) | expected |
| Technical Writer | active | 3600000 | 60000 | 2026-05-13T02:11:05.740Z | 10.64 | — | expected |
| QA Engineer | active | 3600000 | 60000 | 2026-05-13T01:30:35.273Z | 51.14 | — | expected |
| CI Engineer | active | 3600000 | 60000 | 2026-05-13T02:18:03.528Z | 3.67 | — | expected |

Classification rubric:

- `expected`: `ageOfLastHeartbeat < heartbeatIntervalMs × 1.5`
- `borderline`: `1.5×` to `3×`
- `stale`: `> 3× interval` or an active run older than `heartbeatTimeoutMs × 2`

## Decision

**Case A** applies: all six agents are within the expected range for a 1-hour heartbeat interval, and the lone active run (Executor) is well inside the stale-run timeout threshold. Recommendation: **close FN-4119 follow-up for this symptom** and do not pursue additional engine work based on age-of-last-heartbeat alone. Re-open only if a future incident produces concrete evidence of a real orphaned run, lost timer, or dashboard misclassification.

## Verification

- `pnpm lint` ✅
- `pnpm test` ✅
- `pnpm build` ✅
