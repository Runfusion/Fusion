/**
 * step-runner — the two substrate seams for graph-owned stepwise execution
 * (plan 2026-06-04-001, KTD-2 / U2).
 *
 * This module exposes exactly two capabilities that the workflow-graph executor
 * (U3/U5) will drive — it does NOT wire itself into any graph path here:
 *
 *   - {@link runTaskStep}        — run exactly step `i` of a task inside its
 *                                  session/worktree and return the outcome plus
 *                                  the per-step `baselineSha` / `checkpointId`
 *                                  that a later RETHINK needs.
 *   - {@link resetStepToBaseline} — the RETHINK mechanics, extracted verbatim
 *                                  from `executor.ts`'s `fn_review_step` RETHINK
 *                                  block (`git reset --hard <baseline>` + session
 *                                  rewind via `navigateTree`/`branchWithSummary`
 *                                  fallback + `store.updateStep(..., "pending")`),
 *                                  plus a defensive blast-radius guard (KTD-2).
 *
 * Both are parameterized via an explicit `deps` object (the DI style used by
 * `hold-release.ts` / `merge-trait.ts`) so they stay unit-testable without real
 * git, real sessions, or a real `StepSessionExecutor`. Production callers (U3/U5)
 * pass thin adapters over the existing engine machinery; the legacy in-session
 * `fn_review_step` path is untouched and keeps its own copy's behavior — this
 * extraction is the single implementation the executor's RETHINK block now
 * delegates to (see `TaskExecutor.applyStepRethink`).
 */

import { exec } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";

import type { TaskStore } from "@fusion/core";

const execAsync = promisify(exec);

import type { AgentSession as PiAgentSession } from "@earendil-works/pi-coding-agent";
import { executorLog } from "./logger.js";
import type { RunAuditor } from "./run-audit.js";

// ── Shared minimal shapes ───────────────────────────────────────────────

/** The slice of `Task` the step runner reads. */
export interface StepRunnerTask {
  id: string;
  steps: Array<{ name?: string; status?: string }>;
}

/** A minimal session ref mirroring the executor's `{ current: AgentSession }`. */
export interface SessionRef {
  current: PiAgentSession | null;
}

/**
 * Run exactly one step inside the task's session/worktree. Production wires this
 * to a {@link import("./step-session-executor.js").StepSessionExecutor} configured
 * for a single step (graph-owned runs force step-session physics, KTD-2/KTD-8);
 * tests inject a fake. Returns whether the step's session completed successfully.
 */
export type RunSingleStep = (stepIndex: number) => Promise<{ success: boolean; error?: string }>;

// ── runTaskStep ─────────────────────────────────────────────────────────

/** Dependencies for {@link runTaskStep}. */
export interface RunTaskStepDeps {
  /** Step-state projection sink (KTD-7). */
  store: Pick<TaskStore, "updateStep" | "logEntry">;
  /** Absolute path to the task's worktree (where `git rev-parse HEAD` runs). */
  worktreePath: string;
  /** Run exactly step `i` (step-session physics). */
  runStep: RunSingleStep;
  /**
   * Capture HEAD in the worktree before step work begins (the per-step baseline,
   * KTD-2 documented behavior change). Defaults to
   * `git rev-parse HEAD` in {@link RunTaskStepDeps.worktreePath}; inject in tests.
   */
  gitRevParse?: (worktreePath: string) => Promise<string | undefined>;
  /**
   * Capture the session checkpoint (leaf) id for the step — observed the same way
   * the legacy `stepCheckpoints` map is populated (`session.sessionManager.getLeafId()`).
   * Defaults to reading {@link RunTaskStepOptions.sessionRef}; inject in tests.
   */
  captureCheckpointId?: () => string | undefined;
}

/** Options for {@link runTaskStep}. */
export interface RunTaskStepOptions {
  /** Session ref used for the default checkpoint capture. */
  sessionRef?: SessionRef;
  /**
   * Projection source for step-state writes. Graph-owned callers pass `"graph"`
   * so TaskStore applies dependency-order/out-of-order semantics instead of the
   * legacy sequential fn_task_update guard.
   */
  projectionSource?: "graph";
  /**
   * Whether a successful step run marks the step `done` through the projection
   * (KTD-7). Default `true` — the step is the terminal authority on its own
   * completion (no review node present). The foreach sub-walk passes `false` when
   * the template contains a `step-review` node (U6/KTD-4): in that case
   * `step-execute` SUCCESS leaves the step `in-progress` and the step-review
   * node's APPROVE verdict marks it `done` through the projection instead — so a
   * single authority (the review) decides done-ness.
   */
  markDoneOnSuccess?: boolean;
}

