---
title: FN-9486 dashboard Full Suite disposition
date: 2026-10-04
category: test-failures
---

# FN-9486: Dashboard Full Suite disposition

## Immutable source-run evidence

- Run: [37235853177](https://github.com/Runfusion/Fusion/actions/runs/37235853177), source `7bde93635639c5fb566c037ff84812c8ad46a456`, concluded `failure`. The retained manifest identifies the repository as `Runfusion/Fusion` and records Pipeline smoke as successful in 149357 ms (within its 175000 ms budget).
- Manifest artifact: [11315923679](https://github.com/Runfusion/Fusion/actions/runs/37235853177/artifacts/11315923679), `post-merge-full-suite-evidence`, created `2026-10-04T21:49:22Z`, expires `2026-10-18T21:49:21Z`, not expired when acquired. API digest: `sha256:dd9b1f4352b194fa50183ee3ca9acc17a6acfb5423e9f56bcc69bb567c435cc1`.
- Shard 1 timing artifact: [11315528729](https://github.com/Runfusion/Fusion/actions/runs/37235853177/artifacts/11315528729), `test-timings-shard-1`, created `2026-10-04T21:49:02Z`, expires `2026-10-18T21:49:01Z`, not expired. API digest: `sha256:5f945bf1b5294f724e14bf230c405f273d004c7f9a2cb65cb86bb38a64740999`.
- Shard 2 timing artifact: [11316535554](https://github.com/Runfusion/Fusion/actions/runs/37235853177/artifacts/11316535554), `test-timings-shard-2`, created `2026-10-04T21:41:58Z`, expires `2026-10-18T21:41:57Z`, not expired. API digest: `sha256:96f712658dc59c78b559b7557c4fc96c766ddac85f7d190a00df80a5de8fb824`.
- Shard 3 timing artifact: [11315652329](https://github.com/Runfusion/Fusion/actions/runs/37235853177/artifacts/11315652329), `test-timings-shard-3`, created `2026-10-04T21:38:58Z`, expires `2026-10-18T21:38:57Z`, not expired. API digest: `sha256:fb037c2968e93afbe2a25870f2cbd2c6b85d16bc91ae91a2849f5bc1a94a0e56`.
- Shard 4 timing artifact: [11316112088](https://github.com/Runfusion/Fusion/actions/runs/37235853177/artifacts/11316112088), `test-timings-shard-4`, created `2026-10-04T21:44:38Z`, expires `2026-10-18T21:44:37Z`, not expired. API digest: `sha256:7a99176a012f1b2105d0b7cdd82683a6da0cb1cb8fc13e28d48b0822905d6b7e`.

All five archives were downloaded through the authorized GitHub CLI and SHA-256 verified against the API digest before their manifest/reporter data was used. The timing artifacts retain canonical reporter names and shard assignment; the dashboard reporter does not retain individual assertion text in the manifest, so the focused source test below is the reproducible assertion evidence.

## Change boundary

The source commit is FN-9482. Its parent is `e49aadfdb685a2d9d10218df4808dd04ff3658eb`. The source commit changed dashboard test fixtures for a preceding, separate shard-4 disposition; it changed no production dashboard component or route in this ledger. `7bde936..df959f34` likewise had no dashboard-path diff before this task began. Therefore this cluster is not attributed to a dashboard production change adjacent to the source run; each row was reproduced against the unchanged implementation and classified at its own production or fixture boundary.

## Reporter ledger

The operator's label “14” reconciles to **14 reporter cases**: two parameterized model-menu cases, one sidebar case, one Planning Mode case, two Terminal Modal cases, one board-role case, two attachment cases, four tracking-dispatch cases, and one Hermes case. The five “board roles” surfaces described at intake are protected by the single artifact reporter case; they are not five independent artifact failures.

| # | Shard / source test | Reporter case | Classification | Disposition |
| --- | --- | --- | --- | --- |
| 1–2 | 1/4 — `model-menu-filter-host-dismissal.test.tsx` | `model-menu filter host dismissal keeps New Chat open after a false/true portal-origin filter gesture` | Stale test contract | New Chat now creates the configured session directly; it no longer opens this model dialog. Removed the obsolete direct-Chat assertion while retaining desktop/mobile portal-boundary coverage for ModelSelectionModal and the thinking popup. |
| 3 | 3/4 — `LeftSidebarNav.test.tsx` | `renders core destinations, enabled overflow destinations, plugins, and bottom settings` | Stale navigation assertion | The rendered canonical navigation includes Patchnode between List and Planning. The test now asserts it is present and ordered, rather than asserting the superseded direct List → Planning adjacency. |
| 4 | 3/4 — `PlanningModeModal.planning-flow.test.tsx` | `sequential flow keeps the newer session when delayed duplicate reconciliation returns 'a durable question' on 'mobile'` | Deterministic test interaction race | The test previously clicked an answer control immediately after hydration discovery. Under combined UI execution, hydration could replace that control before the click, so no submit occurred and the expected reconciliation fetch never began. It now uses the existing hydration-safe helper, preserving the same user interaction and assertion without a retry, timeout, or suppression. |
| 5–6 | 3/4 — `TerminalModal.test.tsx` | `gives tablet floating terminals a real touch drag grip without affecting other presentations`; `keeps a touch tablet at the 768px boundary floating, movable, and resizable` | Stale geometry expectations | Tests now assert the current clamped tablet geometry (including the floating-window edge margin) while retaining real touch drag, resize, tab, and 768px presentation checks. |
| 7 | 3/4 — `column-role-degraded-flags.test.ts` | `board surfaces resolve column roles per column, not per board ListView.tsx resolves per-task roles through the per-task accessor` | Confirmed product regression | `getTaskColumnFlags` read `taskContextMenuColumnsByTaskId` but omitted it from its callback dependencies. Added that dependency, so rerenders use a task's current workflow mapping rather than stale union data. |
| 8–9 | 4/4 — `routes-planning-issue-images.test.ts` | `attaches captured issue and comment images without reading GitHub again`; `keeps a created task when image download fails and warns for recorded partial capture` | Stale route fixture | The direct registrar mock omitted newly imported planning normalizers, causing route setup to fail before the attachment behavior. Added narrow identity/array normalizers; valid, failed-download, and partial-capture assertions remain intact. |
| 10–13 | 4/4 — `routes-planning-tracking.test.ts` | `returns before createIssue resolves`; `still returns 201 when createIssue rejects`; `still returns 201 when createIssue throws synchronously`; `preserves canonical GitHub source provenance and issue context on a planned task` | Stale route fixture | The same direct registrar mock omission prevented creation before the background hook could be observed. Added the current planning normalizer seams and retained deterministic deferred call observation, without polling or sleeps. |
| 14 | 4/4 — `register-model-routes-hermes.test.ts` | `keeps the existing row when a Hermes-derived id collides with an already-present row (existing row wins)` | Stale assertion shape | The existing registry row still wins; `/api/models` now decorates registry rows with `supportedThinkingLevels`. The collision assertion now includes its derived empty capability list instead of rejecting the additive response field. |

No case was classified as a flake. No retry, timeout increase, skip, exclusion, quarantine, or relaxed behavior assertion was used.

## Focused reproduction and result

The source run assigned all UI reporters to `dashboard-app-quality-backfill` and all API reporters to `dashboard-api-quality-backfill`.

- UI command: `pnpm --filter @fusion/dashboard exec vitest run --project dashboard-app-quality-backfill app/components/__tests__/model-menu-filter-host-dismissal.test.tsx app/components/__tests__/LeftSidebarNav.test.tsx app/components/__tests__/PlanningModeModal.planning-flow.test.tsx app/components/__tests__/TerminalModal.test.tsx app/__tests__/column-role-degraded-flags.test.ts --silent=passed-only --reporter=dot` — passed, 383 tests.
- ListView mapping-refresh regression: `pnpm --filter @fusion/dashboard exec vitest run --project dashboard-app-quality-backfill app/__tests__/column-role-degraded-flags.test.ts --silent=passed-only --reporter=dot` — passed, 12 tests. The production-rendered ListView test refreshes a task between workflows that reuse a column ID, then verifies that its Archive menu action is removed and its bulk-selection control becomes disabled when the updated workflow marks the column archived.
- API command: `pnpm --filter @fusion/dashboard exec vitest run --project dashboard-api-quality-backfill src/__tests__/routes-planning-issue-images.test.ts src/__tests__/routes-planning-tracking.test.ts src/__tests__/register-model-routes-hermes.test.ts --silent=passed-only --reporter=dot` — passed, 16 tests.

The focused result reruns every artifact-named reporter behavior through the real test files. It also proves the Planning Mode delayed-hydration interaction through the combined UI command, where the original second session fetch now occurs deterministically. Hosted artifact archives, downloaded ZIPs, and local run logs are intentionally not committed.

## Required quality gates

- `pnpm lint` — passed.
- `pnpm verify:fast` — passed.
- `pnpm build` — passed.

## Final outcome

One current product regression was repaired: ListView now reacts to changed task-to-workflow column mappings. The remaining reporter cases were stale tests, fixtures, or the Planning Mode test's deterministic delayed-hydration interaction race; no product behavior was weakened. No published-package behavior changed, so no changeset is required.
