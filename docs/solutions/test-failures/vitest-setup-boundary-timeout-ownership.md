---
category: test-failures
module: testing
date: 2026-08-17
problem_type: lifecycle_timeout_ownership
component: Vitest setup boundaries
severity: medium
applies_when:
  - "Considering work before PostgreSQL test execution"
tags:
  - vitest
  - timeouts
  - postgres
---

# Vitest setup-boundary timeout ownership survey

FN-9139's stdout-marker survey could not distinguish an unrelated failure from a timeout, used two files with two workers, ordered fork output by line position, and treated completion under a generous budget as off-budget evidence. FN-9140 replaces it with a connectionless temporary fixture that appends JSONL ledger events, repeats every cell, and applies a falsifying four-arm budget matrix.

## Scoped runner and matrix

The attempted run used Vitest **4.1.10**, Node **v26.3.0**, `pool: "forks"`, 2 workers, 6 files, 3 repeats, both isolate modes, and a 50ms cross-process ordering margin. `D=4000ms`; `SMALL=1000ms`; `LARGE=20000ms`; each child had a derived 74000ms cap. Arm A uses both SMALL budgets, B only test SMALL, C only hook SMALL, and R both LARGE. A pass counts only with an `end - start` ledger duration of at least 3600ms.

The original recorded table was invalidated during code review: it retained only arm R's summary, so it could not prove that arm A's ordering or granularity agreed across repeats. The corrected survey retains every arm's outcome, ordering, and granularity; setup callbacks now retain Vitest's active test path, while a setup boundary without a supported file identity is explicitly `indeterminate` rather than inferred from recycled worker PIDs. Runner-resolution failures likewise become retained `failed-unclassified` calibration/cell evidence and an `insufficient-data` report. Its one permitted full execution exceeded the hosted 720-second command boundary before it wrote the JSON report. No complete fixed-instrument calibration or boundary cell is therefore available; the prior table is deliberately not repeated here as evidence.

| Boundary | Isolate | A/B/C/R | Ownership | Granularity | Ordering | Deterministic |
| --- | --- | --- | --- | --- | --- | --- |
| global setup | true/false | unavailable — fixed-instrument survey did not complete | unavailable | unavailable | unavailable | unavailable |
| setup top-level await | true/false | unavailable — fixed-instrument survey did not complete | unavailable | unavailable | unavailable | unavailable |
| setup beforeAll | true/false | unavailable — fixed-instrument survey did not complete | unavailable | unavailable | unavailable | unavailable |
| per-file beforeAll | true/false | unavailable — fixed-instrument survey did not complete | unavailable | unavailable | unavailable | unavailable |

## Terminal verdict: `insufficient-data`

The corrected instrument has no complete calibrated result, so it cannot establish an off-budget, before-first-test boundary. The PostgreSQL pre-admission probe remains out of scope and campaign execution remains unauthorized. A successor may not reinterpret the prior report, rerun this survey toward a preferred result, or change timeouts, retries, quarantine entries, worker caps, or harness wiring as a workaround.

No repository timeout, retry, quarantine, worker cap, or harness wiring changed. The SMALL/LARGE values exist exclusively in the generated temporary Vitest config.
