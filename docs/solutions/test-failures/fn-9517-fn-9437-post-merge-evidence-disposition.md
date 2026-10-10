---
title: FN-9437 immutable post-merge evidence disposition
category: test-failure
module: github-actions
problem_type: ci-evidence
---

# FN-9437 immutable post-merge evidence disposition

## Scope and immutable identity

FN-9437 landed at `93e5f5367ae61aa57381168664a8281f18c7d088`. Its first Full Suite push-to-main record is GitHub Actions run [`37264748966`](https://github.com/Runfusion/Fusion/actions/runs/37264748966), attempt `1`, at that same SHA. This ledger reports only that attempt. A commit, local test, later workflow run, or GitHub rerun cannot add evidence to or change this historical attempt.

## Hosted jobs

| Producer | Job | Completed state | Observable evidence |
| --- | --- | --- | --- |
| Test shard 1/4 | [`111619069059`](https://github.com/Runfusion/Fusion/actions/runs/37264748966/job/111619069059) | `cancelled` at `2026-10-05T05:48:25Z` | The job reached GitHub's one-hour limit while its deterministic test step was active. Its timing-upload step did not run. |
| Test shard 2/4 | [`111619069042`](https://github.com/Runfusion/Fusion/actions/runs/37264748966/job/111619069042) | `failure` at `2026-10-05T05:06:27Z` | The deterministic test step failed, then the timing-upload step succeeded at `2026-10-05T05:06:25Z`. |
| Test shard 3/4 | [`111619068992`](https://github.com/Runfusion/Fusion/actions/runs/37264748966/job/111619068992) | `success` at `2026-10-05T05:09:36Z` | Its retained timing artifact is listed below. |
| Test shard 4/4 | [`111619068985`](https://github.com/Runfusion/Fusion/actions/runs/37264748966/job/111619068985) | `failure` at `2026-10-05T05:01:08Z` | The deterministic test step failed, then the timing-upload step succeeded at `2026-10-05T05:01:05Z`. |
| Pipeline smoke tier | [`111619068996`](https://github.com/Runfusion/Fusion/actions/runs/37264748966/job/111619068996) | `success` at `2026-10-05T04:51:24Z` | The retained Pipeline smoke report is listed below; it does not replace shard evidence. |
| Post-merge Full Suite evidence gate | [`111633001534`](https://github.com/Runfusion/Fusion/actions/runs/37264748966/job/111633001534) | `failure` at `2026-10-05T05:48:39Z` | Validation failed with `ENOENT` for `post-merge-evidence/test-timings-shard-1`; the normalized-evidence retention step was skipped. |

## Artifact census

The GitHub Actions artifact inventory returned exactly these four unexpired artifacts for run `37264748966`:

| Artifact | ID | Created | Expires | Published digest |
| --- | --- | --- | --- | --- |
| `test-timings-shard-2` | `11326099454` | `2026-10-05T05:06:25Z` | `2026-10-19T05:06:24Z` | `sha256:df03eceadc60da036f05ed9e37e261aadccfaf2be39e81c48f6869165e4f3880` |
| `test-timings-shard-3` | `11326646906` | `2026-10-05T05:09:32Z` | `2026-10-19T05:09:31Z` | `sha256:cbcb971a69b07a63633020e2fae2520c8cd301e345a25c042a89b972724c3316` |
| `test-timings-shard-4` | `11326282191` | `2026-10-05T05:01:05Z` | `2026-10-19T05:01:04Z` | `sha256:ba16fc045f0cc944fd946013838f27261c5ebd6072d65656f2e8c5cacec0d31f` |
| `pipeline-smoke-report` | `11326516654` | `2026-10-05T04:51:21Z` | `2026-10-19T04:51:21Z` | `sha256:20505f54d8dd4aa1300680a4a816c9e8b64917299e30fcd428e8e08767b1a26b` |

The inventory contains neither `test-timings-shard-1` nor `post-merge-full-suite-evidence`. The downloaded shard-2 and shard-4 archives each matched their published SHA-256 digest before their JSON reports were inspected. Their names, local extraction, or a diagnostic manifest produced later are not evidence that either missing artifact existed in attempt 1.

## Retained failure ledger

The retained reports establish these failed assertions. The records contain no approved causal attribution to FN-9437, and the historical normalized manifest that would have consolidated the evidence was never retained. Each assertion therefore remains `unresolved`; none is dismissed as unrelated or converted to a passing result.

| Shard | Retained report | Failed assertion | Disposition |
| --- | --- | --- | --- |
| 2 | `packages/engine/.timings/timings-shard2-1.json` | `FN-8923 orphan durable-write inventory drift guard > rebuilds a current manifest without changing it` | `unresolved` |
| 2 | `packages/engine/.timings/timings-shard2-1.json` | `seedDashboardProviders > registers built-in API-key providers even with no custom providers (undefined)` | `unresolved` |
| 2 | `packages/engine/.timings/timings-shard2-1.json` | `seedDashboardProviders > registers built-in API-key providers with an empty customProviders array` | `unresolved` |
| 4 | `packages/dashboard/.timings/timings-shard4-4.json` | `mergeTaskPr native auto-merge > transitions only when GitHub already reports the PR merged` | `unresolved` |
| 4 | `packages/dashboard/.timings/timings-shard4-4.json` | `mergeTaskPr native auto-merge > reconciles a freshly observed external merge before rejecting stale direct-merge readiness` | `unresolved` |

Shard 1 is a cancelled producer, not an assertion failure with unknown test names. The missing shard-1 artifact prevents a complete assertion census.

## Current disposition and required operator action

The default `post-merge-verification` contract requires the first eligible run, Pipeline smoke, conclusions for all four shards, all four genuine timing artifacts, and evidence-backed disposition for every failed lane. This attempt is ineligible: shard 1 was cancelled before upload, `test-timings-shard-1` is absent, `post-merge-full-suite-evidence` is absent, and the retained shard-2/shard-4 failures remain unresolved.

No durable operator decision was found that names FN-9437, run `37264748966`, attempt `1`, the two missing artifacts, the shard-2/shard-4 disposition, the exact exception or replacement rule, approving operator, and timestamp. FN-9437's post-merge gate must remain blocked. The sole resolution path is a durable, specifically scoped operator decision with those details; it may not globally accept missing artifacts, convert cancelled or failed producers to success, or mutate historical GitHub evidence.

See [FN-9507's evidence disposition](./fn-9507-full-suite-evidence-disposition.md) for the collector repair and its unchanged no-substitution boundary.
