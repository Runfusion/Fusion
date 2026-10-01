---
title: Full Suite stale-test debt census
category: test-failures
---

# Full Suite stale-test debt census

## Evidence and parser

This record uses Full Suite timing artifacts, not raw text search. The source runs are:

- Baseline: `36102810042` (2026-09-25)
- Pre-repair census: `36541404695` (2026-09-29)

Artifacts were downloaded with `gh run download -R Runfusion/Fusion <run-id> -n test-timings-shard-N -D <directory>` for every shard 1 through 4. The parser walks each JSON report and includes an entry only when `assertionResult.status === "failed"`. Its identity key is `${testResult.name}::${assertionResult.fullName}`, which preserves the reporter file and deduplicates repeated reports.

| Census | Unique failed keys | Newly failed vs. baseline | Fixed vs. baseline |
| --- | ---: | ---: | ---: |
| `36102810042` | 233 | 0 | 0 |
| `36541404695` | 225 | 0 | 8 |
| `36562243319` (`7d5e1dccca`) | 188 | 0 | 45 |
| FN-9421 projected first-cluster result | 188 | 0 expected | 45 expected |

The latest pre-repair package distribution is 211 engine, 12 core, and 2 CLI failures. The four selected engine files account for 37 failures: 11 validator, 10 post-landing cleanup, 8 merge-abort, and 8 workflow-graph topology assertions.

## Repaired clusters

| Cluster | Former stale contract | Current observable contract | Root-cause behavior change | Repair |
| --- | --- | --- | --- | --- |
| `mission-validator-behavioral-posture.test.ts` (11) | `completeValidatorRun` was treated as a three-argument call whose return did not control later effects. | Completion supplies the effects argument and must return `completionApplied`; pass, fail, blocked, static, behavioral, and mixed paths retain their distinct outcomes. | `8b7373fab5b` made completion effects and `completionApplied` authoritative. | The shared mission-store fake records and atomically applies assertion effects only after a confirmed completion. The tests assert exact status-specific assertion effects, failed diagnostic payloads, and that declined pass/fail completions leave assertions pending and emit neither pass nor remediation side effects. |
| `post-landing-worktree-cleanup.test.ts` (10) | A confirmed merge alone could complete the fixture through `moveTask`. | A default-on post-merge gate needs an approval result, and final terminal movement is fenced with `moveTaskIf` plus atomic reconciliation. | `f772db2c901` introduced post-merge evidence gating; `0c5f98ec7af` strengthened finalization movement. | The shared finalization fixture includes durable merge proof and an approved post-merge result, implements the conditional/atomic store seams, and asserts cleanup precedes the conditional terminal move. |
| `merge-abort-clears-transient-status.test.ts` (8) | Prototype engines omitted retry-reset queue fields added to the live merge pump. | All transient stamps are cleared by the live abort path before a successor owns the lane. | `706c155609e` added retry-reset enqueue deferral. | `seedMergeLaneState` initializes both required retry-reset sets, so abort and successor tests execute the production queue path. |
| `workflow-graph-merge-region-collapse.test.ts` (8) | Success topology stopped at the post-merge optional-group node. | Successful traversal includes `post-merge-verification::post-merge-verification-step`, while dispatching exactly one synthetic merge node and no raw merge primitives. | The built-in workflow’s post-merge optional-group traversal; compare the current built-in workflow IR and `workflow-graph-executor-retry-coding-workflow.test.ts`. | The shared `SUCCESS_PATH` includes the nested step for built-in and direct merge-region entry coverage. |
| `merger-verification.test.ts` (7) | Six verification successes expected an unconditional direct `moveTask`, and the fix-agent assertion omitted real callback detail. | Every direct merger success enters the shared evidence-gated finalizer; approved evidence permits its fenced `moveTaskIf`, while non-approval remains in review. Fix-agent text, thinking, tool-start, and tool-result records retain their actual durable shapes. | `completeTask` had not adopted the `finalizeProvenAutoMergeTask` contract introduced for post-merge evidence. | The shared fixture carries merge proof, approved evidence, conditional/atomic finalization seams, and a non-approval regression. The callback case asserts actual persisted records and rerun lifecycle. |

These changes update assertions to current observable contracts. No timeout, retry, skip, quarantine, merge-gate allow-list, or engine-core membership was changed.

## Reproduction and verification

The repaired symptom is exercised with:

```text
pnpm --filter @fusion/engine exec vitest run src/__tests__/reliability-interactions/mission-validator-behavioral-posture.test.ts src/__tests__/post-landing-worktree-cleanup.test.ts src/__tests__/merge-abort-clears-transient-status.test.ts src/__tests__/workflow-graph-merge-region-collapse.test.ts --silent=passed-only --reporter=dot
```

It passes 75 assertions after the repair. This validates the production validator loop, auto-merge finalizer, ProjectEngine merge queue, and workflow graph executor rather than source text.

The next artifact clusters reproduced and deliberately not patched in the FN-9421 change were `merger-verification.test.ts` (7), `ce-workflow-step-executor.test.ts` (6), and `graph-node-missing-worktree-recovery.test.ts` (6). FN-9424 repaired the merger-verification cluster; the two worktree-recovery clusters remain distinct and out of scope.

## Post-landing census

Push Full Suite run [`36562243319`](https://github.com/Runfusion/Fusion/actions/runs/36562243319) at `7d5e1dccca` is the first complete push-to-main census after FN-9421. The workflow and all four timing artifacts completed; Test shards 1/4, 2/4, 3/4, and 4/4 each concluded `failure`. Downloading and inspecting `test-timings-shard-1` through `test-timings-shard-4`, then retaining only `assertionResult.status === "failed"` and keying by `${testResult.name}::${assertionResult.fullName}`, yields 188 normalized failed keys.

That is 45 fewer than baseline run `36102810042` (233) and 37 fewer than pre-repair run `36541404695` (225). The package distribution is 173 engine, 12 core, and 3 CLI failures. No engine or core failure name is new. The sole new CLI name is `skills-get.test.ts`; it is already tracked by FN-9423 in observed-flake register entry 19, so this census does not change that register.

The seven `merger-verification.test.ts` failures were deliberately deferred from FN-9421 and are repaired by FN-9424. The other 181 residual failures, `ce-workflow-step-executor.test.ts`, `graph-node-missing-worktree-recovery.test.ts`, Pipeline smoke, and register entries 2, 13, 18, and 19 remain outside this implementation scope. Hosted artifact evidence—not local verification or raw-text failure counts—remains the required source for this census.