/** Result of {@link runTaskStep}. */
export interface RunTaskStepResult {
  outcome: "success" | "failure";
  baselineSha?: string;
  checkpointId?: string;
}

/**
 * Drive execution of exactly step `stepIndex` of `task`.
 *
 * Order of operations (matches the legacy step-session lifecycle the
 * characterization tests pin):
 *   1. mark the step `in-progress` via `store.updateStep` (projection sink);
 *   2. capture `baselineSha` = HEAD in the worktree, BEFORE any step work;
 *   3. run exactly step `i` as a step-session (the agent authors its own
 *      `complete Step N` commit — this driver only observes);
 *   4. capture `checkpointId` (session leaf) for a later RETHINK rewind;
 *   5. on success, mark the step `done`; on failure, leave the step non-done
 *      (the graph decides routing — KTD-4).
 */
export async function runTaskStep(
  deps: RunTaskStepDeps,
  task: StepRunnerTask,
  stepIndex: number,
  opts: RunTaskStepOptions = {},
): Promise<RunTaskStepResult> {
  const { store, worktreePath } = deps;
  const gitRevParse = deps.gitRevParse ?? defaultGitRevParse;
  const captureCheckpointId =
    deps.captureCheckpointId ?? (() => defaultCaptureCheckpointId(opts.sessionRef));

  // 1. Projection: step → in-progress (KTD-7). updateStep's own guards apply.
  try {
    if (opts.projectionSource) {
      await store.updateStep(task.id, stepIndex, "in-progress", { source: opts.projectionSource });
    } else {
      await store.updateStep(task.id, stepIndex, "in-progress");
    }
  } catch (err) {
    executorLog.warn(
      `${task.id}: runTaskStep failed to mark step ${stepIndex} in-progress: ${errMsg(err)}`,
    );
  }

  // 2. Baseline capture at instance start, before step work (KTD-2).
  let baselineSha: string | undefined;
  try {
    baselineSha = await gitRevParse(worktreePath);
  } catch (err) {
    executorLog.warn(`${task.id}: runTaskStep baseline capture failed: ${errMsg(err)}`);
  }

  // 3. Run exactly step i. The agent authors the commit; we observe only.
  const result = await deps.runStep(stepIndex);

  // 4. Capture the session checkpoint (leaf) for a later RETHINK rewind.
  let checkpointId: string | undefined;
  try {
    checkpointId = captureCheckpointId() ?? undefined;
  } catch (err) {
    executorLog.warn(`${task.id}: runTaskStep checkpoint capture failed: ${errMsg(err)}`);
  }

  // 5. Projection: success → done; failure leaves the step non-done.
  //    When a step-review node will decide done-ness (markDoneOnSuccess === false,
  //    U6/KTD-4), leave the step `in-progress` so the review's APPROVE verdict is
  //    the single authority that marks it done.
  const markDoneOnSuccess = opts.markDoneOnSuccess ?? true;
  if (result.success) {
    if (markDoneOnSuccess) {
      try {
        if (opts.projectionSource) {
          await store.updateStep(task.id, stepIndex, "done", { source: opts.projectionSource });
        } else {
          await store.updateStep(task.id, stepIndex, "done");
        }
      } catch (err) {
        executorLog.warn(
          `${task.id}: runTaskStep failed to mark step ${stepIndex} done: ${errMsg(err)}`,
        );
      }
    }
    return { outcome: "success", baselineSha, checkpointId };
  }

  return { outcome: "failure", baselineSha, checkpointId };
}

// ── resetStepToBaseline ──────────────────────────────────────────────────

/** Dependencies for {@link resetStepToBaseline}. */
export interface ResetStepDeps {
  /** Step-state projection sink (KTD-7). */
  store: Pick<TaskStore, "updateStep" | "logEntry">;
  /** Absolute path to the task's worktree (where `git reset --hard` runs). */
  worktreePath: string;
  /** Session ref for the conversation rewind (`navigateTree` / `branchWithSummary`). */
  sessionRef: SessionRef;
  /**
   * Review type — `code` reverts file changes via git reset; `plan` skips the
   * git reset (no code was written), matching the legacy RETHINK branch.
   */
  reviewType?: "code" | "plan";
  /** Optional reviewer summary used as the `branchWithSummary` fallback label. */
  summary?: string;
  /** Optional auditor for the blast-radius guard refusal warning (KTD-2). */
  audit?: Pick<RunAuditor, "database">;
  /**
   * Blast-radius guard hook (KTD-2, shared isolation). Returns `null` when the
   * reset is safe, or a refusal `reason` string when it would destroy other
   * steps' approved work (baseline not an ancestor of HEAD, or a later step is
   * already done/skipped past the baseline). When omitted the guard is skipped
   * (worktree isolation makes it structural — KTD-11). Tests inject a fake;
   * production wires {@link makeAncestryBlastRadiusGuard}.
   */
  blastRadiusGuard?: (baselineSha: string | undefined) => Promise<string | null>;
}

