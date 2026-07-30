import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Task, TaskStore } from "@fusion/core";
import { resolveWorkflowIrForTask, columnsWithFlag, resolveReboundTarget, TransitionRejectionError } from "@fusion/core";
import {
  classifyBootstrapMisbinding,
  inspectBranchConflict,
  reanchorBranchToBase,
} from "../branch-conflicts.js";
import type { AutoRecoveryContext, AutoRecoveryDecision, AutoRecoveryFailure } from "../auto-recovery.js";
import { activeSessionRegistry } from "../active-session-registry.js";
import { resolveIntegrationBranch } from "../integration-branch.js";
import { createLogger, type Logger } from "../logger.js";
import type { RunAuditor } from "../run-audit.js";

const execAsync = promisify(exec);
const baseLog = createLogger("auto-recovery:branch-worktree");
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export interface BranchWorktreeRecoveryDeps {
  taskStore: TaskStore;
  runAudit: RunAuditor;
  logger?: Logger;
  spawnAiRecoverySession?: (
    failure: AutoRecoveryFailure,
    decision: AutoRecoveryDecision,
    ctx: AutoRecoveryContext,
  ) => Promise<{ outcome: "resolved" | "exhausted" | "error"; metadata?: Record<string, unknown> }>;
  now?: () => Date;
}

interface RecoveryEvidence {
  branchExists: boolean;
  worktreePresent: boolean;
  tipSha?: string;
  inspectionKind?: string;
}

export class BranchWorktreeAutoRecoveryHandler {
  constructor(private readonly deps: BranchWorktreeRecoveryDeps) {}

  private get logger(): Logger {
    return this.deps.logger ?? baseLog;
  }

  private async runGit(repoDir: string, command: string): Promise<string> {
    const { stdout } = await execAsync(command, {
      cwd: repoDir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf-8",
    });
    return stdout.trim();
  }

  private quote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private async hasBranchRef(repoDir: string, branchName: string): Promise<boolean> {
    try {
      await this.runGit(repoDir, `git rev-parse --verify ${this.quote(`refs/heads/${branchName}`)}`);
      return true;
    } catch {
      return false;
    }
  }

  private async getTipSha(repoDir: string, branchName: string): Promise<string | undefined> {
    try {
      return await this.runGit(repoDir, `git rev-parse --verify ${this.quote(`refs/heads/${branchName}`)}`);
    } catch {
      return undefined;
    }
  }

