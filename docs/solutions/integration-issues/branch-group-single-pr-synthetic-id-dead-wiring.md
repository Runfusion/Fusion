---
title: "Branch-group single-PR flow silently broken: synthetic IDs, mock-masked wiring, fake state"
date: 2026-06-03
category: integration-issues
module: branch-groups
problem_type: integration_issue
component: development_workflow
symptoms:
  - "Shared groups never reach complete/finalized: listTasksByBranchGroup(group.id) returns [] because entry points stamped synthetic planning:<id>/mission:<id> strings, not the stored BG- row id"
  - "Promote route throws \"promoteBranchGroup is not available on engine\" in production while its test passes (the test mocked the non-existent method)"
  - "prState shows \"open\" while prNumber/prUrl are null — the state field was flipped without ever calling GitHub"
  - "Route and engine disagree on the landed/complete predicate (one branch-anchored, one column-only), a data-loss hazard"
root_cause: wrong_api
resolution_type: code_fix
severity: critical
related_components:
  - tooling
  - testing_framework
tags:
  - branch-groups
  - single-pr
  - synthetic-id
  - mock-masking
  - dependency-injection
  - github-pr
  - planning
  - mission
---

# Branch-group single-PR flow silently broken: synthetic IDs, mock-masked wiring, fake state

## Problem

The branch-group → single managed PR flow (planning/mission tasks land on one shared branch, then one GitHub PR is created and managed) was broken end-to-end while CI stayed green: groups never completed, the dashboard promote route reached a method that didn't exist, and `prState` reported an open PR that was never created. Fixed in PR #1357.

## Symptoms

- Shared groups never reached `complete`/`finalized` — `listTasksByBranchGroup(group.id)` returned `[]` because entry points stamped synthetic `planning:<sessionId>` / `mission:<missionId>` strings into `branchContext.groupId` while the stored row id was a generated `BG-…`; no primary-key lookup could resolve them.
- `POST /api/branch-groups/:id/promote` threw `"promoteBranchGroup is not available on engine"` (`packages/dashboard/src/routes/register-integrated-routers.ts`) — the route invoked `engine.promoteBranchGroup(groupId)` as a method, but only a standalone coordinator function existed.
- `prState: "open"` with `prNumber`/`prUrl` null — promotion flipped the state field without performing the side effect, so dashboards *looked* correct.
- The route's `isMemberLanded` required `mergeConfirmed` + matching `mergeTargetBranch`; the coordinator's `evaluateBranchGroupCompletion` accepted bare `column === "done"` and never checked the branch — the two gates could disagree, and a member merged onto a sibling branch could count as "landed" (the failure class behind the 2026-05-23 lost-work incident).

## What Didn't Work

- **Trusting the green test suite.** `routes-branch-groups.test.ts` mocked the missing engine method with `vi.fn(async () => ({ prNumber: 202, ... }))` and asserted the mock was called — fabricating an API that never existed on `ProjectEngine`. The test passed; production threw.
- **Reading the state fields.** `prState` was written independently of PR creation, so every read surface (dashboard, API, CLI) reported a healthy PR pipeline that did not exist.
- **Assuming the documented contract held.** `docs/missions.md` ("Shared branch-group invariant") and `docs/architecture.md` (FN-5830) describe the intended `branchContext.groupId → branch_groups` resolution and "idempotent promoteBranchGroup (single shared→default merge/PR)" — the implementation silently diverged from both until #1357.

## Solution

