/**
 * FNXC:CodeOrganization 2026-08-03-16:35:
 * evaluateTaskDoneScopeLeak peeled from TaskExecutor (U4 Slice B).
 * fn_task_done File Scope leak guard (workspace multi-repo + singular checkout).
 */
import type { Settings, Task, TaskStore } from "@fusion/core";
import { deriveRepoScopeSubset } from "../worktree/workspace-paths.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext, RunAuditor } from "../util/run-audit.js";
import { parseReviewLevelFromPrompt } from "./prompt-derived-eligibility.js";
import {
  isAlwaysAllowedScopeLeakPath,
  workflowPathMatchesDeclaredScope,
} from "./workflow-feedback-paths.js";

export type TaskDoneScopeLeakDeps = {
  store: TaskStore;
  workspaceConfig: unknown | null | undefined;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  captureUncommittedModifiedFiles: (worktreePath: string) => Promise<string[]>;
  captureModifiedFiles: (
    worktreePath: string,
    baseCommitSha: string | undefined,
    taskId: string,
    audit?: RunAuditor,
    source?: string,
  ) => Promise<string[]>;
};

export async function evaluateTaskDoneScopeLeak(
  deps: TaskDoneScopeLeakDeps,
  task: Task,
  worktreePath: string,
  promptContent: string,
  settings: Settings,
  audit?: RunAuditor,
): Promise<{ blocked: false } | { blocked: true; message: string }> {
  if (task.scopeOverride === true) {
    executorLog.debug(`${task.id}: scope-leak guard bypassed (scopeOverride=true)`);
    await deps.store.logEntry(task.id, "[scope-leak] scope guard bypassed via task.scopeOverride", undefined, deps.getRunContextFor(task.id));
    return { blocked: false };
  }

  const declaredScope = await deps.store.parseFileScopeFromPrompt(task.id).catch(() => [] as string[]);
  if (declaredScope.length === 0) {
    return { blocked: false };
  }

  const reviewLevel = parseReviewLevelFromPrompt(promptContent);
  const configuredMode = settings.planOnlyScopeLeakEnforcement ?? "warn";
  const enforcementMode: "off" | "warn" | "block" = reviewLevel === 1
    ? configuredMode
    : "warn";

  if (enforcementMode === "off") {
    return { blocked: false };
  }

  // FNXC:Workspace 2026-06-22-00:30: KTD4 — per-repo scope-leak guard.
  // The singular capture below runs `captureUncommittedModifiedFiles` + `captureModifiedFiles`
  // against `worktreePath`. In workspace mode `worktreePath` is the browse-only non-git workspace
  // root, so both silently return [] (git failures swallowed) and the uncommitted-in-scope block
  // never fires — a workspace task could complete with off-scope changes in any sub-repo. So we
  // ITERATE every acquired sub-repo (cwd = repo.worktreePath, base = repo.baseCommitSha) and block
  // on the FIRST repo carrying off-scope changes — naming the repo. The task-level preamble above
  // (scopeOverride / declaredScope / enforcementMode) is shared and runs once. Return shape is
  // preserved: `{blocked:false} | {blocked:true; message}`.
  //
  // FNXC:Workspace 2026-06-21-15:00: F1/F2/F5/F6 hardening of the per-repo scope-leak guard.
  // F5 (false-block fix + dead-code wiring + single filter surface): we previously repo-prefixed each
  // touched file (`${repoRel}/${file}`) BEFORE filtering, so `isAlwaysAllowedScopeLeakPath`'s
  // `startsWith(".changeset/")` carve-out never matched a sub-repo changeset (`repo-a/.changeset/x.md`)
  // and a legit per-repo changeset was wrongly flagged off-scope → fn_task_done wrongly REFUSED. Now we
  // derive each repo's repo-LOCAL declared-scope subset (`deriveRepoScopeSubset`) and run the SAME
  // `workflowPathMatchesDeclaredScope` + `isAlwaysAllowedScopeLeakPath` filter the non-workspace path
  // uses against the repo-LOCAL touched file — one filter surface, not two. This wires in the formerly
  // dead `deriveRepoScopeSubset`/`splitRepoScopedPath` helpers.
  // F1 (fail CLOSED on throw): each repo iteration is wrapped in its own try/catch (like the
  // attribution-audit loop). A thrown capture/diff error in workspace mode surfaces as a BLOCK naming
  // the repo instead of bubbling to the outer `.catch()` that fails OPEN — an incomplete scope check
  // must never let fn_task_done proceed.
  // F2 (scoped-but-zero-acquire): a scoped task that acquired NO sub-repo worktrees aggregates zero
  // off-scope files and would silently pass; we block it (scope is declared but unverifiable).
  // F6 (deterministic ordering): iterate sorted repo keys so the reported offending repo is stable
  // across runs/rehydrate.
  let touchedFiles: string[];
  let offendingRepo: string | undefined;
  if (deps.workspaceConfig) {
    const workspaceWorktrees = task.workspaceWorktrees ?? {};
    const repoKeys = Object.keys(workspaceWorktrees).sort();
    // F2: declaredScope is non-empty here (the `declaredScope.length === 0` early-return above
    // handled the unscoped case). A scoped task that acquired no sub-repo worktrees cannot have its
    // scope verified at all — refuse rather than silently passing scope enforcement.
    if (repoKeys.length === 0) {
      const message = "workspace task declares File Scope but acquired no sub-repo worktrees — cannot verify scope";
      executorLog.warn(`${task.id}: [scope-leak] ${message}`);
      await deps.store.logEntry(task.id, `[scope-leak] ${message}`, undefined, deps.getRunContextFor(task.id));
      return { blocked: true, message };
    }
    const aggregatedOffScope: string[] = [];
    for (const repoRel of repoKeys) {
      const repo = workspaceWorktrees[repoRel];
      try {
        const [repoUncommitted, repoCommitted] = await Promise.all([
          deps.captureUncommittedModifiedFiles(repo.worktreePath),
          deps.captureModifiedFiles(repo.worktreePath, repo.baseCommitSha ?? undefined, task.id, audit, "scope-leak-guard"),
        ]);
        // Repo-LOCAL touched files (no `${repoRel}/` prefix) so the always-allowed `.changeset/`
        // carve-out and the scope match operate as the reviewer/cwd=repo sees them (F5).
        const repoTouched = [...new Set([...repoUncommitted, ...repoCommitted])];
        // Repo-LOCAL declared-scope subset for THIS repo (prefix stripped). Same filter as the
        // non-workspace branch below — one surface.
        const repoScopeSubset = deriveRepoScopeSubset(declaredScope, repoRel);
        const repoOffScope = repoTouched
          .filter((filePath) => !workflowPathMatchesDeclaredScope(filePath, repoScopeSubset))
          .filter((filePath) => !isAlwaysAllowedScopeLeakPath(filePath))
          // Re-prefix the surviving off-scope files for the operator-facing message/attribution.
          .map((filePath) => `${repoRel}/${filePath}`);
        if (repoOffScope.length > 0) {
          // First offending repo wins (mirrors verifyWorktreeInvariants' first-failing-repo return).
          if (!offendingRepo) offendingRepo = repoRel;
          aggregatedOffScope.push(...repoOffScope);
        }
      } catch (repoErr: unknown) {
        // F1: fail CLOSED. A capture/diff throw means scope is UNVERIFIED for this repo; refuse
        // fn_task_done as a precaution rather than letting the outer `.catch()` fail open.
        const errMessage = repoErr instanceof Error ? repoErr.message : String(repoErr);
        const message = `workspace scope-leak guard failed to evaluate (${repoRel}/${errMessage}) — refusing fn_task_done as a precaution`;
        executorLog.warn(`${task.id}: [scope-leak] ${message}`);
        await deps.store.logEntry(task.id, `[scope-leak] ${message}`, undefined, deps.getRunContextFor(task.id));
        return { blocked: true, message };
      }
    }
    touchedFiles = aggregatedOffScope;
    if (touchedFiles.length === 0) {
      return { blocked: false };
    }
  } else {
    const [uncommittedTouchedFiles, branchCommittedFiles] = await Promise.all([
      deps.captureUncommittedModifiedFiles(worktreePath),
      deps.captureModifiedFiles(worktreePath, task.baseCommitSha ?? undefined, task.id, audit, "scope-leak-guard"),
    ]);
    touchedFiles = [...new Set([...uncommittedTouchedFiles, ...branchCommittedFiles])];
    if (touchedFiles.length === 0) {
      return { blocked: false };
    }
  }

  const offScopeFiles = (deps.workspaceConfig
    // In workspace mode `touchedFiles` is already the off-scope set (filtered per repo above).
    ? touchedFiles
    : touchedFiles
      .filter((filePath) => !workflowPathMatchesDeclaredScope(filePath, declaredScope))
      // FN-4811 follow-up: by convention every task may add its own changeset entry
      // under `.changeset/`, so changeset files are always considered in-scope and
      // never flagged by the scope-leak guard. The file-scope invariant at squash and
      // the broader contamination guards still catch cross-task changeset leakage at
      // a higher signal-to-noise ratio than the per-execution scope-leak warning.
      .filter((filePath) => !isAlwaysAllowedScopeLeakPath(filePath)));
  if (offScopeFiles.length === 0) {
    return { blocked: false };
  }

  const renderListPreview = (items: string[], cap = 10): string => {
    if (items.length <= cap) {
      return items.join(", ");
    }
    const remaining = items.length - cap;
    return `${items.slice(0, cap).join(", ")}, … (+${remaining} more)`;
  };

  const offScopePreview = renderListPreview(offScopeFiles);
  const declaredScopePreview = renderListPreview(declaredScope);
  // Name the offending sub-repo in workspace mode so the operator/agent knows where to revert.
  const repoTag = offendingRepo ? ` repo=${offendingRepo}` : "";
  const message = `[scope-leak] reviewLevel=${reviewLevel} enforcement=${enforcementMode}${repoTag} off-scope touched files [${offScopePreview}]; declared scope [${declaredScopePreview}]; total off-scope=${offScopeFiles.length} total scope=${declaredScope.length}`;
  executorLog.warn(`${task.id}: ${message}`);
  await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));

  if (enforcementMode === "block") {
    return {
      blocked: true,
      message: `Plan-Only scope-leak guard refused fn_task_done${offendingRepo ? ` (sub-repo ${offendingRepo})` : ""}. Off-scope paths: [${offScopePreview}]. Revert them before retrying (for example: git checkout -- <paths>).`,
    };
  }

  return { blocked: false };
}

