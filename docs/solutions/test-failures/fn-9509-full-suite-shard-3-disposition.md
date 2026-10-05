---
title: FN-9509 Full Suite shard 3 dashboard disposition
date: 2026-10-05
category: test-failures
---

# FN-9509: Full Suite shard 3 dashboard disposition

## Source evidence

- Full Suite run: [37329333335](https://github.com/Runfusion/Fusion/actions/runs/37329333335), head `50dd8e759f1798ba2ff6259df6e531b067eafbfa`, completed with conclusion `failure`.
- Shard job: [Test shard 3/4](https://github.com/Runfusion/Fusion/actions/runs/37329333335/job/111828105114), job ID `111828105114`, ran from `2026-10-05T15:00:42Z` to `2026-10-05T15:21:05Z`. Its deterministic test step failed; workspace build and timing upload succeeded.
- Timing artifact: `test-timings-shard-3`, ID `11353804403`, created `2026-10-05T15:21:01Z`, size 456,554 bytes, digest `sha256:45374ef636f81123ccecc69b4e214721cca931dfee609e654cfe1d00238ff07f`.
- Post-merge evidence artifact: `post-merge-full-suite-evidence`, ID `11355087589`, created `2026-10-05T15:33:06Z`, size 1,433 bytes, digest `sha256:01db9e2fcbffced90ad8b7e619b49998375fd98eaeab75a344cf483e3dbff4d6`.

Acquisition used the authorized GitHub Actions API on 2026-10-05. The locally calculated SHA-256 for each downloaded ZIP exactly matched its GitHub-published digest. The timing ZIP contained the shard diagnostic plus seven package reports; the post-merge manifest confirmed the shard's process-level exit code `1`, no timeout, and the two dashboard assertion failures below. Pipeline smoke completed successfully in 99,552 ms with 41 invocations.

## Reporter findings

The dashboard reporter was `packages/dashboard/.timings/timings-shard3-2.json`. It reported 176 suites and exactly two failed assertions:

| Test | Source | Duration | Reported condition |
| --- | --- | ---: | --- |
| `AgentDetailView — core renders assigned skills as readable badges with full id tooltip` | `AgentDetailView.core.test.tsx:482` | 117.435 ms | Expected an available discovered badge; received the initial `unknown` discovery state. |
| `PlanningModeModal sequential flow silently reconciles duplicate-response generation conflicts on 'desktop' with 'a durable next question'` | `PlanningModeModal.planning-flow.test.tsx:1262` | 1,077.521 ms | The response mock was not called after the test clicked Next. |

All other reports in the shard completed their assertions without failed test names. The diagnostic establishes that this was a reporter-visible dashboard failure, not a pre-Vitest failure, watchdog timeout, or missing-report condition.

## Attribution and repair

The Agent Detail component intentionally renders persisted skill IDs before asynchronous discovery completes. The test identified a badge after the agent fetch, then immediately asserted a resolved discovery state. The repair waits for both discovered badges to reach their real `auto-available` state before checking readable labels and exact stored-ID tooltips. It preserves the separately asserted unknown badge and does not change visible product behavior or canonical content resolution.

The Planning Mode component submits only after selecting an answer commits to the live form and enables Next. Under the loaded lane, the test could click the pre-commit disabled control, so the mocked request correctly remained uncalled. The repair waits for the current Next action to become enabled before dispatching it, then retains the existing assertions for silent durable-question/generating reconciliation and absent duplicate-error banner. This is test-action readiness, not a duplicate-response server or client semantic change.

The actual shard topology uses `dashboard-app-quality-backfill` with `--shard=3/4` through the dashboard quality runner. The targeted reporter evidence, current focused tests, and the exact affected quality-backfill shard all pass after the repair. No retry, timeout expansion, assertion weakening, test skip, or quarantine was used.

## Causal boundary

The incident SHA is the FN-9508 commit. Its diff contains only an engine test fixture and its incident disposition document. It does not change dashboard components, their tests, discovery/cache code, Planning Mode reconciliation, or dashboard lane configuration; it is not a cause or edit surface for this disposition.

The prior FN-9506 Agent Detail observation concerns a different legacy-resolution test and remains its own first-sighting record. The current badge failure has an independently reproduced asynchronous state boundary and a structural test repair. Existing Planning Mode history documents the earlier duplicate-reconciliation product race; this incident's reporter evidence instead identifies the direct test-action readiness boundary, which is repaired without changing the already fenced reconciliation code.

## Verification

- Focused incident cases under `dashboard-app-quality-backfill` — passed.
- Exact dashboard quality-backfill shard 3/4 command — passed.
- The planned lint, fast verification, and build checks are recorded with the task delivery evidence.

No published `@runfusion/fusion` behavior changed, so no changeset is required.
