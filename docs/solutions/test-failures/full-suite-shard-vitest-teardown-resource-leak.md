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

## FN-9359 post-landing adjudication

FN-9349's teardown, subprocess, and worker-root hardening landed in `9539f8aafd`; the accompanying Pipeline smoke and quarantine commits were `5a4a4199ba` and `e149bf6310`. Timing artifacts from baseline Full Suite run `35659656504` and post-landing run `35682179476` make the result falsifiable: 147 of 148 baseline failed test names remained, one baseline failure disappeared, and two failures were new. The post-landing artifact therefore disproves teardown/watchdog ownership for this family while confirming that timing artifacts are available for diagnosis.

The downloaded `test-timings-shard-1` JSON gives a more limited, reproducible conclusion than a shared-environment diagnosis. Its plan-only failures are `TypeError: Cannot read properties of undefined (reading 'execute')` at the test's `tool.execute` calls: graph dispatch returned before the fixture captured its completion tool. Its paused-scope failures are zero `moveTask("…", "todo", …)` calls, while live-zero's first assertion is `expected 'in-review' to be 'todo'`; those are retired fixture expectations after lifecycle containment removed automatic backward authority. The second live-zero timeout is a separate incomplete fake: recovery now re-reads the candidate with `getTask` under its liveness fence.

Accordingly, these representatives do **not** establish one shared PostgreSQL, cache, environment, or teardown prerequisite. The plan-only regression now uses the real production `TaskExecutor` acquisition path: a missing synthetic root reproduces the acquisition failure and missing `fn_task_done`, while an independent valid temporary root captures and executes the completion tool. The recovery fixtures provide the live reader and assert the in-place containment contract. Focused production-configured Vitest runs cover those exact files, including the healthy completion-tool path and the recovery cleanup path. The artifact evidence rejects the shared-prerequisite hypothesis for these three representatives, but it does not explain every remaining shard failure.

Pipeline smoke remains separately owned by FN-9350 and is excluded from this diagnosis. This document records local reproduction and the repair boundary only; it does not claim a qualifying post-landing Full Suite run.

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

## FN-9360 artifact diagnosis and gate audit

Run `35687373347` at `2e7b276aaa5ed53828f9d42706b3ac98c1c5cb25` retained four timing artifacts: shard 1 `10677980902`, shard 2 `10677346796`, shard 3 `10677520736`, and shard 4 `10676649798`. Each Test shard had a miss for the same exact dist-cache key; only the dependency cache hit, so hash-cache seeding and cache-hit ordering were not involved. Compared with run `35682179476`, the run had 346 failed full names versus 400: 344 retained, 56 removed, and two added.

The FN-9359 live-zero and paused-scope fixture changes removed assertions that conflicted with lifecycle containment; they were not appeasement. Its new plan-only fixture, however, used a protected absolute root and required an `ENOENT` string. GitHub returned `EACCES` while local hosts return `ENOENT`, so FN-9360 replaced that platform-sensitive setup with a test-owned non-directory root and a deterministic `ENOTDIR` assertion. The test still calls the real `TaskExecutor` worktree-acquisition path before proving an independent healthy completion-tool capture.

A real common prerequisite was present: 56 failures, including `packages/cli/src/__tests__/bin.test.ts`, reported that `@fusion-plugin-examples/antigravity-runtime` could not resolve its package entry. Dashboard/CLI imports resolve that plugin's public `index` and `probe` exports from `dist`, but the plugin was absent from `REQUIRED_BUILD_PACKAGES` and every Full Suite dist-cache path. On a cold cache, `ensureTestArtifacts` consequently never built it before shard imports. The owner repair registers both exports, hashes its source, and adds its dist directory to the shard, inventory, and warm-cache paths. The owner test proves missing-artifact rebuild then a healthy repeated invocation with no retained bootstrap state. The real bootstrap followed by the affected CLI test passed locally. Pipeline smoke remains separately owned and is excluded.

The bootstrap regression was strengthened after review: Antigravity's export entry points import runtime adapter, transport, bridge, parser, CLI, MCP transaction, and schema-server assets at load time. The artifact inventory now requires that complete runtime-loaded set rather than accepting a partial cache containing only `index.js` and `probe.js`; its regression removes `runtime-adapter.js`, proves a rebuild, and then proves a clean healthy repeat. PR-check cache consumers restore the same runtime dist directory so their cache state cannot mask a missing asset before its imports.

