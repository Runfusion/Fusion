---
category: test-failures
module: ci
status: resolved-investigation
tags:
  - full-suite
  - github-actions
  - timing-artifacts
  - fn-9477
---

# FN-9478: Full Suite shard-3 disposition

## Scope and evidence boundary

This record investigates the push-to-`main` Full Suite run for FN-9477, not the earlier FN-9475 ledger. The source revision is `34019eff19db50266373769a53d485eefde946d4`; its parent is `58244ab3c56abf2003cb6c21d447b7ef30af8401`. Its diff changes only the Meta Muse `ProviderIcon` implementation and test, a CSS token use, a changeset, and FN-9477 documentation. It does not modify `packages/core`, `packages/engine`, shard scheduling, or the workflow.

- Source run: [37229329030](https://github.com/Runfusion/Fusion/actions/runs/37229329030)
- Workflow: `Full Suite (non-blocking)`; event `push` on `main`; attempt `1`
- Created: `2026-10-04T19:42:54Z`; observed final state: `2026-10-04T20:07:18Z`
- Run conclusion: `failure`. This is post-merge, non-blocking signal; it is not a merge-gate result.
- Observation time: `2026-10-04T20:07:18Z` (GitHub Actions API).

## Shard-3 causal finding

**Confirmed fact:** shard 3 failed because the `@fusion/core` Vitest invocation recorded one failed assertion. The initial claim that artifact `11313339359` contained zero failures was incorrect.

The [shard-3 job](https://github.com/Runfusion/Fusion/actions/runs/37229329030/job/111515476238) completed `failure` at `2026-10-04T19:59:11Z`. GitHub marks `Build reconciled workspace artifacts` successful, `Test (deterministic shard)` failed, and the always-run timing upload successful. The current GitHub job-log download exposes the normal command stream but does not include the terminal core failure block, so this record does not infer a generic GitHub exit-code annotation as a root cause. The retained reporter artifact supplies the exact failed test and failure message.

- Failing invocation: `pnpm --filter @fusion/core test --shard=1/2 --reporter=json --outputFile.json=.timings/timings-shard3-1.json`.
- Failing test: `core task:updated emit surface registers every direct and safe production producer` in `packages/core/src/__tests__/task-updated-lanes-emit-surfaces.test.ts:75`.
- Exact reporter condition: the discovered producer list contains `packages/core/src/agents/agent-store.ts`, while the `PRODUCERS` inventory omits it; Vitest reports `AssertionError: expected [ …(16) ] to deeply equal [ 'packages/core/src/store.ts', …(14) ]`.
- `scripts/ci-test-shard.mjs` runs each command through `runWatched`. A nonzero child code exits with that code; timeout would emit `FAILED (timeout)` and exit `124`, while a signal would emit `FAILED (signal ...)` and exit `1`. No timing, signal, setup, reporter-write, or command-outside-Vitest cause is evidenced here.
- The source has the unregistered safe producer in `packages/core/src/agents/agent-store.ts`; it was introduced by ancestor commit `d5795d86bb` (FN-9474), before FN-9475 and FN-9477. FN-9477's ProviderIcon-only diff cannot be the cause.

### Verified timing artifact census

Artifact [11313339359](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11313339359) is `test-timings-shard-3`, 266,554 bytes, retained until `2026-10-18T19:59:05Z`; archive: <https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11313339359/zip>. GitHub supplies digest `sha256:b41ec069e80f2d524e81b25d1405772b3beae3b658c69313e0dace601a349d55`, which matched the downloaded archive SHA-256.

| Reporter package | Reporter file | Test-suite results | Assertion results | Failed assertions | State |
| --- | --- | ---: | ---: | ---: | --- |
| `@runfusion/fusion` | `packages/cli/.timings/timings-shard3-0.json` | 174 | 2,172 | 0 | valid, successful |
| `@fusion/core` | `packages/core/.timings/timings-shard3-1.json` | 339 | 3,515 | 1 | valid, failed |
| `@fusion/pi-llama-cpp` | `packages/pi-llama-cpp/.timings/timings-shard3-0.json` | 2 | 7 | 0 | valid, successful |
| settings demo | `plugins/examples/fusion-plugin-settings-demo/.timings/timings-shard3-0.json` | 1 | 25 | 0 | valid, successful |
| Cursor runtime | `plugins/fusion-plugin-cursor-runtime/.timings/timings-shard3-0.json` | 10 | 64 | 0 | valid, successful |
| **Total** | **5 files** | **526** | **5,783** | **1** | **0 corrupt or incomplete reports** |

This artifact proves an assertion failure, rather than a watchdog, runner, or setup failure. It is not evidence that every command in the job passed.

### Focused reproduction

At the current equivalent containing the source condition, the owning core test was run with `pnpm --filter @fusion/core exec vitest run src/__tests__/task-updated-lanes-emit-surfaces.test.ts --silent=passed-only --reporter=dot`. It failed with the same inventory mismatch: received `packages/core/src/agents/agent-store.ts` and expected inventory without it. The test has one structural failure and 13 passing integration tests. This confirms a deterministic pre-existing test-inventory defect, not a FN-9477 ProviderIcon regression.

## Final source-run lane disposition

No rerun was needed: GitHub reached a terminal source-run record, all four shard artifacts uploaded, and the post-merge evidence gate normalized them. The source-run conclusion remains failure because all four deterministic shard jobs failed; successful downstream normalization does not turn those lanes green.

| Lane | Job / conclusion | Time | Evidence and disposition |
| --- | --- | --- | --- |
| Shard 1/4 | [111515476244](https://github.com/Runfusion/Fusion/actions/runs/37229329030/job/111515476244), `failure` | `2026-10-04T20:03:23Z` | `test-timings-shard-1` has 3 valid reports, 7,177 assertions, and 2 failures in `@fusion/engine`. This is a terminal failing lane, not an absent artifact. |
| Shard 2/4 | [111515476284](https://github.com/Runfusion/Fusion/actions/runs/37229329030/job/111515476284), `failure` | `2026-10-04T20:04:39Z` | `test-timings-shard-2` has 5 valid reports, 7,347 assertions, and 4 failures in `@fusion/engine`. This is a terminal failing lane. |
| Shard 3/4 | [111515476238](https://github.com/Runfusion/Fusion/actions/runs/37229329030/job/111515476238), `failure` | `2026-10-04T19:59:11Z` | Exact deterministic core inventory failure documented above. |
| Shard 4/4 | [111515476296](https://github.com/Runfusion/Fusion/actions/runs/37229329030/job/111515476296), `failure` | `2026-10-04T20:07:03Z` | `test-timings-shard-4` has 26 valid reports, 9,623 assertions, and 19 failures, primarily in dashboard test surfaces. The FN-9477 `ProviderIcon.test.tsx` report is present and every Meta Muse assertion passed. |
| Pipeline smoke | [111515476210](https://github.com/Runfusion/Fusion/actions/runs/37229329030/job/111515476210), `success` | `2026-10-04T19:52:55Z` | `pipeline-smoke-report` reports 21 expected scenarios, 41 invocations, and `passed: true`. |
| Dashboard curated-gate guard | [111515476264](https://github.com/Runfusion/Fusion/actions/runs/37229329030/job/111515476264), `success` | `2026-10-04T19:43:35Z` | Terminal successful inventory guard. |
| Post-merge Full Suite evidence gate | [111520021699](https://github.com/Runfusion/Fusion/actions/runs/37229329030/job/111520021699), `success` | `2026-10-04T20:07:17Z` | Downloaded and normalized all required shard and pipeline artifacts into `post-merge-full-suite-evidence`; its manifest retains producer conclusion `failure` for test shards and `success` for pipeline smoke. |

### Artifact ledger

All archive digests below were verified against the GitHub-provided SHA-256 value. No source-run shard or normalized-evidence artifact is missing in the final inventory.

| Artifact | API / archive | Digest | Size and expiry |
| --- | --- | --- | --- |
| `test-timings-shard-1` | [11312724376](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11312724376) / [zip](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11312724376/zip) | `sha256:d39ce66c3a24f905c2b2b03bd4e3d4973cb7d1f98f62a3f433972b34830aa661` | 333,046 bytes; `2026-10-18T20:03:20Z` |
| `test-timings-shard-2` | [11313940668](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11313940668) / [zip](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11313940668/zip) | `sha256:b5985ce922024d10c7e6d57e9d598b40ce599dbf7d9c453daf2528260b1f39a3` | 346,818 bytes; `2026-10-18T20:04:37Z` |
| `test-timings-shard-3` | [11313339359](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11313339359) / [zip](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11313339359/zip) | `sha256:b41ec069e80f2d524e81b25d1405772b3beae3b658c69313e0dace601a349d55` | 266,554 bytes; `2026-10-18T19:59:05Z` |
| `test-timings-shard-4` | [11313514263](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11313514263) / [zip](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11313514263/zip) | `sha256:d4d9b18e2c80e90f83c0af30e139f0a63d6b0fe535de5559304e62bfd2068e75` | 452,450 bytes; `2026-10-18T20:06:57Z` |
| `pipeline-smoke-report` | [11312753420](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11312753420) / [zip](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11312753420/zip) | `sha256:ddc0d2bb757df4cf24a03a20a546ccb6a1fc441f3ffad37e6c11a8dbe4a055bd` | 1,535 bytes; `2026-10-18T19:52:52Z` |
| `post-merge-full-suite-evidence` | [11313816235](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11313816235) / [zip](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11313816235/zip) | `sha256:33bc1d49f8563180f91a4a8e3bbac7f16e094552dc973aa649eae5ec67d3b4b6` | 2,358 bytes; `2026-10-18T20:07:15Z` |

## Attribution

- **FN-9477:** ruled out for the exact shard-3 failure. Its full ProviderIcon test file, including four Meta Muse assertions, passed in shard 4. Its diff has no overlap with the core inventory test or producer.
- **Shard-3 root:** confirmed pre-existing deterministic test/fixture drift. The producer was added by FN-9474 without the inventory entry. This needs independent repair; it was not repaired in this forensic task.
- **Shards 1, 2, and 4:** confirmed terminal test failures, but not attributed to FN-9477. Their artifacts name the failed tests; their broader causal roots require separately scoped investigation rather than inference from a ProviderIcon-only commit.
- **Infrastructure:** no runner, watchdog, setup, registry, or artifact-corruption failure is established for shard 3. The pipeline smoke and evidence gate successes further show that artifact handling completed normally.

Facts above come from GitHub's run, job, artifact, and normalized-evidence APIs. The unexposed terminal shard-3 log block is an evidence limitation, not a hypothesis that changes the reporter-backed conclusion.

## Required follow-up handoff

The confirmed safe-producer inventory defect requires an independent repair task. This execution session cannot create or delegate follow-up tasks, so its completion recommendation is the durable task-intake handoff rather than a fabricated task ID.

- Recommendation ID: `fn-9478-safe-producer-inventory`
- Causal evidence and source SHA: shard-3 artifact `11313339359` at `34019eff19db50266373769a53d485eefde946d4` records the omitted `packages/core/src/agents/agent-store.ts` producer.
- File and test surface: `packages/core/src/agents/agent-store.ts` and `packages/core/src/__tests__/task-updated-lanes-emit-surfaces.test.ts`.
- Required regression scenario: enumerate direct and safe production task-update producers through the real inventory test and assert that the safe `agent-store.ts` producer is included.

## Local verification

- `pnpm test:scripts -- scripts/__tests__/ci-test-shard-timings.test.mjs`: passed after pruning three stale paths for deleted tests from `scripts/test-timings.json`. This was a deterministic committed-snapshot validation failure discovered by the mandated check; it did not alter shard scheduling or CI behavior.
- `pnpm verify:fast`: passed.
- `pnpm build`: passed.
- `pnpm lint`: passed.
- `pnpm typecheck`: passed.

## Delivery

The complete evidence summary is also persisted as the FN-9478 task document `docs`. No changeset is included because this investigation and timing-snapshot cleanup do not change published-package behavior.