/** Result of {@link resetStepToBaseline}. */
export interface ResetStepResult {
  ok: boolean;
  reason?: string;
}

/**
 * Reset step `stepIndex` to its per-step baseline — the verbatim RETHINK
 * mechanics extracted from `executor.ts` (`fn_review_step` RETHINK case):
 *
 *   - `git reset --hard <baseline>` in the worktree (code review only; skipped
 *     when `baselineSha` is missing or for plan reviews — today's semantics);
 *   - session rewind to the pre-step checkpoint via `navigateTree`, falling back
 *     to `sessionManager.branchWithSummary` (skipped when `checkpointId` is
 *     missing — today's semantics);
 *   - `store.updateStep(..., "pending")`.
 *
 * Before any mutation, the KTD-2 blast-radius guard runs (when provided): on a
 * violation it returns `{ ok: false, reason }`, emits an audit warning, and
 * mutates NOTHING.
 */
export async function resetStepToBaseline(
  deps: ResetStepDeps,
  task: StepRunnerTask,
  stepIndex: number,
  baselineSha?: string,
  checkpointId?: string,
): Promise<ResetStepResult> {
  const { store, worktreePath, sessionRef } = deps;
  const reviewType = deps.reviewType ?? "code";
  const taskId = task.id;
  const step = stepIndex;
  /*
   * FNXC:StepReset 2026-06-17-00:00:
   * RETHINK reset logs use the same 0-based Step N as fn_review_step and PROMPT.md so recovery tooling can correlate review verdicts, checkpoints, and reset events without off-by-one translation.
   */

  // ── KTD-2 blast-radius guard — assert BEFORE mutating anything. ──────────
  if (deps.blastRadiusGuard) {
    let refusal: string | null = null;
    try {
      refusal = await deps.blastRadiusGuard(baselineSha);
    } catch (err) {
      // A guard that itself fails is treated as a refusal — fail closed.
      refusal = `blast-radius guard error: ${errMsg(err)}`;
    }
    if (refusal) {
      executorLog.warn(
        `${taskId}: RETHINK reset for step ${step} REFUSED by blast-radius guard: ${refusal}`,
      );
      await deps.audit?.database({
        type: "task:integrity-warning",
        target: taskId,
        metadata: {
          guard: "step-reset-blast-radius",
          stepIndex,
          baselineSha: baselineSha ?? null,
          reason: refusal,
        },
      });
      return { ok: false, reason: refusal };
    }
  }

  // ── git reset --hard <baseline> (code reviews only). ─────────────────────
  if (reviewType === "code" && baselineSha) {
    try {
      await execAsync(`git reset --hard ${baselineSha}`, { cwd: worktreePath });
      executorLog.log(`${taskId}: RETHINK — git reset --hard ${baselineSha}`);
    } catch (gitErr: unknown) {
      executorLog.error(`${taskId}: RETHINK git reset failed: ${errMsg(gitErr)}`);
    }
  } else if (reviewType === "code") {
    executorLog.log(`${taskId}: RETHINK — no baseline SHA, skipping git reset`);
  }

  // ── Rewind conversation to the pre-step checkpoint. ──────────────────────
  if (checkpointId && sessionRef.current) {
    try {
      await sessionRef.current.navigateTree(checkpointId, { summarize: false });
      executorLog.log(`${taskId}: RETHINK — session rewound to checkpoint ${checkpointId}`);
    } catch (rewindErr: unknown) {
      executorLog.warn(
        `${taskId}: RETHINK navigateTree rewind failed, falling back to branchWithSummary: ${errMsg(rewindErr)}`,
      );
      try {
        sessionRef.current.sessionManager.branchWithSummary(
          checkpointId,
          `RETHINK: ${deps.summary || "Approach rejected by reviewer"}`,
        );
        executorLog.log(`${taskId}: RETHINK — branched from checkpoint ${checkpointId}`);
      } catch (branchErr: unknown) {
        executorLog.error(`${taskId}: RETHINK session rewind failed: ${errMsg(branchErr)}`);
      }
    }
  } else {
    executorLog.log(`${taskId}: RETHINK — no session checkpoint for step ${step}, skipping rewind`);
  }

  // ── Reset step status to pending (projection sink). ──────────────────────
  await store.updateStep(taskId, stepIndex, "pending");

  if (reviewType === "plan") {
    await store.logEntry(
      taskId,
      `RETHINK: Step ${step} plan rewound — session checkpoint ${checkpointId || "N/A"}`,
      deps.summary,
    );
  } else {
    await store.logEntry(
      taskId,
      `RETHINK: Step ${step} rewound — git reset to ${baselineSha || "N/A"}, session checkpoint ${checkpointId || "N/A"}`,
      deps.summary,
    );
  }

  return { ok: true };
}

