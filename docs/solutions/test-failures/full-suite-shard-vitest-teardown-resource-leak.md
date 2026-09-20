---
category: test-failure
module: full-suite
problem_type: false-attribution
---

# W34 shard-lane watchdog evidence: no Vitest teardown leak

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

## Scope boundary

Pipeline smoke tier mode #3 is owned by FN-9312 and is excluded from this investigation. It is neither evidence of a shared Vitest cleanup defect nor a reason to make full-suite checks blocking.

## Durable diagnostic rule

A watchdog heartbeat only says that the wrapped process remains alive. Classify a shard as a teardown/resource hang only after the child test body has completed and one of the watchdog timeout diagnostics or owner-scoped open-handle/process evidence proves an unreleased resource. Otherwise preserve timing artifacts and investigate the failing active command directly.
