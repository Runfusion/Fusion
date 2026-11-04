/**
 * FNXC:CodeOrganization 2026-08-03-16:05:
 * reclaimExistingWorktree + handleBranchConflict peeled from TaskExecutor (U4 Slice B).
 * Branch-conflict recovery lifecycle: inspect → reclaim/retry/sticky, with FN-4811 live-owner guard.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { classifyTaskBranchOrigin, isFusionDeletableBranch, type Settings, type Task, type TaskStore } from "@fusion/core";
import {
  assertCleanBranchAtBase,
  BranchConflictError,
  desiredPathFor,
  inspectBranchConflict,
  liveCheckoutPathFor,
  taskWorktreeCheckoutIsClean,
} from "../execution/branch-conflicts.js";
import { recoverForeignOnlyContamination } from "../recovery/foreign-only-contamination.js";
/*
FNXC:BranchConflictRecovery 2026-09-13-01:45:
RUFU-231 bounded-budget accounting for the executor's sticky branch-conflict park path.
*/
import {
  branchConflictRecoveryCounterPatch,
  branchConflictRecoveryCounterShouldWrite,
  branchConflictRecoveryParkAlreadyApplied,
  buildBranchConflictRecoveryParkPatch,
  branchConflictDispatchEvidenceCounts,
  conflictAttributionBase,
  emitBranchConflictRecoveryParkAudit,
  planBranchConflictRecoveryPass,
} from "../recovery/branch-conflict-recovery-accounting.js";
import { preserveWorktreeChangesIncludingUntracked } from "../execution/worktree-change-preservation.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import { preservedWorktreeTargetPathForTask } from "../worktree/worktree-pinning.js";
import { executorLog } from "../logger.js";
import type { AutoRecoveryDispatcher } from "../healing/auto-recovery.js";
import { generateSyntheticRunId, type EngineRunContext, type RunAuditor } from "../util/run-audit.js";
import { resolveDiffBaseRef } from "./worktree-git-refs.js";
import { getWorktreeBranchMap } from "./worktree-registry-helpers.js";
import {
  formatBranchConflictAgentLog,
  formatBranchConflictLifecycleLog,
} from "./branch-conflict-format.js";

const execAsync = promisify(exec);

export type BranchConflictHandleDeps = {
  rootDir: string;
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  findActiveWorktreeOwner: (worktreePath: string, requestingTaskId: string) => Promise<string | null>;
  normalizeReclaimableWorktreePath: (
    sourcePath: string,
    targetPath: string,
    taskId: string,
    settings: Partial<Settings>,
  ) => Promise<string>;
  cleanupConflictingWorktree: (worktreePath: string, branch: string, taskId: string) => Promise<boolean>;
  getAutoRecoveryDispatcher: (audit: RunAuditor) => AutoRecoveryDispatcher;
  createRunAuditor: (runContext: EngineRunContext | undefined) => RunAuditor;
  persistTokenUsage: (taskId: string) => Promise<void>;
  onError?: (task: Task, error: Error) => void;
};

export async function reclaimExistingWorktree(
  deps: BranchConflictHandleDeps,
  task: Task,
  livePath: string,
  branch: string,
  tipSha: string,
  count: number,
  settings: Partial<Settings>,
): Promise<void> {
  const targetPath = preservedWorktreeTargetPathForTask(task.id, livePath, settings, deps.rootDir);
  const normalizedPath = await deps.normalizeReclaimableWorktreePath(livePath, targetPath, task.id, settings);
  await deps.store.updateTask(task.id, {
    worktree: normalizedPath,
    branch,
    branchWriteOrigin: classifyTaskBranchOrigin(task, branch) === "operator-supplied" ? "operator" : "engine",
  });
  const latestTask = await deps.store.getTask(task.id);
  const baseRef = await resolveDiffBaseRef(normalizedPath, latestTask.baseCommitSha);
  if (baseRef) {
    await assertCleanBranchAtBase(deps.rootDir, branch, baseRef, task.id);
  }
  const message = `[recovery] reclaimed existing worktree for ${task.id} at ${normalizedPath} (${count} commits preserved, tip ${tipSha.slice(0, 12)})`;
  await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
  await deps.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "status", message, "executor");
}

/**
 * FNXC:RecoveryOwnership 2026-10-06-15:51:
 * A branch-conflict retry cap changes recovery strategy, not task ownership. The
 * executor must clear only the conflicting checkout identity under the task fence,
 * leaving the resolved workflow lane dispatchable for fresh acquisition on its next pass.
 */
