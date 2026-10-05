---
title: FN-9508 Full Suite shard 1 disposition
date: 2026-10-05
category: test-failures
---

# FN-9508: Full Suite shard 1 disposition

## Source evidence

- Full Suite run: [37316652223](https://github.com/Runfusion/Fusion/actions/runs/37316652223), head `c39b33d49ba7fba0a52f73d316e53d09760f697f`, terminal conclusion `failure`.
- Shard job: [Test shard 1/4](https://github.com/Runfusion/Fusion/actions/runs/37316652223/job/111784963628), job ID `111784963628`, terminal conclusion `failure`. Its `Test (deterministic shard)` step failed from `2026-10-05T13:30:02Z` through `2026-10-05T13:42:45Z`; the timing upload succeeded immediately afterward.
- Timing artifact: `test-timings-shard-1`, artifact ID `11348597681`, created `2026-10-05T13:42:47Z`, 344,544 bytes, GitHub digest `sha256:e3a3d3b6e5f63080a8ded4f82aaab06f1d96a9baaa98d67d26e1e6f44126cc89`.
- Acquisition: an authorized GitHub Actions API channel downloaded the job log and archive. The downloaded ZIP SHA-256 exactly matched the published digest. The temporary archive and log were deleted after bounded inspection and were never staged.

The job ran `pnpm test:ci:shard --shard 1 --total 4`. The failing virtual engine slice was:

```text
pnpm --filter @fusion/engine test --shard=1/2
```

## Reporter ledger

All five JSON reports parsed successfully. No report was malformed or duplicated.

| Report path | Suites | Assertions | Failed assertions | Disposition |
| --- | ---: | ---: | ---: | --- |
| `.timings/timings-shard1-diagnostic.json` | 0 | 0 | 0 | Wrapper diagnostic only |
| `packages/droid-cli/.timings/timings-shard1-0.json` | 12 | 232 | 0 | Passed |
| `packages/engine/.timings/timings-shard1-1.json` | 564 | 7,160 | 0 | Passed assertions, one unhandled rejection |
| `plugins/examples/fusion-plugin-ci-status/.timings/timings-shard1-0.json` | 1 | 24 | 0 | Passed |
| `plugins/fusion-plugin-droid-runtime/.timings/timings-shard1-0.json` | 8 | 44 | 0 | Passed |

The engine report records 563 passed files, one skipped file, 7,147 passed tests, 13 skipped tests, and one error. The job log identifies that error as:

- `ResearchProviderError: Search aborted`
- Origin: `WebSearchProvider.withHttpRetry` during `ResearchOrchestrator.runSearching`
- Associated test file: `packages/engine/src/__tests__/project-engine.test.ts`
- Latest active test: `ProjectEngine research recall composition > persists finalized research through ProjectEngine's live recall composition`

## Attribution

The recall-composition test created a persisted research run before calling `ProjectEngine.start()`. New research runs are queued by default, and the real `ResearchRunDispatcher` immediately dispatches queued runs on engine startup. The test then directly exercised the finalization seam while the dispatcher could independently begin a real web-search phase. On teardown, dispatcher cancellation aborted that search; Vitest retained the resulting unhandled rejection and returned exit code 1 even though every assertion passed.

This was a fixture lifecycle defect, not a watchdog failure and not a provider or product-search failure. The fixture's purpose is to test finalization-to-recall persistence, not queued research execution. It now marks its created run `running` before startup, which makes it ineligible for the dispatcher while preserving the production dispatcher contract and its dedicated queued-run tests.

## Diagnostic boundary

The wrapper diagnostic is accurate but intentionally incomplete:

```json
{
  "stage": "test-command",
  "exitCode": 1,
  "signal": null,
  "timedOut": false,
  "testResults": []
}
```

`exitCode: 1` with `timedOut: false` proves that the child test command failed normally rather than that the watchdog timed out. The empty `testResults` array is a fallback diagnostic and proves neither a failed assertion nor a flake. The retained engine JSON report plus the authorized job log supplied the missing attribution.

## Repair and verification

- Updated `project-engine.test.ts` so the direct-finalization fixture marks its run `running` before `ProjectEngine.start()`.
- Focused recall-composition verification passed with the real PostgreSQL-backed test harness.
- Focused `project-engine.test.ts` plus `research-dispatcher.test.ts` verification passed. The latter retains direct coverage that the dispatcher starts queued runs, so the fixture fix does not suppress that production behavior.
- The artifact-named engine shard command was invoked once locally after the repair. The local verification host ended it by signal after 742 seconds without a Vitest failure summary; it was not retried. This host-side termination is not cited as a passing reproduction.

No quarantine, retry, timeout adjustment, skipped test, or assertion relaxation was used.
