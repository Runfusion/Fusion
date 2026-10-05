---
title: FN-9492 Planning Mode mobile tabs disposition
date: 2026-10-05
category: test-failures
---

# FN-9492: Planning Mode mobile tabs disposition

## Retained run evidence

- Full Suite run: [37254176496](https://github.com/Runfusion/Fusion/actions/runs/37254176496), source `eae083bac6b284dce310f4da58b66a9a307ab203`, concluded `failure` on 2026-10-05.
- Post-merge artifact: [11322602369](https://github.com/Runfusion/Fusion/actions/runs/37254176496/artifacts/11322602369), `post-merge-full-suite-evidence`, created `2026-10-05T02:36:03Z`, digest `sha256:ebc84795251e58eddc88ba5760576ff4abfb98e3919f2cad83024066cb6444ff`.
- The artifact was downloaded through the GitHub API and its SHA-256 digest was verified before use. Its shard-3 dashboard timing report recorded 176 results and one failed reporter: `PlanningModeModal sequential flow uses full-view Questions and Plan preview tabs on mobile`.
- The GitHub-hosted `Test shard 3/4` job ran from `2026-10-05T02:08:16Z` through `2026-10-05T02:23:49Z`. Its deterministic-shard step ran from `2026-10-05T02:14:04Z` through `2026-10-05T02:23:44Z`; the runner group was GitHub Actions. The retained manifest does not include raw assertion output or secret-bearing environment values.

## Reproduction and attribution

The shard command is `pnpm test:ci:shard --shard 3 --total 4`; the dashboard reporter is assigned to the `dashboard-app-quality-backfill` Vitest project. Before the repair, the isolated reporter command passed in 5.0 seconds:

```text
pnpm --filter @fusion/dashboard exec vitest run --project dashboard-app-quality-backfill app/components/__tests__/PlanningModeModal.planning-flow.test.tsx --testNamePattern="uses full-view Questions and Plan preview tabs on mobile" --silent=passed-only --reporter=dot
```

This was classified as a deterministic test interaction ordering defect, not a product or execution-environment defect. `loadSession()` hydrates a resumed awaiting-input session by setting the running summary, workspace question, and question view. The mobile effect keyed by `isMobile` and `workspaceQuestion?.id` then resets the tab to Questions. `findByTestId("planning-workspace")` may return the preceding hydration render; cached workspace or tab nodes can therefore be replaced before the click is dispatched in a loaded shard.

The repair explicitly settles that React commit with `act`, then reacquires the workspace and both tab controls from the live DOM. It retains strict assertions that Questions begins selected; Plan preview becomes selected while Questions becomes unselected; the live workspace presents the plan pane and loaded summary; and the empty History region opens and closes. It adds no retry, polling, sleep, timeout increase, skip, quarantine, exclusion, worker change, or relaxed assertion.

## Verification

All commands ran at the repaired worktree head:

- Focused reporter under `dashboard-app-quality-backfill` — passed in 3.9 seconds.
- Full `PlanningModeModal.planning-flow.test.tsx` under `dashboard-app-quality-backfill` — passed in 7.0 seconds.
- `PlanningModeModal.css.test.ts` under `dashboard-app-quality-backfill` — passed in 1.1 seconds.
- `PlanningModeModal.ui-interactions.test.tsx` under `dashboard-app-quality-backfill` — passed in 4.0 seconds.
- `pnpm lint` — passed in 27.1 seconds.
- `pnpm verify:fast` — passed in 160.5 seconds.
- `pnpm build` — passed in 66.4 seconds.

No production component or CSS change was required. Existing production-rendered coverage continues to protect the mobile Review plan round trip, populated and empty history, plan-only resumes, and desktop/two-pane CSS contracts. The test fixture now interacts only with the post-hydration controls that represent the user-visible state.
