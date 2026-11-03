/**
 * FNXC:CodeOrganization 2026-07-15-16:00:
 * Self-healing public timing/budget constants peeled from self-healing.ts.
 * Re-exported from self-healing.ts for stable import paths.
 */

export const COMPLETED_BLOCKED_PAUSE_REASON = "completed-work-blocked";
export const STALE_TEMP_MERGE_WORKTREE_MS = 2 * 60 * 60 * 1000;
export const DONE_TASK_TEMP_WORKTREE_GRACE_MS = 10 * 60 * 1000;
export const MIN_TEMP_WORKTREE_REAP_AGE_MS = DONE_TASK_TEMP_WORKTREE_GRACE_MS;
/*
FNXC:TempScratchSweep 2026-11-03-08:14 (RUFU-397):
A distinct, LONGER floor for Fusion's own leaked scratch directories, deliberately separate from
`STALE_TEMP_MERGE_WORKTREE_MS` / `DONE_TASK_TEMP_WORKTREE_GRACE_MS` / `MIN_TEMP_WORKTREE_REAP_AGE_MS`.

Why a separate number instead of reusing `tempMergeReapAgeMs` (RUFU-290 made it the shared selector for
the two halves of the merge sweep): an AI-merge clean room is disposable — its content is reproducible
from git, so a 2 h floor is safe. A code-node / git-baseline / agent-companies / feature-video / usage-
probe / agent-import / pr-conflict scratch dir holds a UNIQUE artifact a live request may still be
reading (a generated video, an in-flight import body), and nothing about its age proves its owner is
gone: `extractTaskIdFromTempMergeDir` matches only `fusion-ai-merge-(fn-\d+)-<rand>`, so a scratch
directory gets no task-lookup early release, and `activeSessionRegistry.isPathActive` is in-process
only — it cannot see a request owned by another engine process. The floor is therefore the sole
protection for this class, so it is an order of magnitude longer than the merge floor and is never
shortened by an early-release leg.

This sweep is a capacity repair, not a lifecycle move: it changes no task row, no column, and no status.
*/
export const TEMP_SCRATCH_REAP_AGE_MS = 24 * 60 * 60 * 1000;
/*
FNXC:TempScratchSweep 2026-11-03-08:14 (RUFU-397):
Admission gate for extending the stale-tmpdir sweep beyond merge/verify worktrees. A prefix enters this
list ONLY when its creator's release path was verified to run on every leg (a `finally` that removes the
directory, or a single shared cleanup site), because an unqualified prefix would delete the in-flight
workspace of another process — the same class of data loss the 2026-06 `fn-verify-` leak taught the
opposite lesson about (see the sweep's own comment). Every entry below was read at its create site and
its release site before being listed here:

- `fusion-code-node-`      — created `engine/src/execution/code-node-runner.ts`, removed in its `finally`.
- `fusion-git-baseline-`   — created `core/src/git/git-repository.ts`, removed in its `finally`.
- `agent-companies-`       — created `core/src/agents/agent-companies-parser.ts`, `rmSync`ed in its `finally`.
- `fusion-feature-video-`  — created `engine/src/review-artifacts/feature-video.ts`, removed in its `finally`
                             (the bytes are read into memory before cleanup, so the sweep cannot race a reader).
- `fusion-usage-probe-`    — created `dashboard/src/usage.ts`, single shared cleanup site.
- `fn-agent-import-`       — created `register-agent-import-export-generation-routes.ts`, removed in its `finally`.
- `fn-pr-conflict-`        — created `dashboard/src/github.ts`, removed in its `finally`.

Never admitted, on purpose:
- Process-lifetime artifacts a live process still owns: `fn-pkg-`, `fn-bunfs-<pid>`, `fn-experiment-*`,
  `fusion-worktree-sync-*`, `fusion-agent-export-*`, `fusion-test-workers-*`, `fusion-engine-*.sock`.
  Age is not evidence of death for these, and `fusion-engine-*.sock` IS the engine singleton guard.
- Third-party or unrelated content: `dgxs*`, `sane083*`, `.fusion-*`. Not Fusion's to delete, and
  sweeping them would repeat the mistake of naming a foreign file's problem as Fusion's.
- `fusion-worktree-sync-` specifically has no product creator at all (only a `run-audit.ts` comment and
  three dashboard test fixtures reference it), so there is no release invariant to audit against.

The sweep reads each root with ONE non-recursive `readdirSync` filtered by these prefixes. It never
shells out to `find` or `du` over the temp root: the bounded-scan rule exists because an unbounded
recursive walk of the OS temp root can pin I/O for minutes.
*/
export const TEMP_SCRATCH_SWEEP_PREFIXES = [
  "fusion-code-node-",
  "fusion-git-baseline-",
  "agent-companies-",
  "fusion-feature-video-",
  "fusion-usage-probe-",
  "fn-agent-import-",
  "fn-pr-conflict-",
] as const;
export const STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS = 10 * 60_000;
export const COMPLETION_HANDOFF_LIMBO_GRACE_MS = 5 * 60_000;
export const MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES = 3;
export const MAX_POST_DONE_NONCONTINUABLE_WEDGE_RECOVERIES = 3;
export const VALIDATOR_RUN_STALE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const MAX_WORKTREE_SESSION_RETRIES = 3;
export const PAUSE_ABORT_PARK_ERROR_MARKER = "Workflow graph failure surfaced after paused";
export const PAUSE_ABORT_PARK_OPERATOR_MARKER = "operator action required";
export const MAX_AUTO_MERGE_RETRIES = 3;
/*
 * FNXC:MergeReliability 2026-07-15-18:50:
 * FN-8004 raised this bounded transient-only recovery budget from 2 to 5:
 * extra retries can recover completed reviewed work after provider or network
 * blips, while exhaustion remains visible and requires manual review.
 */
export const MAX_TRANSIENT_MERGE_RECOVERIES = 5;
/*
 * FNXC:ChatInFlightRecovery 2026-08-20-20:17 (RUFU-144):
 * Staleness floor for dashboard chat in_flight_generation flags. A generation cannot
 * outlive the dashboard process that started it and no owner/PID is recorded, so the
 * flag's startedAt (fallback: session updated_at) older than this floor is provably
 * dead. The floor is far longer than any single LLM turn (a live generation is never
 * cleared) and far shorter than how long a human notices a zombie "generating" box
 * (recovery stays timely). Dashboard restarts are the known stranding source.
 *
 * FNXC:ChatSidebarLiveness 2026-09-24-05:55 (RUFU-220):
 * DECLARATION MOVED to `packages/core/src/chat/chat-liveness.ts` and re-exported here, because
 * RUFU-220 put the same age rule in front of the operator in the dashboard sidebar. A second
 * literal would let the UI accuse a claim the engine is still holding, and core cannot import
 * engine, so core owns the number. The stable import path and the value are unchanged.
 * It arrives through the root barrel rather than the `@fusion/core/chat-liveness` subpath: that
 * subpath exists for the dashboard's browser-safe alias, and adding it here would mean a new
 * vitest alias per consuming package for no engine-side benefit.
 */
export { CHAT_IN_FLIGHT_GENERATION_STALE_MS } from "@fusion/core";
