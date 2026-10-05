---
title: FN-9511 Full Suite shard 3 Planning Mode disposition
date: 2026-10-05
category: test-failures
---

# FN-9511: Full Suite shard 3 Planning Mode disposition

## Source evidence

- Full Suite run: [37349275647](https://github.com/Runfusion/Fusion/actions/runs/37349275647), head `aaa8b39ce36eaf07b9121fef6e24e88126300e86`, completed with conclusion `failure`.
- Shard job: Test shard 3/4. Its dashboard timing artifact was `test-timings-shard-3` (artifact ID `11362208900`, 458,410 bytes); it contains `packages/dashboard/.timings/timings-shard3-2.json`.
- The dashboard JSON reporter recorded assertion failures, not a hook timeout, watchdog timeout, or pre-Vitest process failure:

| Test | Duration | Reported condition |
| --- | ---: | --- |
| `PlanningModeModal sequential flow > silently reconciles duplicate-response generation conflicts on 'mobile' with 'generation progress'` | 1,076.440 ms | The captured Next button was disabled when the assertion expected it to become enabled. |
| `PlanningModeModal sequential flow > can refine a stopped initial plan into the first question` | 1,075.635 ms | `planning-plan-review` was not present after Stop. |

## Topology and attribution

The current deterministic shard planner assigns shard 3/4 the dashboard commands `test:quality:app:backfill-3`, `test:quality:app:backfill-4`, and `test:quality:app:settings`; the Planning Mode file belongs to `dashboard-app-quality-backfill` and is selected by its `--shard=3/4` run. The blocking `pnpm test:gate` composition runs static checks plus engine-core, core PostgreSQL/unit gates, and CLI CI-shape tests. It does not collect this dashboard backfill file.

FN-9510 is not a cause: its head commit `aaa8b39ce3` changes only the engine Vitest configuration, the shared quarantine ledger, and the observed-flake register. It does not modify the dashboard component, Planning Mode tests, dashboard Vitest configuration, or shard routing.

## Classification and repair

This was a deterministic test-action readiness defect, not a newly observed Planning Mode production ownership defect and not a quarantine case. After selecting an answer, React can replace the rendered Next control before the enabled state commits. The affected test captured that old button and then asserted against it. The shared Planning Mode test helper now waits for and re-queries the enabled live control before dispatching the response.

The Stop/refinement scenario now flushes the best-effort Stop request before locating the restored Plan review workspace. It then queries Refine from that restored workspace rather than using a control from the prior loading pane. Existing tests still cover desktop and mobile durable-question and generating duplicate reconciliation, stale load/poll, delayed session load, and stream ownership; no production behavior, timeout, retry, assertion relaxation, skip, or quarantine was added.

## Reproduction and verification

All commands ran against `aaa8b39ce3` before the local test-action repair unless noted otherwise:

- Focused stopped-plan case under `dashboard-app-quality-backfill`: passed.
- Focused mobile generating duplicate-response case under `dashboard-app-quality-backfill`: passed.
- Complete `PlanningModeModal.planning-flow.test.tsx` under `dashboard-app-quality-backfill`: passed before and after the repair.
- `pnpm --filter @fusion/dashboard run test:quality:app:backfill-3`: passed before the repair.
- The two original cases together and the complete Planning Mode flow file passed after the repair.
- Post-repair dashboard backfill shard 3/4: passed.
- `pnpm lint`, `pnpm typecheck`, `pnpm verify:fast`, `pnpm test:gate`, and `pnpm build`: passed.

The hosted reporter remains the authoritative proof of the original full-lane failures. The focused and shard results show the repair preserves the intended Stop → plan review → Refine → first-question and mobile generating reconciliation behavior without removing its coverage.
