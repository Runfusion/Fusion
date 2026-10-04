---
title: FN-9482 dashboard shard 4 disposition
date: 2026-10-04
category: test-failures
---

# FN-9482: Dashboard shard 4 post-landing disposition

## Immutable source-run evidence

- Run: [37230078833](https://github.com/Runfusion/Fusion/actions/runs/37230078833), **Test shard 4/4**, job `111517728687`.
- Source: `23eff4014623acff460cff0b064020a72cdc5c07` (`FN-9476`). The run started at `2026-10-04T19:54:59Z`, completed at `2026-10-04T20:34:29Z`, and concluded `failure`.
- Timing artifact: `test-timings-shard-4`, id `11314480248`, created `2026-10-04T20:14:15Z`, expires `2026-10-18T20:14:14Z`, size `451855` bytes, and was not expired when acquired.
- Artifact URL: `https://github.com/Runfusion/Fusion/actions/runs/37230078833/artifacts/11314480248`.
- GitHub reports digest `sha256:661411a898568d75b2195e35b7023466ae580a6ef879805b0620ef948aa64d44`. Authorized artifact download was SHA-256 verified against that value before parsing.
- The raw job log was acquired through the same authorized GitHub CLI session. It records the shard scheduler but does not retain the dashboard reporter blocks; the authenticated timing artifact is the authoritative reporter evidence for all rows below.

## Change boundary

`23eff401^..23eff401` changes only `.changeset`, an existing Full Suite disposition, engine worktree acquisition/pool source and tests, and an engine durable-write inventory fixture. It changes **no dashboard path**. `23eff401..464acd95` has no dashboard-path diff at this investigation start. Therefore no row is attributed to FN-9476 adjacency; each is reproduced and classified independently below.

## Reporter ledger

The first error line and duration are copied from the timing artifact. “Initial family” is a triage partition, not a causal conclusion; later sections replace it with a disposition.

| # | Reporter case | Duration | Terminal evidence | Initial family |
| --- | --- | ---: | --- | --- |
| 1 | `github-tracking-periodic-reconcile-sweep` — repeated archived-board diagnostics | 8.72 ms | `reconcileDeletedTasks` is not defined on the prototype | periodic-sweep fixture |
| 2 | `github-tracking-periodic-reconcile-sweep` — healthy archived rows | 0.66 ms | same missing prototype property | periodic-sweep fixture |
| 3 | `github-tracking-periodic-reconcile-sweep` — deleted-pass API diagnostics | 0.60 ms | same missing prototype property | periodic-sweep fixture |
| 4 | `github-tracking-periodic-reconcile-sweep` — startup/paged periodic sweep | 0.60 ms | same missing prototype property | periodic-sweep fixture |
| 5 | `plan-approval-status.pg` — exhausted split-column Plan Review | 805.02 ms | expected `triage`, received `in-review` | plan lifecycle |
| 6 | `register-git-github.review-lanes` — renamed review rebound | 10.85 ms | `store.getTask is not a function` | review transition fixture |
| 7 | `register-git-github.review-lanes` — v1 rebound | 0.80 ms | `store.getTask is not a function` | review transition fixture |
| 8 | `routes-task-planner-chat-session` — sidebar preview/filter | 20.09 ms | expected HTTP 200, received 500 | scoped chat route |
| 9 | `routes-task-retry-planning-column` — outside planning lane | 25.96 ms | expected status patch `null`, received `undefined` | retry assertion/fixture |
| 10 | `routes-task-retry-planning-column` — legacy triage planner | 3.46 ms | expected status patch `null`, received `undefined` | retry assertion/fixture |
| 11 | `routes-task-retry-planning-column` — stranded planning status | 2.35 ms | expected status patch `null`, received `undefined` | retry assertion/fixture |
| 12 | `routes-task-retry-planning-column` — v1 column-less workflow | 1.97 ms | expected status patch `null`, received `undefined` | retry assertion/fixture |
| 13 | `routes-task-retry-planning-column` — bespoke planning seam | 3.36 ms | expected `needs-replan`, received `undefined` | retry assertion/fixture |
| 14 | `routes-task-retry-planning-column` — all retryable statuses | 1.72 ms | expected status patch `null`, received `undefined` | retry assertion/fixture |
| 15 | `register-project-git-readiness` — remote-only integration branch | 203.70 ms | `git symbolic-ref -d refs/remotes/origin/HEAD` failed | real-git fixture cleanup |
| 16 | `register-task-workflow-routes.step-update` — checklist step update | 61.49 ms | mocked `updateStep` received additional arguments | route attribution fixture |
| 17 | `register-task-workflow-routes.unpause` — todo user pause | 58.15 ms | mocked unpause writer received additional arguments | route attribution fixture |
| 18 | `register-task-workflow-routes.unpause` — agent-assigned pause | 10.30 ms | same mocked writer argument mismatch | route attribution fixture |
| 19 | `workflow-setting-attribution` — imported settings restore | 196.10 ms | expected HTTP 201, received 500 | settings attribution route |

## Final causal dispositions

| Rows | Causal root | Disposition and regression proof |
| --- | --- | --- |
| 1–4 | The production reconciler method was deliberately renamed to `reconcileDeletedAndArchived`, but the periodic-sweep production-entry test still spied on the retired `reconcileDeletedTasks` name. | Updated the spy and paging assertions to the live three-pass method. The focused production sweep test passes all four cases. |
| 5 | Reject-plan recognizes that the split workflow plans in its configured review lane, so it does not rehome that card to intake before clearing the approval status. The test expected an obsolete partial move to the intake lane. | Updated the test’s interrupted and successful assertions to preserve the review lane while proving the approval status clears. The PostgreSQL production-entry test passes. |
| 6–7 | The external PR reconciliation path gained a required durable re-read to prevent a stale review observation from moving a completed task backward. The narrow store fake omitted `getTask`. | Added the live task to the fake and retained both renamed-board and v1 destination assertions. The production transition test passes. |
| 8 | The chat listing route uses `listSessions`; the fixture only implemented the obsolete paged helper and therefore returned 500 before exercising preview filtering. | Added the current store seam to the fixture. The real route test passes and still proves planner filtering and preview truncation. |
| 9–14 | Retry reset moved from a direct `updateTask` call to an atomic patch. The harness mutated task state but did not record that atomic patch, so it reported `undefined` rather than the actual reset decision. | The harness now records its atomic patch through its in-memory writer. All destructive and non-destructive planning retry cases pass. |
| 15 | A local-path clone may not create `refs/remotes/origin/HEAD`; deleting that already-absent symbolic ref made the fixture fail before Git-readiness behavior ran. | The setup now tolerates an absent ref while still proving remote-only `develop` materializes locally. The real-git route test passes. |
| 16–18 | Checklist and unpause writers now receive additional lifecycle options after their behavioral arguments (`operatorOverride` for step edits and an updated-at fence for unpause). Exact old-arity spy assertions failed despite correct state and HTTP responses. | Assertions preserve the action arguments while allowing the additive options tail. The route tests pass. |
| 19 | The imported built-in workflow IR exceeds Express’s default JSON request limit in the test app. The result was a request parser 500/413 surface, not an attribution failure. The unscoped PostgreSQL harness also lacked a project identity required by Patchnode initialization. | Bound the real harness to a project and configured the test app’s JSON parser for the valid export payload. The import route returns 201 and preserves the verified API actor assertion. |

All 19 source-run failures are deterministic stale-fixture or stale-assertion defects. None is a product regression, test flake, timeout, retry candidate, or FN-9476 effect. No quarantine, observed-flake register entry, exclusion, timeout change, retry, or assertion weakening was used.

## Reproduction and verification

Focused dashboard verification of the nine artifact-named files passed: **77 tests**. It includes the four periodic tracking cases, plan-approval PostgreSQL lifecycle case, review-lane cases, chat route, six planning retry cases, Git-readiness route, checklist/unpause routes, and workflow import attribution route.

- `pnpm lint` — passed.
- `pnpm verify:fast` — passed.
- `pnpm build` — passed.
- `pnpm test:ci:shard --shard 4 --total 4` — completed its repaired cluster but failed unrelated current-tree cases: five `task-reset-workspace-lifecycle` cases, one Hermes model-collision case, and one planning issue-image mock-export case. These files and roots are outside this task’s reporter set and its causal fixes; they were logged rather than hidden or changed here.

No published-package behavior changed, so no changeset was created.

The source log, downloaded ZIP, extracted JSON, and local reporter outputs are ignored local evidence and are intentionally not committed.