// ── Blast-radius guard factory (shared isolation, KTD-2) ─────────────────

/**
 * Build the shared-isolation blast-radius guard: a reset for step `stepIndex` is
 * legal only when (a) `baselineSha` is an ancestor of HEAD in the worktree
 * (`git merge-base --is-ancestor`), and (b) no LATER step is already
 * `done`/`skipped` (which would postdate the baseline). On violation it returns
 * the refusal reason; otherwise `null`. A missing baseline is allowed (the reset
 * simply skips its git portion — today's partial-recovery semantics).
 */
export function makeAncestryBlastRadiusGuard(opts: {
  worktreePath: string;
  task: StepRunnerTask;
  stepIndex: number;
  isAncestor?: (baselineSha: string, worktreePath: string) => Promise<boolean>;
}): (baselineSha: string | undefined) => Promise<string | null> {
  const isAncestor = opts.isAncestor ?? defaultIsAncestorOfHead;
  return async (baselineSha: string | undefined): Promise<string | null> => {
    // (b) No later step may already be terminal-done past this baseline.
    const laterDone = opts.task.steps.findIndex(
      (s, i) => i > opts.stepIndex && (s.status === "done" || s.status === "skipped"),
    );
    if (laterDone !== -1) {
      return `later step ${laterDone} is ${opts.task.steps[laterDone]?.status} — reset would destroy approved work`;
    }
    // (a) Baseline must be an ancestor of HEAD (skipped when no baseline).
    if (baselineSha) {
      let ancestor = false;
      try {
        ancestor = await isAncestor(baselineSha, opts.worktreePath);
      } catch (err) {
        return `ancestry check failed: ${errMsg(err)}`;
      }
      if (!ancestor) {
        return `baseline ${baselineSha} is not an ancestor of HEAD`;
      }
    }
    return null;
  };
}

// ── Defaults (production adapters over real git/session) ─────────────────

/**
 * FNXC:BaselineCwdGating 2026-07-21-19:21:
 * A truthy task worktree path does not prove a checkout exists as a directory.
 * Missing or non-directory cwd values make Node report the misleading `spawn /bin/sh ENOENT`
 * during FN-8464 baseline capture (Runfusion/Fusion#2386). This check is total: empty,
 * missing, non-directory, or any filesystem race/access error defers capture without failing
 * graph step projection.
 */
export function isUsableWorktreeDirectory(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

async function defaultGitRevParse(worktreePath: string): Promise<string | undefined> {
  /*
   * FNXC:BaselineCwdGating 2026-07-21-19:21:
   * Keep this defense at the git seam as callers beyond graph projection may pass stale paths.
   * Never spawn git until the shared total directory check proves its cwd is usable.
   */
  if (!isUsableWorktreeDirectory(worktreePath)) return undefined;
  const { stdout } = await execAsync("git rev-parse HEAD", { cwd: worktreePath });
  const sha = stdout.trim();
  return sha.length > 0 ? sha : undefined;
}

function defaultCaptureCheckpointId(sessionRef?: SessionRef): string | undefined {
  const leaf = sessionRef?.current?.sessionManager?.getLeafId?.();
  return leaf ?? undefined;
}

async function defaultIsAncestorOfHead(baselineSha: string, worktreePath: string): Promise<boolean> {
  try {
    await execAsync(`git merge-base --is-ancestor ${baselineSha} HEAD`, { cwd: worktreePath });
    return true;
  } catch {
    // Non-zero exit → not an ancestor.
    return false;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
