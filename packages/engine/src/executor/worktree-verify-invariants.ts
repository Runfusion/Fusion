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
import { classifyWorkspaceZeroAcquire } from "./workspace-zero-acquire.js";
import { evaluatePromptDerivedNoCommitEligibility } from "./prompt-derived-eligibility.js";
import { getNoCommitEligibilityReason } from "./no-commit-eligibility.js";
import { resolveAuthoritativeExternalExecutionRoute } from "./resolve-authoritative-external-execution-route.js";
import { detectWorkspaceMainCheckoutWork } from "./workspace-main-checkout-guard.js";

const execAsync = promisify(exec);

export type WorktreeInvariantResult =
  | { ok: true }
  | { ok: false; reason: "wrong_toplevel" | "wrong_branch" | "no_commits" | "main_checkout_edit"; observed: string; expected: string; repo?: string };

export type WorktreeInvariantDeps = {
  rootDir: string;
  store: TaskStore;
  workspaceConfig: unknown | null | undefined;
  ensureWorkspaceConfig?: () => Promise<unknown | null>;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  /** FNXC:Identity 2026-08-15-22:52 (U18 Stage C): total carrier for store mutations. */
  runContextFor: (taskId: string, fallbackAgentId?: string | null) => import("@fusion/core").RunMutationContext;
  getActiveWorktreePaths: (taskId: string) => string[];
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
  const workspaceConfig = deps.ensureWorkspaceConfig
    ? await deps.ensureWorkspaceConfig()
    : deps.workspaceConfig;
  const settings = await deps.store.getSettings();
  // FNXC:Workspace 2026-08-15-04:21:
  // Per-repo review consumes the same zero-acquire map. Classify it before the
  // loop so fn_task_done accepts only a proven commit-free task instead of
  // vacuously accepting work that review must honestly leave unavailable.
  if (workspaceConfig) {
    const workspaceWorktrees = task.workspaceWorktrees ?? {};
    const configuredRepos = Array.isArray((workspaceConfig as { repos?: unknown }).repos)
      ? (workspaceConfig as { repos: string[] }).repos
      : [];
    // FNXC:Workspace 2026-08-15-07:05:
    // This must precede zero-acquire and per-worktree returns: a direct main-checkout commit
    // leaves the acquired worktree empty, otherwise masking the actual, clearable bypass as no_commits.
    const declaredScope = typeof deps.store.parseFileScopeFromPrompt === "function"
      ? await deps.store.parseFileScopeFromPrompt(task.id).catch(() => [] as string[])
      : [];
    const mainCheckout = await detectWorkspaceMainCheckoutWork(
      { rootDir: deps.rootDir, settings }, task, configuredRepos, declaredScope,
    );
    const auditor = createRunAuditor(deps.store, deps.runContextFor(task.id));
    for (const warning of mainCheckout.warnings) {
      executorLog.warn(`${task.id}: workspace main-checkout guard warning repo=${warning.repo} reason=${warning.reason}`);
      await auditor.git({ type: "worktree:workspace-main-checkout-edit", target: warning.repo, metadata: {
        taskId: task.id, repo: warning.repo, fileCount: warning.files.length, commitCount: warning.commits.length,
        reason: warning.reason, taskDoneRetryCount: task.taskDoneRetryCount ?? 0, outcome: "warned",
      } });
    }
    for (const repo of mainCheckout.skipped) {
      await auditor.git({ type: "worktree:workspace-main-checkout-edit", target: repo, metadata: {
        taskId: task.id, repo, fileCount: 0, commitCount: 0, taskDoneRetryCount: task.taskDoneRetryCount ?? 0, outcome: "skipped",
      } });
    }
    const firstMainCheckoutViolation = mainCheckout.violations[0];
    if (firstMainCheckoutViolation) {
      await auditor.git({ type: "worktree:workspace-main-checkout-edit", target: firstMainCheckoutViolation.repo, metadata: {
        taskId: task.id, repo: firstMainCheckoutViolation.repo, fileCount: firstMainCheckoutViolation.files.length,
        commitCount: firstMainCheckoutViolation.commits.length, evidence: firstMainCheckoutViolation.evidence,
        taskDoneRetryCount: task.taskDoneRetryCount ?? 0, outcome: "blocked",
      } });
      const observed = [
        ...firstMainCheckoutViolation.files.slice(0, 10),
        ...firstMainCheckoutViolation.commits.slice(0, 10).map((sha) => sha.slice(0, 12)),
      ].join(", ");
      return {
        ok: false, reason: "main_checkout_edit", repo: firstMainCheckoutViolation.repo,
        observed: `${firstMainCheckoutViolation.evidence}: ${observed}`,
        expected: `move task work into the acquired fusion/${task.id} worktree for ${firstMainCheckoutViolation.repo} (acquire it first if needed), restore its main checkout, then ask an operator to retry fn_task_done`,
      };
    }
    const zeroAcquire = classifyWorkspaceZeroAcquire(task, {
      workspaceMode: true,
      noOpCompletion: options?.noOpCompletion,
      noOpCompletionReason: options?.noOpCompletionReason,
    });
    if (zeroAcquire.kind === "commit-free-eligible") {
      executorLog.debug(`${task.id}: workspace fn_task_done zero-acquire accepted (${zeroAcquire.reason})`);
      return { ok: true };
    }
    if (zeroAcquire.kind === "unproven") {
      return {
        ok: false,
        reason: "no_commits",
        observed: "0 acquired sub-repo worktrees",
        expected: "at least one acquired sub-repo worktree (fn_acquire_repo_worktree), or a no-op completion sentinel / noCommitsExpected",
      };
    }
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
    // FNXC:Workspace 2026-06-21-15:00: F6 — iterate sorted repo keys so the FIRST failing repo
    // returned here is deterministic across runs/rehydrate (the value is surfaced to the operator).
    const commitCounts: string[] = [];
    let totalCommitCount = 0;
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
            const count = Number.parseInt(trimmedCount, 10);
            if (!Number.isFinite(count) || count < 0) {
              return {
                ok: false,
                reason: "no_commits",
                repo: repoRel,
                observed: trimmedCount,
                expected: `git rev-list --count ${repoBaseRef}..HEAD > 0`,
              };
            }
            commitCounts.push(`${repoRel}=${count}`);
            totalCommitCount += count;
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
    /*
    FNXC:Workspace 2026-08-14-21:06:
    A workspace task may legitimately change only a subset of acquired repositories. The commit
    invariant is task-wide, because rejecting the first empty repository blocked committed work (issue #3435).
    */
    if (!workspaceNoCommitEligibilityReason && commitCounts.length > 0 && totalCommitCount === 0) {
      return { ok: false, reason: "no_commits", observed: commitCounts.join(", "), expected: "> 0" };
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
            await deps.store.logEntry(task.id, `Re-anchored nested task.worktree from ${worktreePath} to ${reanchor.root}`, undefined, deps.runContextFor(task.id));
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
          const auditor = createRunAuditor(deps.store, deps.runContextFor(task.id));
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
        deps.runContextFor(task.id),
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
  deps: Pick<WorktreeInvariantDeps, "store" | "getRunContextFor" | "runContextFor">,
  taskId: string,
  fromPath: string,
  toPath: string,
  source: "verify-worktree-invariants" | "executor-liveness-gate",
): Promise<void> {
  const runContext = deps.runContextFor(taskId);
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