The post-merge evidence gate has a distinct completion-bypass defect. `FN-9349` logged a `REVISE` from Post-merge verification because its first eligible run `35677931859` was unfinished and had no timing-artifact evidence, immediately followed by `Workflow graph run ended after task already advanced to 'done' — no further action needed`; `FN-9350` and `FN-9359` likewise finalized to done before a qualifying four-shard run. The graph does correctly persist a gate-mode post-merge failure and returns failure (`WorkflowGraphExecutor`'s post-merge gate path), but the merge seam has already called the finalization path that moves the card to its done column. The later failure handler sees the durable done row and classifies it as benign instead of restoring a blocking state. This is not approval from in-run or partial evidence: it is a merge-finalization-before-gate ordering defect. A separately scoped repair must fence finalization until the enabled post-merge gate has recorded qualifying evidence, and must cover a post-merge `REVISE` after merge proof with the task remaining nonterminal.

## FN-9362 artifact re-audit: no common CI owner

Timing artifacts from run `35687373347` (`2e7b276aaa`) and run `35701457142` (`ee688b4c2b`) were downloaded and parsed directly. All four artifacts survived in each run: baseline IDs were `10677980902`, `10677346796`, `10677520736`, and `10676649798`; current IDs were `10683076516`, `10682907633`, `10681938631`, and `10682399621`. The comparison contains 272 retained failed full names, six additions, and 74 removals.

The retained names do not identify a shared cache, service, runner, or workflow owner. They cover incompatible stale-test and mock contracts, including a review reclaim expecting the retired direct move to `todo`, executor tests dereferencing an absent completion tool, missing mock members, inventory drift, and unavailable service cases. The stale cached-base reclaim case was reproducible locally and corrected by supplying the live-row reader required by the production rebound fence, then asserting the contained in-review result and cleared metadata. This is not evidence to relax lifecycle containment or to apply a broad fixture-only adjustment.

`pr-checks.yml` remains a curated PR control with no shard matrix and no `test:ci:shard` command; green PR Checks are not shard-equivalent evidence. Therefore neither the PR result nor this artifact intersection reopens the already-falsified watchdog/teardown or Antigravity-bootstrap hypotheses.

A second retained representative, `invariant-wrong-checkout-completion.test.ts`, had the same test-environment ownership defect. It declared a synthetic `/repo/.worktrees/...` path even though graph-owned sessions create state below `.fusion/worktrees/<task-id>`; the setup consequently failed before it captured `fn_task_done`. The corrected fixture uses a test-owned Fusion worktree root, starts the real `TaskExecutor` completion session while acquisition remains simulated, and only then exposes the checkout for the real task-done invariant. It now proves wrong-top-level, wrong-branch, no-commit, and healthy completion outcomes. Its obsolete acquisition-before-session cases were removed because `executor-worktree-liveness.test.ts` owns that production seam.

A qualifying post-landing run still requires all shard failures to be repaired through their individual evidence-backed owners and all four timing artifacts to be retained.

A third retained failure, the FN-4973 live-owner sibling fallback, called `mockReturnValueOnce` on `mockedGenerateWorktreeName` after FN-258 removed that random-name helper from the production path. The actual `tryFreshWorktreeAfterLiveConflict` owner now uses the canonical `.fusion/worktrees/<task-id>` path while preserving branch suffixes `-2` through `-6`. The corrected production-facade regression removes the retired mock, asserts the canonical path and sibling branch, and repeats collision responses through the bounded suffix loop.

## FN-9362 review-remediation evidence boundary

A direct re-parse of the persisted current artifact on 2026-09-22 found 272 retained names. Its diagnostic classes are incompatible with one shared production owner: 18 fail before a completion-tool fixture captures `fn_task_done`, seven call an intentionally unavailable executor dependency-mutation tool, six assert the retired direct `in-review` → `todo` transition, five omit the newer `MAX_TASK_MESSAGE_LENGTH` export from a local core mock, and 12 carry Vitest's artifact-redacted `STACK_TRACE_ERROR` with no production stack. The representative reruns confirm the parallel-step redaction is a synthetic-worktree test timeout, while the contained review move is an intentional production outcome.

The scoped source candidates confirm that no code repair is justified by the stale expectations alone. `moveTaskToContainedBackwardTarget` explicitly rejects branch-reclaim recovery as a backward-move authority, and `tryFreshWorktreeAfterLiveConflict` already resolves the canonical task worktree directory before the fixture's obsolete helper is reached. Changing either source to restore the artifact expectations would violate lifecycle containment or reintroduce random worktree naming.

A concrete retained owner was nevertheless identified from the foreign-only contamination artifact. The real-git recovery passed its pre-git task snapshot as `liveColumn`; after the git reanchor awaited, that snapshot could be stale, so a concurrent operator move could make the lifecycle decision against the wrong column. `moveTaskToContainedBackwardTarget` now always re-reads the durable task row before selecting or refusing a backward target. Its real-git regression supplies a deliberately stale `todo` snapshot while the durable row is `in-review`, and proves that recovery logs and retains the durable column instead. This protects the production recovery path without restoring any retired backward move or random worktree name.

The remaining concrete owners must be selected from their actual failure messages and repaired only where that evidence proves a production defect; this task must not invent an unrelated shared CI, bootstrap, PostgreSQL, lifecycle, or executor source change merely to turn a diagnosis into a code diff.
