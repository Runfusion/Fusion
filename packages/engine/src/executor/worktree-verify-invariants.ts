/**
 * FNXC:CodeOrganization 2026-08-03-16:20:
 * verifyWorktreeInvariants + emitWorktreeReanchoredAudit peeled from TaskExecutor (U4 Slice B).
 * Workspace multi-repo and singular checkout invariant checks for fn_task_done / completion.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import type { Task, TaskStore } from "@fusion/core";
import { attemptBranchAutocorrect } from "../execution/branch-autocorrect.js";
import {
  detectNestedWorktreeRoot,
  isInsideWorktreesDir,
} from "../worktree/worktree-pool.js";
import { resolveWorktreesDir } from "../worktree/worktree-paths.js";
import {
  canonicalFusionBranchName,
  resolveTaskWorkingBranch,
} from "../worktree/worktree-names.js";
import { executorLog } from "../logger.js";
import { createRunAuditor, type EngineRunContext } from "../util/run-audit.js";
import { canonicalizePath } from "./session-worktree-paths.js";
import { resolveDiffBaseRef } from "./worktree-git-refs.js";
import { evaluatePromptDerivedNoCommitEligibility } from "./prompt-derived-eligibility.js";
import { getNoCommitEligibilityReason } from "./no-commit-eligibility.js";
import { resolveAuthoritativeExternalExecutionRoute } from "./resolve-authoritative-external-execution-route.js";

const execAsync = promisify(exec);

export type WorktreeInvariantResult =
  | { ok: true }
  | { ok: false; reason: "wrong_toplevel" | "wrong_branch" | "no_commits"; observed: string; expected: string; repo?: string };

export type WorktreeInvariantDeps = {
  rootDir: string;
  store: TaskStore;
  workspaceConfig: unknown | null | undefined;
  getActiveWorktreePaths: (taskId: string) => string[];
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  emitWorktreeReanchoredAudit: (
    taskId: string,
    fromPath: string,
    toPath: string,
    source: "verify-worktree-invariants" | "executor-liveness-gate",
  ) => Promise<void>;
};

export async function verifyWorktreeInvariants(
  deps: WorktreeInvariantDeps,
  task: Task,
  worktreePathOverride?: string,
  allowReanchor = true,
  options?: { noOpCompletion?: boolean; noOpCompletionReason?: string },
): Promise<WorktreeInvariantResult> {
  const settings = await deps.store.getSettings();
  // FNXC:Workspace 2026-06-21-23:30: KTD2 — un-stubbed per-repo worktree-invariant verification.
  // Phase A returned a flat {ok:true} stub here (no root worktree to verify against the non-git root). Phase B iterates every `task.workspaceWorktrees` entry, asserting (a) the sub-repo worktree's git toplevel matches the recorded repo.worktreePath and (b) its HEAD is on the recorded `fusion/<id>` branch (repo.branch). The result union is PRESERVED EXACTLY — `{ok:true} | {ok:false; reason:'wrong_toplevel'|'wrong_branch'|'no_commits'; observed; expected}` — because the :10889 consumer switches on `reason` to drive requeue/handoff (:10894-10936). We ADD an optional `repo` field to the failure shape (purely additive; the consumer only reads reason/observed/expected) and return the FIRST failing repo. A zero-acquire workspace task (empty map) verifies vacuously → {ok:true}, matching Phase A so fn_task_done does not requeue it.
  if (deps.workspaceConfig) {
    const workspaceWorktrees = task.workspaceWorktrees ?? {};
    // FNXC:Workspace 2026-06-22-00:00: KTD2 — resolve the SAME task-wide no-commit eligibility the singular path
    // uses (getNoCommitEligibilityReason / no-op-completion sentinel / prompt-derived), once, before the per-repo
    // loop. When eligible (Plan-Only, verified no-op, etc.) the per-repo no_commits guard below is skipped so an
    // intentionally commit-free workspace task is not blocked from completion.
    const workspacePromptContent = (task as Task & { prompt?: unknown }).prompt;
    const workspacePromptEligibility = evaluatePromptDerivedNoCommitEligibility(
      task,
      typeof workspacePromptContent === "string" ? workspacePromptContent : "",
    );
    const workspaceNoCommitEligibilityReason =
      getNoCommitEligibilityReason(task) ??
      (options?.noOpCompletion
        ? options.noOpCompletionReason ?? "verified no-op/duplicate completion sentinel"
        : null) ??
      (workspacePromptEligibility.eligible
        ? workspacePromptEligibility.reason ?? "prompt-derived no-commit eligibility"
        : null);
    if (workspaceNoCommitEligibilityReason) {
      executorLog.debug(`${task.id}: workspace fn_task_done no_commits guard skipped (${workspaceNoCommitEligibilityReason})`);
    }
    // FNXC:Workspace 2026-06-21-15:00: F6 — iterate sorted repo keys so the FIRST failing repo
    // returned here is deterministic across runs/rehydrate (the value is surfaced to the operator).
    for (const repoRel of Object.keys(workspaceWorktrees).sort()) {
      const repo = workspaceWorktrees[repoRel];
      const expectedBranch = repo.branch || canonicalFusionBranchName(task.id);
      // Skip git checks if the worktree dir is gone (mirrors the singular FN-009 carve-out below): completion does not require a live worktree on disk.
      if (!existsSync(repo.worktreePath)) {
        executorLog.log(`${task.id}: workspace worktree for ${repoRel} not found at ${repo.worktreePath} — skipping git validation`);
        continue;
      }
      let expectedWorktreeRealpath: string;
      try {
        expectedWorktreeRealpath = canonicalizePath(repo.worktreePath);
      } catch (error) {
        return {
          ok: false,
          reason: "wrong_toplevel",
          repo: repoRel,
          observed: `unresolvable repo worktree (${repo.worktreePath}): ${error instanceof Error ? error.message : String(error)}`,
          expected: `resolvable worktree for ${repoRel}`,
        };
      }
      try {
        const { stdout } = await execAsync("git rev-parse --show-toplevel", {
          cwd: repo.worktreePath,
          encoding: "utf-8",
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        });
        const observedTopLevelRaw = stdout.trim();
        if (observedTopLevelRaw) {
          const observedTopLevel = canonicalizePath(observedTopLevelRaw);
          if (observedTopLevel !== expectedWorktreeRealpath) {
            return {
              ok: false,
              reason: "wrong_toplevel",
              repo: repoRel,
              observed: observedTopLevel,
              expected: expectedWorktreeRealpath,
            };
          }
        }
      } catch (error) {
        return {
          ok: false,
          reason: "wrong_toplevel",
          repo: repoRel,
          observed: error instanceof Error ? error.message : String(error),
          expected: expectedWorktreeRealpath,
        };
      }
      try {
        const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
          cwd: repo.worktreePath,
          encoding: "utf-8",
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        });
        const observedBranch = stdout.trim();
        if (observedBranch && observedBranch !== expectedBranch) {
          return {
            ok: false,
            reason: "wrong_branch",
            repo: repoRel,
            observed: observedBranch,
            expected: expectedBranch,
          };
        }
      } catch (error) {
        return {
          ok: false,
          reason: "wrong_branch",
          repo: repoRel,
          observed: error instanceof Error ? error.message : String(error),
          expected: expectedBranch,
        };
      }
      // FNXC:Workspace 2026-06-22-00:00: KTD2 — per-repo no_commits guard (parity with the singular path at :10821).
      // Phase B originally returned {ok:true} after the toplevel/branch checks, so a workspace task could call
      // fn_task_done having committed NOTHING in any sub-repo (scope-leak sees zero touched files, branch names match)
      // and still advance to in-review. Enforce the same `git rev-list --count <base>..HEAD > 0` invariant per repo,
      // gated by the SAME task-wide no-commit eligibility below so Plan-Only / no-op-sentinel tasks stay exempt.
      // The first sub-repo with zero commits fails with reason:'no_commits' (consumer-stable union).
      if (!workspaceNoCommitEligibilityReason) {
        const repoBaseRef = await resolveDiffBaseRef(repo.worktreePath, repo.baseCommitSha);
        if (repoBaseRef) {
          try {
            const { stdout } = await execAsync(`git rev-list --count ${repoBaseRef}..HEAD`, {
              cwd: repo.worktreePath,
              encoding: "utf-8",
              timeout: 10_000,
              maxBuffer: 1024 * 1024,
            });
            const trimmedCount = stdout.trim();
            if (trimmedCount) {
              const count = Number.parseInt(trimmedCount, 10);
              if (!Number.isFinite(count) || count <= 0) {
                return {
                  ok: false,
                  reason: "no_commits",
                  repo: repoRel,
                  observed: Number.isFinite(count) ? String(count) : trimmedCount,
                  expected: "> 0",
                };
              }
            }
          } catch (error) {
            return {
              ok: false,
              reason: "no_commits",
              repo: repoRel,
              observed: error instanceof Error ? error.message : String(error),
              expected: `git rev-list --count ${repoBaseRef}..HEAD > 0`,
            };
          }
        } else {
          executorLog.warn(`${task.id}: unable to resolve diff base for ${repoRel} no_commits guard; skipping for this sub-repo`);
        }
      }
    }
    return { ok: true };
  }
  /*
  FNXC:ExternalExecutionCheckout 2026-08-09-23:53:
  Completion verification must use the live external route and reject invalid persisted metadata rather than falling back to a stale Fusion-managed worktree snapshot.
  */
  const { task: authoritativeVerificationTask, route: externalExecutionRoute } =
    await resolveAuthoritativeExternalExecutionRoute(deps.store, task);
  if (externalExecutionRoute.configured && !externalExecutionRoute.valid) {
    return {
      ok: false,
      reason: "wrong_toplevel",
      observed: externalExecutionRoute.reason ?? "invalid persisted external execution checkout",
      expected: "valid persisted external execution checkout",
    };
  }
  const branchName = externalExecutionRoute.configured
    ? externalExecutionRoute.branch ?? ""
    : resolveTaskWorkingBranch(authoritativeVerificationTask);
  // Non-workspace tasks hold a one-element set; fall back to its sole member to preserve the original singular resolution.
  const worktreePath = externalExecutionRoute.configured
    ? externalExecutionRoute.checkoutPath ?? null
    : worktreePathOverride
      ?? authoritativeVerificationTask.worktree
      ?? deps.getActiveWorktreePaths(task.id)[0]
      ?? null;

  if (!worktreePath) {
    return {
      ok: false,
      reason: "wrong_toplevel",
      observed: "missing task.worktree",
      expected: `registered task worktree under ${resolveWorktreesDir(deps.rootDir, settings)}/*`,
    };
  }

  const expectedRoot = canonicalizePath(deps.rootDir);
  let expectedWorktreeRealpath: string;
  try {
    expectedWorktreeRealpath = canonicalizePath(worktreePath);
  } catch (error) {
    return {
      ok: false,
      reason: "wrong_toplevel",
      observed: `unresolvable task.worktree (${worktreePath}): ${error instanceof Error ? error.message : String(error)}`,
      expected: `resolvable task worktree under ${resolveWorktreesDir(deps.rootDir, settings)}/*`,
    };
  }

  // FN-009: If worktree directory doesn't exist, skip git validation for task completion.
  // This is safe because:
  // 1. Task completion doesn't modify the worktree
  // FNXC:PostgresRuntimeStorage 2026-07-14-18:47: Deliverables (task documents and follow-up tasks) are stored in the project-scoped PostgreSQL store.
  // 3. If code changes were made, the worktree would exist
  // 4. This prevents ENOENT errors when agents complete documentation/coordination tasks
  if (!existsSync(worktreePath)) {
    executorLog.log(
      `${task.id}: worktree directory not found at ${worktreePath} — skipping git validation for task completion`,
    );
    return { ok: true };
  }

  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const observedTopLevelRaw = stdout.trim();
    if (observedTopLevelRaw) {
      const observedTopLevel = canonicalizePath(observedTopLevelRaw);

      /*
      FNXC:ExternalExecutionCheckout 2026-08-09-23:53:
      An operator-routed checkout must match its validated Git top-level exactly. Nested-worktree re-anchoring is reserved for Fusion-managed worktrees and must not widen this ownership boundary.
      */
      const violatesCheckoutBoundary = externalExecutionRoute.configured
        ? observedTopLevel !== expectedWorktreeRealpath
        : observedTopLevel === expectedRoot
          || !isInsideWorktreesDir(deps.rootDir, observedTopLevel, settings)
          || observedTopLevel !== expectedWorktreeRealpath;
      if (violatesCheckoutBoundary) {
        if (!externalExecutionRoute.configured && allowReanchor && observedTopLevel !== expectedRoot && isInsideWorktreesDir(deps.rootDir, observedTopLevel, settings)) {
          const reanchor = await detectNestedWorktreeRoot(deps.rootDir, worktreePath, settings);
          if (reanchor.reanchored) {
            await deps.store.updateTask(task.id, { worktree: reanchor.root });
            executorLog.log(`${task.id}: re-anchored nested task.worktree ${worktreePath} -> ${reanchor.root}`);
            await deps.store.logEntry(task.id, `Re-anchored nested task.worktree from ${worktreePath} to ${reanchor.root}`, undefined, deps.getRunContextFor(task.id));
            await deps.emitWorktreeReanchoredAudit(task.id, worktreePath, reanchor.root, "verify-worktree-invariants");
            return verifyWorktreeInvariants(deps, task, reanchor.root, false, options);
          }
        }
        return {
          ok: false,
          reason: "wrong_toplevel",
          observed: observedTopLevel,
          expected: expectedWorktreeRealpath,
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: "wrong_toplevel",
      observed: error instanceof Error ? error.message : String(error),
      expected: expectedWorktreeRealpath,
    };
  }

  try {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const observedBranch = stdout.trim();
    if (observedBranch && observedBranch !== branchName) {
      if (observedBranch.toLowerCase() === branchName.toLowerCase()) {
        executorLog.log(`${task.id}: branch case-mismatch detected; canonicalizing observed=${observedBranch} expected=${branchName}`);
        const autocorrectResult = await attemptBranchAutocorrect({
          worktreePath,
          observedBranch,
          expectedBranch: branchName,
          rootDir: deps.rootDir,
        });
        if (autocorrectResult.status !== "failed") {
          const auditor = createRunAuditor(deps.store, deps.getRunContextFor(task.id));
          await auditor.git({
            type: "branch:auto-canonicalize-case",
            target: worktreePath,
            metadata: {
              taskId: task.id,
              observed: observedBranch,
              expected: branchName,
              worktreePath,
              mode: autocorrectResult.status,
            },
          });
          return { ok: true };
        }
        executorLog.warn(`${task.id}: failed to canonicalize branch case mismatch: ${autocorrectResult.reason ?? "unknown"}`);
      }
      return {
        ok: false,
        reason: "wrong_branch",
        observed: observedBranch,
        expected: branchName,
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason: "wrong_branch",
      observed: error instanceof Error ? error.message : String(error),
      expected: branchName,
    };
  }

  const promptContent = (task as Task & { prompt?: unknown }).prompt;
  const promptDerivedEligibility = evaluatePromptDerivedNoCommitEligibility(
    task,
    typeof promptContent === "string" ? promptContent : "",
  );
  const noCommitEligibilityReason =
    getNoCommitEligibilityReason(task) ??
    (options?.noOpCompletion
      ? options.noOpCompletionReason ?? "verified no-op/duplicate completion sentinel"
      : null) ??
    (promptDerivedEligibility.eligible
      ? promptDerivedEligibility.reason ?? "prompt-derived no-commit eligibility"
      : null);
  if (noCommitEligibilityReason) {
    executorLog.debug(`${task.id}: fn_task_done no_commits guard skipped (${noCommitEligibilityReason})`);
    try {
      await deps.store.logEntry(
        task.id,
        `fn_task_done no_commits guard skipped (${noCommitEligibilityReason})`,
        undefined,
        deps.getRunContextFor(task.id),
      );
    } catch (error) {
      executorLog.warn(
        `${task.id}: failed to write no_commits guard skip audit log: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { ok: true };
  }

  const baseRef = await resolveDiffBaseRef(worktreePath, task.baseCommitSha);
  if (!baseRef) {
    executorLog.warn(`${task.id}: unable to resolve diff base for invariant commit-count check; skipping no_commits guard`);
    return { ok: true };
  }

  try {
    const { stdout } = await execAsync(`git rev-list --count ${baseRef}..HEAD`, {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const trimmedCount = stdout.trim();
    if (!trimmedCount) {
      return { ok: true };
    }
    const count = Number.parseInt(trimmedCount, 10);
    if (!Number.isFinite(count) || count <= 0) {
      return {
        ok: false,
        reason: "no_commits",
        observed: Number.isFinite(count) ? String(count) : stdout.trim(),
        expected: "> 0",
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason: "no_commits",
      observed: error instanceof Error ? error.message : String(error),
      expected: `git rev-list --count ${baseRef}..HEAD > 0`,
    };
  }

  return { ok: true };
}

export async function emitWorktreeReanchoredAudit(
  deps: Pick<WorktreeInvariantDeps, "store" | "getRunContextFor">,
  taskId: string,
  fromPath: string,
  toPath: string,
  source: "verify-worktree-invariants" | "executor-liveness-gate",
): Promise<void> {
  const runContext = deps.getRunContextFor(taskId);
  if (!runContext?.runId || !runContext.agentId) return;
  const auditor = createRunAuditor(deps.store, {
    runId: runContext.runId,
    agentId: runContext.agentId,
    taskId,
    phase: "execute",
  });
  await auditor.git({
    type: "worktree:reanchored",
    target: toPath,
    metadata: {
      taskId,
      fromPath,
      toPath,
      source,
    },
  });
}