Four core fixes (commits `66ca583`…`f3bc757` on PR #1357):

1. **Capture and stamp the real `BG-` id.** Entry points called `ensureBranchGroupForSource(...)` for its side effect and discarded the returned row. Bind it:

   ```ts
   // before — return value discarded, synthetic string stamped into branchContext
   this.taskStore.ensureBranchGroupForSource("mission", missionId, {...});
   // ...branchContext built with groupId: `mission:${missionId}`

   // after — bind the returned row's id
   const group = this.taskStore.ensureBranchGroupForSource("mission", missionId, {...});
   missionGroupId = group.id;   // the real BG- id, spread into branchContext only when a group exists
   ```

   Same pattern at both planning entry points (`register-planning-subtask-routes.ts`). Non-shared members now carry **no** `groupId` at all (it became optional) so they can't be swept into a group by the legacy fallback.

2. **Real engine bridge method + de-mocked test.** Added `ProjectEngine.promoteBranchGroup(groupId)` delegating to the standalone coordinator (no duplicated logic). The test now guards the wiring instead of masking it:

   ```ts
   expect(typeof (ProjectEngine.prototype as { promoteBranchGroup?: unknown }).promoteBranchGroup).toBe("function");
   ```

   plus a test that binds the *real* method body to a stub context and drives the route through it.

3. **Real PR creation via injected callbacks.** `CreateGroupPrFn` / `SyncGroupPrFn` types are defined in `packages/engine/src/group-merge-coordinator.ts` and injected from the CLI composition layer (mirroring the existing `processPullRequestMerge` DI seam) — the engine never imports the dashboard's GitHub client. The two callbacks serve different paths: `createGroupPr` runs during promotion; `syncGroupPr` runs on the separate member-landing path (and on-read reconciliation), not during the promote call. Wired at **all three** engine-construction sites (`daemon.ts`, `serve.ts`, `dashboard.ts`); missing one site gives that entry point divergent behavior. Idempotency keys on the persisted `prNumber` with open-PR-only reuse; on GitHub failure the code does **not** flip `prState` ("do NOT flip prState to a lie") — the error surfaces and idempotent re-promotion retries.

4. **Canonical predicates in `@fusion/core`.** `isBranchGroupMemberLanded` / `isBranchGroupComplete` (`packages/core/src/branch-group-completion.ts`) are consumed by both the route and the coordinator. The stricter branch-anchored semantics won: landed iff `mergeConfirmed && mergeTargetSource === "branch-group-integration" && mergeTargetBranch === group.branchName`.

## Why This Works

- **Identity must be the stored row's id, not a re-derivable string.** Only `ensureBranchGroupForSource` knows the real `BG-` id; discarding its return value guarantees every downstream primary-key lookup misses.
- **Wiring must be proven by a real-method test.** A `vi.fn()` named like the method proves nothing about the method existing; asserting on the real prototype makes the wiring load-bearing.
- **State fields that mirror an external side effect must be written only by the path that performs it.** `prState: "open"` written independently of PR creation is structurally a lie.
- **Predicates shared, not duplicated.** Two copies of "is this landed?" drift; one function in core consumed by every gate cannot.

## Prevention

- **Never discard the return value of an `ensure*`/`create*` store method when stamping a reference.** Bind the returned row's `.id`; never reconstruct a synthetic key.
- **Before mocking an engine/service method in a test, assert it exists on the real prototype** — or better, bind the real method to a stub context and drive it. A mock of a non-existent method is a permanent false-green.
- **Only write side-effect-mirroring status fields from the code path that performs the side effect.** Never flip them speculatively "so the UI looks right."
- **Extract shared predicates to the core package** when a route and an engine make the same decision.
- **For cross-package capabilities, use the injected-callback DI seam** (define `XxxFn` types in the lower package, inject from the composition layer) and **audit every construction site together** — a capability wired at only some sites produces entry-point-dependent bugs no single test catches.

## Related Issues

- PR #1357 — the fix (branch `gsxdsm/taskbranch`)
- Issue #1259 (FN-5830) — the incomplete re-land of the completion gate + promotion API that this corrects; Issue #1227 (FN-5788) — the promotion-hook predecessor
- `docs/incidents/2026-05-23-lost-work-tasks.md` — same failure family (silent merge-target/landing-attribution bugs); the branch-anchored landed predicate here closes a gap from that incident
- `docs/missions.md` ("Shared branch-group invariant across entry points") and `docs/dashboard-guide.md` ("Shared branch groups", single group-level PR contract) — the intended contracts the implementation diverged from
- `docs/architecture.md` FN-5782/5788/5830/5846 block — the canonical branch-group merge-routing narrative this fix repairs
- Known follow-up: 2 pre-existing failures in `shared-branch-group-entry-points.test.ts` (per-task-derived working-branch derivation) are a separate bug, untouched by this fix (auto memory [claude])
