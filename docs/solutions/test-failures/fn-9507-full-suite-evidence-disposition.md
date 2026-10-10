---
title: FN-9507 Full Suite evidence disposition
category: test-failure
module: github-actions
problem_type: ci-evidence
---

# FN-9507 Full Suite evidence disposition

## Incident record

The first push-to-main Full Suite attempt for landed SHA `93e5f5367ae61aa57381168664a8281f18c7d088` was run `37264748966`, attempt 1. It is a completed GitHub-hosted record and cannot be changed by a repository commit, local test, or later artifact upload.

| Subject | GitHub metadata observation |
| --- | --- |
| Shard 1 | Job `111619069059` (`Test shard 1/4`) was created `2026-10-05T04:43:22Z`, started `2026-10-05T04:43:25Z`, and completed `cancelled` at `2026-10-05T05:48:25Z`. GitHub recorded the one-hour job-limit cancellation while `Test (deterministic shard)` was active. |
| Shard-1 upload | `Upload per-shard test timings` never started and has no conclusion. An `if: always()` step is scheduled only while GitHub retains control of the job; it cannot run after the hosted job limit terminates the job. |
| Available timing artifacts | The immutable run inventory contains only `test-timings-shard-2` (`11326099454`, `2026-10-05T05:06:25Z`), `test-timings-shard-3` (`11326646906`, `2026-10-05T05:09:32Z`), and `test-timings-shard-4` (`11326282191`, `2026-10-05T05:01:05Z`). There is no `test-timings-shard-1`. |
| Pipeline smoke | `pipeline-smoke-report` (`11326516654`) was retained at `2026-10-05T04:51:21Z`; it does not substitute for the missing shard artifact. |
| Collector | Job `111633001534` started `2026-10-05T05:48:28Z` and failed its validation step at `2026-10-05T05:48:37Z`. Its normalized-evidence retain step was skipped because the prior inline validation exited nonzero. No `post-merge-full-suite-evidence` artifact was produced. |

The incident workflow source is blob `137f43d252985afee802c7fe7aab58fb4dc17fc4`. FN-9502 later added an inner-runner diagnostic payload for failures that return control to `scripts/ci-test-shard.mjs`; it cannot write a file after GitHub has terminated the entire hosted job, so it cannot repair this cancellation.

## Repair and qualification boundary

FN-9507 replaces the collector's inline code with `scripts/post-merge-full-suite-evidence.mjs`. A reached collector writes `post-merge-evidence/manifest.json` before returning nonzero for absent, malformed, duplicate, or invalid producer input. The workflow uploads that manifest with `if: always()`, including when an artifact-download action fails.

A diagnostic manifest uses `version: 3`, `status: "incomplete"`, producer conclusions, observed expected-artifact presence, and bounded machine-readable failure reasons. It has `qualification.eligible: false`; it never invents timing JSON, test results, failed test names, a Pipeline smoke report, or a successful producer conclusion. Complete input remains the existing `version: 2` normalized evidence format.

## Operator decision and FN-9437

The public run metadata confirms the immutable attempt but does not expose whether an authenticated operator currently has a GitHub rerun control. No authorized rerun action was performed for this investigation. An operator may inspect the historical run in GitHub with authorized access; if GitHub offers rerun, that action creates a new attempt with newly generated evidence. It cannot add a job or artifact to attempt 1 and cannot make that new evidence belong to the original attempt.

FN-9437 therefore remains blocked on its **historical first eligible attempt**: run `37264748966` lacks shard 1 and normalized evidence. No repository-side or operator action can satisfy that historical-attempt contract by substitution. A later rerun can be evaluated only as its own attempt and only if it produces all four genuine timing artifacts, a valid Pipeline smoke report, and normalized evidence; it does not approve FN-9437's missing historical evidence. The retained-artifact digests, failed-assertion ledger, and required specifically scoped operator decision are recorded in [FN-9517's immutable disposition](./fn-9517-fn-9437-post-merge-evidence-disposition.md).