  private async getWorktreeBranchMap(repoDir: string): Promise<Map<string, string>> {
    const output = await this.runGit(repoDir, "git worktree list --porcelain").catch(() => "");
    const map = new Map<string, string>();
    let path: string | null = null;
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      if (line.startsWith("branch refs/heads/") && path) {
        map.set(line.slice("branch refs/heads/".length).trim(), path);
      }
      if (!line.trim()) path = null;
    }
    return map;
  }

  /**
   * Compute a fresh merge-base for contamination checks. Mirrors the
   * executor's `resolveContaminationBaseRef`: prefer local `main` (the
   * canonical integration target for Fusion), fall back to `origin/main`
   * if the local ref isn't resolvable, and finally fall back to the
   * caller-supplied integration ref if both lookups fail (e.g. in repos
   * with a non-standard layout).
   */
  private async resolveContaminationBase(worktreePath: string, fallback: string): Promise<string> {
    try {
      const out = await this.runGit(
        worktreePath,
        "git merge-base HEAD main 2>/dev/null || git merge-base HEAD origin/main",
      );
      if (out) return out;
    } catch {
      // fall through to fallback
    }
    return fallback;
  }

  private async resolveRepoDir(ctx: AutoRecoveryContext, failure: AutoRecoveryFailure): Promise<string> {
    const repoFromFailure = typeof failure.evidence?.repoDir === "string" ? failure.evidence.repoDir : undefined;
    if (repoFromFailure) return repoFromFailure;
    if (ctx.task.worktree) {
      const top = await this.runGit(ctx.task.worktree, "git rev-parse --show-toplevel").catch(() => "");
      if (top) return top;
    }
    return process.cwd();
  }

  private async requeueAfterRecovery(task: Task, failure: AutoRecoveryFailure, rationale: string, evidence: RecoveryEvidence): Promise<void> {
    if (task.userPaused) return;
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-13:40 (batch-engine tail):
    TWO defects here, and fixing only the counted one would have been half a fix.

    1. The WIP test was the id `in-progress`, so on a renamed board the stale branch/baseCommitSha were
       never cleared and the requeued card carried a dead branch back into execution.
    2. The requeue DESTINATION was the hardcoded `todo` — census-invisible, because the census scores
       comparisons and this is a call argument. A board without a `todo` column was requeued into a lane
       that does not exist. `resolveReboundTarget` is the shared helper for exactly this (KTD-10 ordering:
       hold -> intake -> first column), and it is why the destination is resolved rather than guessed.

    Both fall back to the legacy ids: `resolveWorkflowIrForTask` degrades to the BUILT-IN IR rather than
    throwing, so a degraded board behaves exactly as before.
    */
    let wipColumns = new Set<string>(["in-progress"]);
    let reboundTarget = "todo";
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-14:40 (#2797 review — coderabbit):
    The catch no longer swallows. Falling back to the legacy ids stays — this is a RECOVERY path, and
    refusing to act because a workflow could not be read would strand the very task the handler exists
    to unstick — but the fallback is now RECORDED rather than silent, so "why did this land in `todo`"
    is answerable after the fact.

    Note the fallback is rarely what routes a custom board here: `resolveWorkflowIrForTask` degrades to
    the BUILT-IN IR instead of throwing, so an unreadable custom workflow resolves `todo` through the
    resolver and never reaches this catch. That is why the real protection is the move-rejection guard
    below, not this branch — this one only makes the rare hard failure visible.
    */
    let laneResolutionError: string | undefined;
    try {
      const ir = await resolveWorkflowIrForTask(this.deps.taskStore, task.id);
      if (ir) {
        const resolvedWip = columnsWithFlag(ir, "countsTowardWip");
        if (resolvedWip.length > 0) wipColumns = new Set<string>(resolvedWip);
        reboundTarget = resolveReboundTarget(ir) ?? "todo";
      }
    } catch (err) {
      laneResolutionError = err instanceof Error ? err.message : String(err);
    }


    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-13:45 (#2797 review — greptile):
    THE REQUEUE MUST NOT DIE ON A DESTINATION THE BOARD DOES NOT DECLARE.

    The review flagged the `catch` above retaining `reboundTarget = "todo"`. Tracing it, the exposure
    is wider than that branch: `resolveWorkflowIrForTask` degrades to the BUILT-IN IR rather than
    throwing, so a task whose custom workflow cannot be read resolves a target from the DEFAULT board
    — also `todo` — without the catch ever running. Guarding only the throw path would have looked
    like a fix and changed almost nothing.

    What actually bites is the move: `moveTaskInternal` REJECTS a destination the workflow does not
    declare (`TransitionRejectionError: unknown-column`). Unhandled, that throws out of the recovery
    handler whose whole job is to unstick the task — so the recovery became a second way for it to stay
    stuck, with no audit row to explain it.

    Catching at the move covers every route to a wrong destination, resolved or guessed. A task left
    parked WITH a record beats one parked by an exception nobody sees.
    */
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-17:45 (#2797 review — greptile P1 x2):

    ORDER: MOVE FIRST, THEN CLEAR THE BRANCH LINKAGE. The clear used to run BEFORE the move, so a
    rejected move left the card in its wip lane with `branch`/`baseCommitSha` already erased — the
    recovery destroyed the only pointers back to the work and then declined to requeue. Half-applied is
    worse than not applied: nothing else can reconstruct the branch from the row afterwards. The clear
    now happens only once the requeue has actually landed.

    REASON MUST NAME THE ACTUAL FAILURE. The catch labelled EVERY moveTask failure
    `rebound-target-rejected` — capacity exhaustion, a guard rejection, a deleted task, a persistence
    error — so the audit asserted a lane problem for causes that have nothing to do with lanes, and a
    reader debugging a stuck card would chase the wrong thing. `TransitionRejectionError` carries a typed
    `rejection.code`, so the unknown-column case is distinguishable exactly rather than by message match.

    Everything is still CAUGHT (an exception thrown out of the recovery handler is invisible), but the
    row now says which failure it was.
    */
    let moveFailure: { reason: string; code?: string } | undefined;
    try {
      await this.deps.taskStore.moveTask(task.id, reboundTarget, {
        moveSource: "engine",
        preserveResumeState: true,
        preserveProgress: true,
        preserveWorktree: false,
      });
    } catch (err) {
      const code = err instanceof TransitionRejectionError ? err.rejection.code : undefined;
      moveFailure = {
        reason: code === "unknown-column" ? "rebound-target-rejected" : "requeue-move-failed",
        ...(code ? { code } : {}),
      };
    }

    if (moveFailure) {
      await this.deps.runAudit.database({
        type: "branch-worktree:auto-requeue-skipped",
        target: task.id,
        metadata: {
          class: failure.class,
          reason: moveFailure.reason,
          ...(moveFailure.code ? { rejectionCode: moveFailure.code } : {}),
          rationale,
          ...(laneResolutionError ? { laneResolutionError } : {}),
          reboundTarget,
          column: task.column,
          /* Branch linkage deliberately NOT cleared on this path — see the note above. */
          branchPreserved: true,
          evidence,
        },
      });
      return;
    }

    if (wipColumns.has(task.column)) {
      await this.deps.taskStore.updateTask(task.id, { branch: null, baseCommitSha: null });
    }
    await this.deps.runAudit.database({
      type: "branch-worktree:auto-requeue",
      target: task.id,
      metadata: {
        class: failure.class,
        rationale,
        prevPausedReason: task.pausedReason ?? null,
        ...(laneResolutionError ? { laneResolutionError } : {}),
        evidence,
      },
    });
  }

  private async emitIrreduciblePause(task: Task, failure: AutoRecoveryFailure, reason: string, evidence: Record<string, unknown>): Promise<void> {
    await this.deps.runAudit.database({
      type: "branch-worktree:irreducible-pause",
      target: task.id,
      metadata: {
        class: failure.class,
        reason,
        evidence,
      },
    });
  }

  async issueRetry(failure: AutoRecoveryFailure, decision: AutoRecoveryDecision, ctx: AutoRecoveryContext): Promise<void> {
    if (ctx.task.userPaused) {
      this.logger.warn(`auto-recovery: skipped (userPaused) class=${failure.class} task=${ctx.task.id}`);
      return;
    }
    if (decision.auditMetadata.mode === "off") return;

    const repoDir = await this.resolveRepoDir(ctx, failure);
    const branchName = (ctx.task.branch ?? (typeof failure.evidence?.branchName === "string" ? failure.evidence.branchName : "")).trim();
    const conflictingWorktreePath = (ctx.task.worktree ?? (typeof failure.evidence?.conflictingWorktreePath === "string"
      ? failure.evidence.conflictingWorktreePath
      : typeof failure.evidence?.worktreePath === "string"
        ? failure.evidence.worktreePath
        : "")).trim();
    if (!branchName || !conflictingWorktreePath) return;

    const integrationBranch = await resolveIntegrationBranch(
      repoDir,
      ctx.settings as { integrationBranch?: string; baseBranch?: unknown },
    );
    const inspection = await inspectBranchConflict({
      repoDir,
      branchName,
      conflictingWorktreePath,
      requestingTaskId: ctx.task.id,
      ownerTaskId: ctx.task.id,
      startPoint: ctx.task.baseCommitSha ?? integrationBranch,
      integrationRef: integrationBranch,
    });

    if (inspection.kind === "stale-resolved" || inspection.kind === "fully-subsumed" || inspection.kind === "tip-already-merged") {
      await this.requeueAfterRecovery(ctx.task, failure, inspection.kind, {
        branchExists: await this.hasBranchRef(repoDir, branchName),
        worktreePresent: existsSync(conflictingWorktreePath),
        tipSha: "tipSha" in inspection ? inspection.tipSha : undefined,
        inspectionKind: inspection.kind,
      });
      return;
    }

    if (inspection.kind === "stale") {
      await this.runGit(repoDir, "git worktree prune").catch(() => undefined);
      const [branchExists, map] = await Promise.all([
        this.hasBranchRef(repoDir, branchName),
        this.getWorktreeBranchMap(repoDir),
      ]);
      if (!branchExists) {
        await this.requeueAfterRecovery(ctx.task, failure, "stale-branch-deleted", {
          branchExists,
          worktreePresent: false,
          inspectionKind: inspection.kind,
        });
        return;
      }
      if (!map.has(branchName)) {
        await this.requeueAfterRecovery(ctx.task, failure, "stale-resolved-after-prune", {
          branchExists,
          worktreePresent: false,
          inspectionKind: inspection.kind,
        });
        return;
      }
    }

    if (inspection.kind === "reclaimable" && inspection.taskAttributedCommitCount === 0) {
      // Resolve a fresh merge-base against local main (falling back to
      // origin/main) for the contamination base — `ctx.task.baseCommitSha`
      // is deliberately preserved across sessions for diff math (FN-4417)
      // and can lag main by hundreds of commits, which would flag every
      // legitimate landing as foreign.
      const misbindingBaseSha = await this.resolveContaminationBase(
        inspection.livePath,
        ctx.task.baseCommitSha ?? integrationBranch,
      );
      const bootstrap = await classifyBootstrapMisbinding({
        repoDir,
        branchName,
        baseSha: misbindingBaseSha,
        taskId: ctx.task.id,
      }).catch(() => ({
        isBootstrapMisbinding: false,
        ownCommitCount: 0,
        foreignCommitCount: 0,
        nonAttributedCount: 0,
      }));

      if (bootstrap.isBootstrapMisbinding) {
        const reanchor = await reanchorBranchToBase({
          repoDir,
          worktreePath: inspection.livePath,
          branchName,
          baseSha: misbindingBaseSha,
          taskId: ctx.task.id,
        }).catch(() => null);

        if (reanchor) {
          await this.requeueAfterRecovery(ctx.task, failure, "bootstrap-misbinding-reanchor", {
            branchExists: true,
            worktreePresent: true,
            tipSha: inspection.tipSha,
            inspectionKind: inspection.kind,
          });
          return;
        }
      }
    }

    if (inspection.kind === "live-foreign") {
      // FN-4847: discard-and-recreate. Previously this emitted irreducible-pause and the
      // task got stuck with "branch conflict unrecoverable". The user opted into
      // force-deleting the foreign branch (with stranded contamination commits) and
      // requeuing so the executor's next pickup creates a fresh `fusion/<task-id>`.
      // Safety: respect FN-4811 active-session gate — don't yank live worktrees.
      const tipSha = await this.getTipSha(repoDir, branchName);
      const isLiveOwned = activeSessionRegistry.isPathActive(conflictingWorktreePath);
      let branchDeleted = false;
      let worktreeRemoved = false;
      if (!isLiveOwned) {
        if (existsSync(conflictingWorktreePath)) {
          try {
            await execAsync(`git worktree remove --force ${this.quote(conflictingWorktreePath)}`, {
              cwd: repoDir,
              timeout: GIT_TIMEOUT_MS,
              maxBuffer: GIT_MAX_BUFFER,
            });
            worktreeRemoved = true;
          } catch (err) {
            this.logger.warn(`FN-4847 discard: worktree remove failed for ${conflictingWorktreePath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        try {
          await execAsync("git worktree prune", {
            cwd: repoDir,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
          });
        } catch {
          // best-effort
        }
        try {
          await execAsync(`git branch -D ${this.quote(branchName)}`, {
            cwd: repoDir,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
          });
          branchDeleted = true;
        } catch (err) {
          this.logger.warn(`FN-4847 discard: branch -D failed for ${branchName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await this.deps.runAudit.database({
        type: "branch-worktree:foreign-branch-discarded",
        target: ctx.task.id,
        metadata: {
          class: failure.class,
          branchName,
          conflictingWorktreePath,
          inspectionKind: inspection.kind,
          tipSha,
          isLiveOwned,
          branchDeleted,
          worktreeRemoved,
          rationale: "FN-4847 user-opted discard-and-recreate for cross-task contamination residue",
        },
      });
      await this.requeueAfterRecovery(ctx.task, failure, "live-foreign-discard-and-recreate", {
        branchExists: !branchDeleted,
        worktreePresent: !worktreeRemoved && existsSync(conflictingWorktreePath),
        tipSha,
        inspectionKind: inspection.kind,
      });
      return;
    }

    const branchExists = await this.hasBranchRef(repoDir, branchName);
    const tipSha = await this.getTipSha(repoDir, branchName);
    await this.emitIrreduciblePause(ctx.task, failure, "deterministic-unresolved", {
      branchName,
      conflictingWorktreePath,
      inspectionKind: inspection.kind,
      branchExists,
      worktreePresent: existsSync(conflictingWorktreePath),
      tipSha,
    });
  }

  async spawnAiRecovery(failure: AutoRecoveryFailure, decision: AutoRecoveryDecision, ctx: AutoRecoveryContext): Promise<void> {
    if (!this.deps.spawnAiRecoverySession) return;
    if (decision.auditMetadata.mode !== "ai-assisted") return;

    const result = await this.deps.spawnAiRecoverySession(failure, decision, ctx);
    await this.deps.runAudit.database({
      type: "branch-worktree:ai-session-spawned",
      target: ctx.task.id,
      metadata: {
        class: failure.class,
        outcome: result.outcome,
        evidence: {
          ...(failure.evidence ?? {}),
          allowedTools: ["bash:git-log", "bash:git-rev-parse", "bash:git-diff", "fn_task_create"],
        },
      },
    });

    if (result.outcome === "resolved") {
      await this.issueRetry(failure, decision, ctx);
      return;
    }

    await this.emitIrreduciblePause(ctx.task, failure, "ai-session-unresolved", {
      outcome: result.outcome,
      ...(result.metadata ?? {}),
    });
  }
}
