---
category: test-failures
module: testing
date: 2026-08-01
problem_type: suite_only_flake
component: PostgreSQL test infrastructure
severity: medium
applies_when:
  - "A test fails under full-suite parallelism but passes when run alone"
  - "A first flake sighting is in a file whose remaining coverage is substantial"
  - "Capturing evidence before a file-level quarantine decision"
tags:
  - flake
  - postgres
  - full-suite
  - quarantine
---

# Observed suite-only flakes register

This register preserves first-sighting evidence under the narrow exception in [AGENTS.md](../../../AGENTS.md#standing-rule-flaky-tests-are-quarantined-on-sight-deletion-ratchet). It is not a quarantine: the normal default remains a ledger entry plus matching Vitest `exclude` in the same commit.

## 1. Project identity returns no stored identity

- **File:** `packages/core/src/__tests__/postgres/project-identity.test.ts`
- **Exact test:** `project-identity async (PostgreSQL integration) > returns null when no identity is stored`
- **Observed tree/SHA:** `origin/main` at `7927c7b58a`
- **Observed frequency:** 1-in-3 full-core-suite runs.

| run | result |
|---|---|
| full core suite (1st) | **1 failed** / 4824 passed |
| full core suite (2nd) | 4825 passed |
| full core suite (3rd) | 4825 passed |
| file alone ×2 | 6 passed, 6 passed |

## 2. Schema applier retains registered dependents

- **File:** `packages/core/src/__tests__/postgres/schema-applier.test.ts`
- **Exact test:** `schema-applier: VAL-SCHEMA-001 final-schema parity (table counts) > retains unreplaced registered dependents for every delete action`
- **Observed tree/SHA:** PR [#2828](https://github.com/Runfusion/Fusion/pull/2828) merged-with-main.

| run | result |
|---|---|
| full core suite on #2828 merged-with-main | **failed** |
| file alone ×2 on the same tree | 75 passed, 75 passed |
| file alone on `origin/main` | passed |

## 3. Plugin runner complete-lane lifecycle hook

- **File:** `packages/engine/src/__tests__/plugin-runner.test.ts`
- **Exact test:** `PluginRunner > task lifecycle hooks > should invoke onTaskCompleted when the complete lane is RENAMED`
- **Observed tree/SHA:** PR [#2799](https://github.com/Runfusion/Fusion/pull/2799) merged-with-main.

| run | result |
|---|---|
| full engine suite on #2799 merged-with-main (1st) | **8 failed** (7 in this file + 1 inherited) |
| full engine suite, same tree (2nd) | 1 failed (the inherited one only) |
| file alone | 80 passed |
| full engine suite on `origin/main` ×2 | clean |

Seven tests failed in `plugin-runner.test.ts`, but only this one identity survived capture: `--reporter=dot | tail -3` truncated the `FAIL` lines and retained only the summary.

## Common shape and unverified suspicion

All three are PostgreSQL-backed or PostgreSQL-suite-adjacent, pass in isolation, and appear only under full-suite parallelism. This points at shared database state between test files rather than any of the three tests. It is **unverified and uninvestigated**, not a diagnosis; do not infer a root-cause fix from this record.

## Policy and escalation

Quarantine is file-level, while these files retain 6 / 75 / 80 passing tests. Under the first-sighting exception in AGENTS.md, recording preserves that valuable coverage while retaining the evidence needed for action. A **second sighting** of any registered test is an on-sight quarantine: add it to `scripts/lib/test-quarantine.json` and the matching Vitest `exclude` in one lockstep commit; this register entry is then evidence for the ledger `reason`.

Capture **full runner output** before recording or quarantining a failure—for example, tee it to a file. Never pipe a dot reporter through `tail`: the summary survives while the `FAIL` identity lines needed for a quarantine entry are exactly what gets truncated.

Source: [Runfusion/Fusion issue #2862](https://github.com/Runfusion/Fusion/issues/2862).