export async function reseedExhaustedBranchConflict(
  deps: Pick<BranchConflictHandleDeps, "store" | "getRunContextFor">,
  task: Task,
): Promise<boolean> {
  let reseeded = false;
  await deps.store.updateTaskAtomic(task.id, (live) => {
    const sameGeneration = live.column === task.column
      && (live.status ?? null) === (task.status ?? null)
      && live.branch === task.branch
      && live.worktree === task.worktree
      && (live.recoveryRetryCount ?? null) === (task.recoveryRetryCount ?? null);
    if (!sameGeneration || live.userPaused || live.paused || live.status === "blocked") return null;
    reseeded = true;
    return {
      status: null,
      error: null,
      recoveryRetryCount: null,
      recoveryDisposition: "escalated-reseed",
      nextRecoveryAt: null,
      worktree: null,
      branch: null,
      branchWriteOrigin: "engine" as const,
    };
  });
  if (reseeded) {
    await deps.store.logEntry(
      task.id,
      "Branch-conflict retry budget escalated to a fenced fresh-checkout reseed.",
      undefined,
      deps.getRunContextFor(task.id),
    );
  }
  return reseeded;
}

export async function handleBranchConflict(
  deps: BranchConflictHandleDeps,
  task: Task,
  error: BranchConflictError,
): Promise<"retry" | "reclaimed" | "recovered" | "sticky"> {
  /*
  FNXC:BranchPhantomEcho 2026-10-19-15:43 (RUFU-376):
  Every checkout-derived input below this line reads `liveCheckoutPathFor`, never a desired path.
  `foreign-unmerged` carries "" here because Git proved the branch is held by no checkout, and an
  empty path is a real answer rather than a gap to paper over: the FN-4811 guard, the inspection
  that may force-remove a checkout, the pause row, and the operator sentence all have to say "no
  live checkout" instead of substituting the caller's requested path. Treating a desired path as
  liveness is the other half of the same defect — it both fabricates an owner and, worse, can let
  the guard decline a recovery over a directory nobody has open.
  */
  const liveConflictPath = liveCheckoutPathFor(error);
  // FN-4811: Before invoking inspection-based recovery (which may force-remove the
  // conflicting worktree), verify the conflict isn't currently bound to a live session.
  // If it is, refuse the whole recovery dance — a force-remove here would yank an active
  // task's filesystem out from under it, producing FN-4781/FN-4804-style cascade failures.
  // A refusal that proved no checkout skips the probe entirely: there is no filesystem to yank.
  if (liveConflictPath.length > 0) {
    const activeOwner = await deps.findActiveWorktreeOwner(liveConflictPath, task.id);
    if (activeOwner !== null) {
      const refusalMessage = `[FN-4811] Branch conflict on ${error.branchName} deferred: conflicting worktree ${liveConflictPath} is actively owned by ${activeOwner}`;
      executorLog.warn(refusalMessage);
      await deps.store.logEntry(task.id, refusalMessage, undefined, deps.getRunContextFor(task.id));
      return "sticky";
    }
  }
  const settings = await mergeEffectiveSettings(deps.store, task, await deps.store.getSettings());

  const integrationRef = task.mergeDetails?.mergeTargetBranch ?? task.baseBranch ?? task.executionStartBranch ?? await resolveIntegrationBranch(deps.rootDir, undefined);
  const inspection = await inspectBranchConflict({
    repoDir: deps.rootDir,
    branchName: error.branchName,
    conflictingWorktreePath: liveConflictPath,
    requestingTaskId: task.id,
    ownerTaskId: task.id,
    startPoint: error.startPoint,
    integrationRef,
  });

  if (inspection.kind === "stale-resolved") {
    await deps.store.updateTask(task.id, { worktree: null, branch: null, branchWriteOrigin: "engine" as const, baseCommitSha: null });
    const message = `[recovery] ${task.id} stage-A: pruned stale admin entry for ${error.branchName}`;
    await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
    await deps.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "status", message, "executor");
    return "retry";
  }

  if (inspection.kind === "tip-already-merged") {
    /*
    FNXC:BranchBaseIdentity 2026-09-13-03:00:
    RUFU-231 (never release an unproven checkout): a tip proven landed ONLY against the
    remote-tracking identity (the zero-own-commit wedge shape) requires explicit checkout
    proof before release. Clean → release. Dirty → capture a recovery patch first and
    release only once it exists; a failed capture falls through to the dispatcher below
    instead of destroying work. Local-identity landings keep the pre-existing behavior
    byte-for-byte — the gate applies only to the newly reachable wedge verdict.
    */
    let provenReleasable = true;
    if (inspection.landedVia === "remote-tracking" && inspection.livePath && existsSync(inspection.livePath)) {
      if (!await taskWorktreeCheckoutIsClean(inspection.livePath)) {
        const patchPath = await preserveWorktreeChangesIncludingUntracked(deps.rootDir, inspection.livePath, task.id);
        if (patchPath) {
          await deps.store.logEntry(
            task.id,
            `[recovery] ${task.id}: uncommitted work preserved to ${patchPath} before tip-landed checkout release`,
            undefined,
            deps.getRunContextFor(task.id),
          );
        } else {
          provenReleasable = false;
        }
      }
    }
    if (provenReleasable) {
      if (inspection.livePath) {
        await deps.cleanupConflictingWorktree(inspection.livePath, error.branchName, task.id);
      }
      try {
        await execAsync("git worktree prune", {
          cwd: deps.rootDir,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch {
        // best-effort
      }
      if (isFusionDeletableBranch(task, error.branchName)) try {
        await execAsync(`git branch -D ${JSON.stringify(error.branchName)}`, {
          cwd: deps.rootDir,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch {
        // best-effort
      }
      await deps.store.updateTask(task.id, { worktree: null, branch: null, branchWriteOrigin: "engine" as const, baseCommitSha: null });
      const message = `[recovery] ${task.id} stage-A: tip-already-merged cleanup for ${error.branchName} (${inspection.tipSha.slice(0, 12)} on ${inspection.integrationRef})`;
      await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
      await deps.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "status", message, "executor");
      return "retry";
    }
    await deps.store.logEntry(
      task.id,
      `[recovery] ${task.id} tip-landed-on-trusted-remote held: checkout dirty and unproven (landed on ${inspection.integrationRef})`,
      undefined,
      deps.getRunContextFor(task.id),
    );
  }

  if (inspection.kind === "reclaimable") {
    await reclaimExistingWorktree(deps, task, inspection.livePath, error.branchName, inspection.tipSha, inspection.taskAttributedCommitCount, settings);
    return "reclaimed";
  }

  if (inspection.kind === "fully-subsumed") {
    await reclaimExistingWorktree(deps, task, inspection.livePath, error.branchName, inspection.tipSha, 0, settings);
    return "reclaimed";
  }

  if (inspection.kind === "live-foreign") {
    /*
    FNXC:BranchBaseIdentity 2026-09-13-03:05:
    RUFU-231 Deliverable 1: before force-cleaning a live-foreign conflict, consult the
    classification-proven exit. When the branch provably carries zero own commits, zero
    unattributed commits, and foreign work that has already landed on a trusted integration
    identity, recoverForeignOnlyContamination re-anchors it to base (worktree preserved) or
    discards it only when the checkout is already unusable — instead of force-deleting a
    possibly-dirty tree. Non-matching classifications return recovered:false at no cost and
    the existing cleanup path proceeds unchanged.
    */
    const recoveryIntegrationBranch = await resolveIntegrationBranch(deps.rootDir, undefined);
    const liveTask = await deps.store.getTask(task.id).catch(() => null);
    const recovered = await recoverForeignOnlyContamination(liveTask ?? task, {
      repoDir: deps.rootDir,
      taskStore: deps.store,
      runAudit: deps.createRunAuditor(deps.getRunContextFor(task.id)),
      integrationBranch: recoveryIntegrationBranch,
    }).catch(() => null);
    if (recovered?.recovered) {
      const message = `[recovery] ${task.id} live-foreign conflict resolved by foreign-only recovery (subtype=${recovered.subtype}) — no force-delete needed`;
      await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
      await deps.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "status", message, "executor");
      return "reclaimed";
    }
    const cleanupSuccess = await deps.cleanupConflictingWorktree(inspection.livePath, error.branchName, task.id);
    if (cleanupSuccess) {
      try {
        await execAsync("git worktree prune", { cwd: deps.rootDir });
      } catch {
        // best-effort
      }
      try {
        const worktreeMap = await getWorktreeBranchMap(deps.rootDir);
        if (!worktreeMap.has(error.branchName) && isFusionDeletableBranch(task, error.branchName)) {
          await execAsync(`git branch -D "${error.branchName}"`, { cwd: deps.rootDir });
        }
      } catch {
        // best-effort
      }
      return "retry";
    }
  }

  /*
  FNXC:BranchPhantomEcho 2026-10-19-15:43 (RUFU-376):
  The one sentence that survives this pause is the card's own `error` text and the dispatcher's
  reason — everything richer (the structured fields, the desired path) dies with this call frame.
  So the no-live shape has to say so in words: "no live checkout of it was found" is the fact the
  operator needs in order to stop hunting for the phantom second checkout and go inspect the
  branch itself instead. The requested path is deliberately NOT named here either — FK-1 holds the
  card's `error` column to the same standard as the message and the formatted lines.
  */
  const conflictMessage = liveConflictPath.length > 0
    ? `Task branch conflict: ${error.branchName} is already checked out at ${liveConflictPath}. ` +
      `Resolve the local branch/worktree conflict with git tooling (inspect/reclaim or discard) before retrying.`
    : `Task branch conflict: ${error.branchName} is refused and no live checkout of it was found — ` +
      `nothing is holding this branch in a worktree, so there is no checkout to clear. ` +
      `Inspect the branch itself against the integration branch and reclaim or discard it with git tooling before retrying.`;
  await deps.store.logEntry(task.id, formatBranchConflictLifecycleLog(task.id, error), undefined, deps.getRunContextFor(task.id));
  await deps.store.appendAgentLog(task.id, "Branch conflict recovery required", "tool_error", formatBranchConflictAgentLog(task.id, error), "executor");
  /*
  FNXC:BranchConflictRecovery 2026-09-13-01:46:
  RUFU-231 bounded budget for the executor's sticky conflict path. Every recovery dispatch here
  is an attempt on the card's persisted budget (RUFU-217's heartbeat loop ran forever because
  the decision-engine input `recoveryRetryCount` was never written). At attempt maxRetries+1 —
  the decision engine's own `retryCount >= maxRetries` boundary — the pass parks terminal with
  the existing `branch-conflict-recovery-exhausted` reason and an operator remedy instead of
  re-offering "retry"; the retained checkout stays inspectable (park is separated from lease
  release). Successful force-cleanup returns before this point and consumes no budget.
  */
  /*
  FNXC:BranchConflictRecovery 2026-11-02-23:50 (RUFU-432):
  This site kept RUFU-231's terminal short-circuit (a terminal pass must not re-offer "retry"), but the
  short-circuit used to author the park on EVERY pass after the budget was spent — re-writing the counter
  the park itself carried, and re-stamping the row clock the heartbeat reads as liveness. A pass that
  finds its own park already applied now returns "sticky" having authored nothing. The predicate reads the
  LIVE row rather than the run's snapshot, because the case that matters is a card parked by an EARLIER
  dispatch whose snapshot this run may hold pre-park.
  */
  const recoveryPass = planBranchConflictRecoveryPass(task, settings.autoRecovery);
  const liveForPark = await deps.store.getTask(task.id).catch(() => null) ?? task;
  const parkAlreadyApplied = branchConflictRecoveryParkAlreadyApplied(liveForPark, settings.autoRecovery);
  if (recoveryPass.counted && recoveryPass.terminal) {
    if (!parkAlreadyApplied) {
      await deps.store.updateTask(task.id, buildBranchConflictRecoveryParkPatch(recoveryPass, error.startPoint, conflictMessage));
      await emitBranchConflictRecoveryParkAudit({
        store: deps.store,
        agentId: "executor",
        runId: deps.getRunContextFor(task.id)?.runId ?? generateSyntheticRunId("executor-branch-conflict-park", task.id),
        task,
        pass: recoveryPass,
        source: "executor-conflict",
      });
      await deps.store.logEntry(task.id, `[recovery] branch-conflict recovery exhausted ${task.id}: parked terminal after ${recoveryPass.attempt} bounded passes (checkout retained)`, undefined, deps.getRunContextFor(task.id));
    }
    return "sticky";
  }
  const autoRecoveryDispatcher = deps.getAutoRecoveryDispatcher(deps.createRunAuditor(deps.getRunContextFor(task.id)));
  const decision = await autoRecoveryDispatcher.dispatch({
    class: "branch-conflict-unrecoverable",
    taskId: task.id,
    runId: deps.getRunContextFor(task.id)?.runId,
    pausedReason: "branch-conflict-unrecoverable",
    evidence: {
      branchName: error.branchName,
      /*
      FNXC:BranchPhantomEcho 2026-10-19-15:43 (RUFU-376):
      The evidence slot is typed "a checkout we believe is live" on the consuming side — the
      recovery handler reads `evidence.conflictingWorktreePath` as an existing checkout and hands
      it to `activeSessionRegistry.isPathActive()`. A refusal with no proven checkout therefore
      OMITS the key rather than sending `""` or the requested path: an empty string would still be
      consumed as "a checkout exists somewhere at no path", and the requested path would be probed
      for session liveness as if it were one. The requested path rides along under its own name, so
      the handler still learns which path the acquire asked for.
      */
      ...(liveConflictPath.length > 0 ? { conflictingWorktreePath: liveConflictPath } : {}),
      ...(desiredPathFor(error).length > 0 ? { desiredWorktreePath: desiredPathFor(error) } : {}),
      ...(error.collisionKind ? { collisionKind: error.collisionKind } : {}),
      /*
      FNXC:BranchConflictRecovery 2026-09-13-02:10:
      RUFU-231 destructive-ambiguity evidence: `isDestructiveAmbiguity` reads
      `ownCommits`/`foreignAttributedCommits` — without them a mixed own+foreign branch is
      classified by mode (→ retry toward force-cleanup) instead of pausing. Safety read only;
      the dispatcher routing table stays byte-identical.
      */
      ...(await branchConflictDispatchEvidenceCounts({
        repoDir: deps.rootDir,
        taskId: task.id,
        branchRef: error.branchName,
        baseRef: conflictAttributionBase(task, error.startPoint),
      }) ?? {}),
    },
    underlyingError: error,
  }, {
    task,
    retryCount: recoveryPass.persisted,
    settings: settings.autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
  });

  /*
  FNXC:RecoveryOwnership 2026-10-08-13:18 (merge origin/main): upstream FN-9512 turns a spent branch-conflict
  budget into `action: "escalate"` and hands it to `reseedExhaustedBranchConflict`. That check runs FIRST: this
  line's RUFU-231 park used to catch the same condition by rationale (`retry-budget-exhausted`), and keeping it
  ahead of this branch would park terminal exactly the cards FN-9512 reseeds. The two dispositions are disjoint
  (`escalate` only for the spent budget, `pause` for destructive ambiguity), so both behaviours survive.
  */
  if (decision.action === "escalate") {
    return (await reseedExhaustedBranchConflict(deps, task)) ? "recovered" : "sticky";
  }

  /*
  FNXC:BranchConflictRecovery 2026-09-13-01:46 (RUFU-231, narrowed by the 2026-10-08 origin/main merge):
  A destructive-ambiguity refusal is a SAFETY stop, not a spent budget: destroying a branch whose own vs foreign
  commits cannot be attributed needs an operator, so it keeps the terminal park with the checkout retained. The
  `retry-budget-exhausted` alternative is dropped because that rationale now always arrives as `action: "escalate"`
  and is reseeded above.
  */
  if (decision.rationale === "destructive-ambiguity") {
    if (!parkAlreadyApplied) {
      await deps.store.updateTask(task.id, buildBranchConflictRecoveryParkPatch(recoveryPass, error.startPoint, conflictMessage));
      await emitBranchConflictRecoveryParkAudit({
        store: deps.store,
        agentId: "executor",
        runId: deps.getRunContextFor(task.id)?.runId ?? generateSyntheticRunId("executor-branch-conflict-park", task.id),
        task,
        pass: recoveryPass,
        source: "executor-conflict",
      });
      await deps.store.logEntry(task.id, `[recovery] branch-conflict recovery exhausted ${task.id}: ${decision.rationale} — parked terminal (checkout retained)`, undefined, deps.getRunContextFor(task.id));
    }
    return "sticky";
  }

  if (decision.action === "pause") {
    /*
    FNXC:BranchConflictRecovery 2026-11-04-13:03 (RUFU-395):
    The hold is the suppression's own domain, and this arm writes it. A card already parked at
    `branch-conflict-recovery-exhausted` that walks into this arm would have its `pausedReason`
    overwritten with `branch-conflict-unrecoverable` — the exact key every suppression predicate reads,
    so the refusal would erase the evidence that it is being suppressed and the next pass would count
    again. The verdict is unchanged (`sticky`: the dispatcher's release door already ran and declined to
    rescue), only the write is withheld, which is also what RUFU-432 asked for: a re-encounter of an
    applied park authors nothing.
    */
    if (parkAlreadyApplied) {
      return "sticky";
    }
    await deps.store.updateTask(task.id, {
      status: "failed",
      error: conflictMessage,
      branch: error.branchName,
      /*
      FNXC:BranchPhantomEcho 2026-10-19-15:43 (RUFU-376):
      The task row is where the phantom outlives its own incident: this write stored the caller's
      requested path as the card's `worktree`, and the row — not the error — is what every later
      reader treats as a live checkout, from workspace membership through the ownership probe to the
      recovery handler's fallback. A refusal that proved no checkout therefore persists NO checkout,
      which also repairs a row that already carried a stale path into this pause.
      */
      worktree: liveConflictPath.length > 0 ? liveConflictPath : null,
      /*
       * FNXC:BranchWriteOrigin 2026-08-20-14:40: FN-9161's store validation requires an explicit write origin on every branch write.
       * FNXC:BranchWriteOrigin 2026-08-28-10:12: the parked branch may be operator-supplied, so origin derives from the classifier
       * like the sibling re-pin above (#3523 Greptile P1).
       */
      branchWriteOrigin: classifyTaskBranchOrigin(task, error.branchName) === "operator-supplied" ? "operator" : "engine",
      paused: true,
      pausedReason: "branch-conflict-unrecoverable",
      ...branchConflictRecoveryCounterPatch(recoveryPass, "executor-conflict"),
    });
    await deps.persistTokenUsage(task.id);
    executorLog.warn(
      liveConflictPath.length > 0
        ? `✗ ${task.id} branch conflict sticky failure: ${error.branchName} @ ${liveConflictPath}`
        : `✗ ${task.id} branch conflict sticky failure: ${error.branchName} — no live checkout of the branch was found`,
    );
    deps.onError?.(task, error);
    return "sticky";
  }

  /*
   * FNXC:BranchCollisionRecovery 2026-09-20-01:53:
   * The dispatcher can preserve a bare foreign-unmerged ref and atomically pin a
   * fresh engine sibling. Do not retry the original BranchConflictError after that
   * accepted reset: its old branch/path evidence is necessarily still conflicting.
   * Ending this pass lets the normal next execution acquire the persisted sibling
   * without burning the branch-conflict retry budget or reserving another sibling.
   */
  if (error.collisionKind === "foreign-unmerged") {
    const latestTask = await deps.store.getTask(task.id);
    const replacementBranch = latestTask.branch;
    const siblingSuffix = replacementBranch?.slice(`${error.branchName}-`.length);
    if (
      replacementBranch?.startsWith(`${error.branchName}-`)
      && siblingSuffix
      && /^\d+$/.test(siblingSuffix)
      && Number(siblingSuffix) >= 2
      && Number(siblingSuffix) <= 6
      && classifyTaskBranchOrigin(latestTask, replacementBranch) !== "operator-supplied"
    ) {
      return "recovered";
    }
  }

  /*
  FNXC:BranchConflictRecovery 2026-11-02-23:22 (RUFU-432):
  The shared write guard, not `recoveryPass.counted`: a pass whose counter value does not change must
  not reach `updateTask` at all, because the write itself re-stamps `updated_at` — the row clock the
  heartbeat reads as recovery liveness.

  FNXC:BranchConflictRecovery 2026-11-04-13:55 (RUFU-395):
  Beside it, the park-hold check. The terminal arm above already returns "sticky" without authoring
  anything when the card carries its own park; this arm is the NON-terminal path to the same card, and
  once RUFU-395 gave the family a register of its own, advancing that register here would be a write
  on a pass that is supposed to be silent. `parkAlreadyApplied` reads the live row for exactly that
  reason.
  */
  if (branchConflictRecoveryCounterShouldWrite(recoveryPass) && !parkAlreadyApplied) {
    await deps.store.updateTask(task.id, branchConflictRecoveryCounterPatch(recoveryPass, "executor-conflict"));
  }

  /*
  FNXC:BranchConflictRecovery 2026-11-04-13:03 (RUFU-395):
  The verdict for a card carrying its own exhausted park is `sticky`, not `retry`, even though THIS
  family's register has not reached the ceiling. The two facts are different: the register says this
  family has budget left, the row says a lane already decided this card is done trying. Returning
  `retry` here would hand an exhausted, parked card back to the dispatcher as if a slot would help,
  which is the same "looks alive while it can never move" shape the card was filed for. RUFU-432
  pinned this return for the borrowed-`recoveryRetryCount` shape; RUFU-395 keeps it reachable now that
  the ceiling reads the family's own register.
  */
  return parkAlreadyApplied ? "sticky" : "retry";
}
