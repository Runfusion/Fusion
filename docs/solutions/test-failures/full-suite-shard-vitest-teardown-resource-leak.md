---
category: test-failure
module: full-suite
problem_type: false-attribution
---

# W34 shard-lane watchdog ownership and timing evidence

## Incident evidence

Run `35496026065` (FN-9334, commit `d45c06141ac131c6b68d753dc6777b41306fd3ef`) was part of the full-suite failure family increase from 224 to 235 (`+11 (09-20 08:17)`). Its four shard jobs and the separately owned Pipeline smoke tier were red; Engine slow tier and lifecycle-column ratchet drift were green.

The reported 20m33s–25m12s duration and `[watchdog] still running` lines were initially described as a hung-Vitest teardown/resource class. The job data and failed-step log do not support that diagnosis:

- Shard 2's test step ran from `07:08:21Z` to `07:29:13Z` and exited with code 1, below the shard watchdog's 30-minute ceiling. No watchdog `HANG`, `exceeded budget`, SIGTERM, or SIGKILL diagnostic was emitted.
- The plugin invocation began after dashboard artifact preparation and completed normally: auto-label passed 1 file / 22 tests in 9.13s, settings-demo passed 1 file / 25 tests in 9.17s, and quality passed 13 files / 56 tests in 13.10s. Each wrote its package-local `timings-shard2-0.json` before the engine command began.
- The subsequent engine `[2/2]` command was still executing named reliability and real-git test bodies until the failed step ended. The repeated watchdog line is a five-second liveness heartbeat for an active child process, not evidence that a completed Vitest process was stuck in teardown.

Therefore no common plugin/core Vitest teardown owner exists in this incident. Treating these heartbeats as a teardown leak would incorrectly change shared cleanup behavior and could hide the actual engine test failure.

## Repro and verification

Use `node scripts/ci-test-shard.mjs --dry-run --total 4` to inspect the current deterministic mapping. For the historical shard-2 package paths, use direct production-configured Vitest commands with named files rather than package scripts. The focused checks for auto-label, settings-demo, quality, selected engine real-git files, browser lifecycle files, PTY, tunnel, and verification-supervision files all exited cleanly in the FN-9337 worktree.

One task-authorized local shard-2 run confirmed the same sequencing: all three plugin timing files were emitted before engine continued. The local verification host capped the workspace command at about 15 minutes, so that observation is not a second watchdog reproduction and must not be used to infer a timeout.

## Artifact contract

`.github/workflows/full-suite.yml` remains a push-to-main, non-blocking observer. Its `Upload per-shard test timings` step uses `if: always()` and uploads hidden package-local `.timings/timings-*.json` files as `test-timings-shard-${{ matrix.shard }}`. The historical shard-2 artifacts are the auto-label, settings-demo, and quality JSON reports above; an engine report is absent when the engine process does not complete its reporter finalization.

## Delivered lifecycle hardening

FN-9349 fixes three narrow ownership gaps without changing any watchdog, Vitest, CI-job, retry, or worker budget. The Core subprocess guard now removes a prior registration's `close` and `error` listeners before replacing it, so a duplicate callback cannot clean a successor timer or record. Core global teardown now also retains the exact marker it wrote at setup and removes its worker root only if that marker still matches, preventing a partial-startup or stale closure from deleting a successor-owned root. The shard watchdog captures its detached group ID at spawn and declines late timeout, forwarded-signal, or wrapper-exit signals once the child has reported exit; this prevents cleanup from targeting a recycled group ID.

A partial shard still uploads timing files with the existing `if: always()` artifact step. Refreshing timing data merges valid reporter outputs from the completed commands with existing valid entries, and explicit pruning remains responsible for removing dead test-file paths. This avoids turning a failed invocation's missing reporter into a destructive timing-snapshot rewrite.

## Scope boundary

Pipeline smoke tier mode #3 is independently owned and is excluded from this investigation. It is neither evidence of a shared Vitest cleanup defect nor a reason to make full-suite checks blocking.

## Durable diagnostic rule

A watchdog heartbeat only says that the wrapped process remains alive. Classify a shard as a teardown/resource hang only after the child test body has completed and one of the watchdog timeout diagnostics or owner-scoped open-handle/process evidence proves an unreleased resource. Otherwise preserve timing artifacts and investigate the failing active command directly. Post-landing evidence must name the first Full Suite run at or after the landed SHA, show the conclusions for shards 1/4 through 4/4, and list all four timing artifacts; this document does not claim that evidence before it exists.

For a task with the enabled blocking `post-merge-verification` workflow gate, that evidence is a completion gate rather than an advisory note. The gate must reject approval until the delivery record includes the landed SHA; the first eligible push-to-main Full Suite run ID and SHA; one conclusion per shard; and `test-timings-shard-1` through `test-timings-shard-4`. The Full Suite workflow itself remains non-blocking branch protection, so a pre-landing or unrelated-main run cannot be used to close the task.
