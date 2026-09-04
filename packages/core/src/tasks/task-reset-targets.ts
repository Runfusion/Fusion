import { join, resolve } from "node:path";
import { isWorkspaceTask, type Settings, type Task } from "../types.js";
import {
  assertWorkspaceRepoRelPath,
  isLegacyWorkspaceWorktreeLayout,
  resolveWorktreesDirLayout,
  resolveWorkspaceTaskWorktreeDir,
} from "./worktree-layout.js";

export const SINGULAR_RESET_WORKTREE_REPO_REL = "__singular_worktree__";

export interface TaskResetWorktreeTarget {
  repoRel: string;
  worktreePath: string;
  canonicalPath: string;
  branch?: string;
  repoRootDir: string;
  containmentRoot: string;
  reservationWorktreesDir: string;
  aliasRepoRels: string[];
}

export interface TaskResetWorktreePlan {
  kind: "singular" | "workspace";
  layout: "singular" | "workspace-task-dir" | "workspace-legacy";
  targets: TaskResetWorktreeTarget[];
  branchCleanupTargets: Array<{ repoRootDir: string; recordedBranches: string[] }>;
  workspaceTaskDir?: string;
  canonicalSingularWorktreePath?: string;
  ignoredSingularWorktree?: string;
}

export interface BuildTaskResetWorktreePlanOptions {
  rootDir: string;
  settings: Pick<Settings, "worktreesDir"> | undefined;
}

/*
FNXC:TaskReset 2026-08-27-22:02:
Reset derives its target directories and reservation roots from the same workspace layout
math as acquisition, so a per-repository reset reservation excludes a concurrent acquire.
A workspace task's singular pointer is ignored unless it aliases a recorded repository child:
the workspace root is a coordinator, not a disposable Git worktree.
*/
export function buildTaskResetWorktreePlan(
  task: Pick<Task, "id" | "worktree" | "branch" | "workspaceWorktrees">,
  { rootDir, settings }: BuildTaskResetWorktreePlanOptions,
): TaskResetWorktreePlan {
  /*
  FNXC:TaskReset 2026-08-30-01:40:
  Since FN-258 the singular worktree directory name is the immutable lower-cased task ID. Reset must
  always plan that exclusive canonical path because a user reopen clears `task.worktree` and must not
  make a task-owned worktree unreachable to Reset.
  */
  const hasWorkspaceRecord = task.workspaceWorktrees !== undefined;
  if (!isWorkspaceTask(task) && !hasWorkspaceRecord) {
    const worktreesDir = resolveWorktreesDirLayout(rootDir, settings);
    const canonicalSingularWorktreePath = join(worktreesDir, task.id.toLowerCase());
    const targetsByCanonical = new Map<string, TaskResetWorktreeTarget>();
    const addTarget = (worktreePath: string) => {
      const canonicalPath = resolve(worktreePath);
      if (targetsByCanonical.has(canonicalPath)) return;
      targetsByCanonical.set(canonicalPath, {
        repoRel: SINGULAR_RESET_WORKTREE_REPO_REL,
        worktreePath,
        canonicalPath,
        branch: task.branch,
        repoRootDir: rootDir,
        containmentRoot: worktreesDir,
        reservationWorktreesDir: worktreesDir,
        aliasRepoRels: [],
      });
    };
    addTarget(canonicalSingularWorktreePath);
    if (task.worktree) addTarget(task.worktree);
    const recordedBranch = task.branch?.trim();
    return {
      kind: "singular",
      layout: "singular",
      targets: [...targetsByCanonical.values()],
      branchCleanupTargets: [{ repoRootDir: rootDir, recordedBranches: recordedBranch ? [recordedBranch] : [] }],
      canonicalSingularWorktreePath: resolve(canonicalSingularWorktreePath),
    };
  }

  const workspaceTaskDir = resolveWorkspaceTaskWorktreeDir(rootDir, settings, task.id);
  const legacy = isLegacyWorkspaceWorktreeLayout(task, workspaceTaskDir);
  const targetsByCanonical = new Map<string, TaskResetWorktreeTarget>();
  for (const [repoRel, entry] of Object.entries(task.workspaceWorktrees ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    assertWorkspaceRepoRelPath(repoRel);
    const repoRootDir = join(rootDir, repoRel);
    const reservationWorktreesDir = resolveWorktreesDirLayout(repoRootDir, settings, {
      workspaceRootDir: rootDir,
      repoRelPath: repoRel,
    });
    const canonicalPath = resolve(entry.worktreePath);
    const existing = targetsByCanonical.get(canonicalPath);
    if (existing) {
      existing.aliasRepoRels.push(repoRel);
      continue;
    }
    targetsByCanonical.set(canonicalPath, {
      repoRel,
      worktreePath: entry.worktreePath,
      canonicalPath,
      branch: entry.branch,
      repoRootDir,
      containmentRoot: legacy ? reservationWorktreesDir : workspaceTaskDir,
      reservationWorktreesDir,
      aliasRepoRels: [],
    });
  }

  let ignoredSingularWorktree: string | undefined;
  if (task.worktree) {
    const existing = targetsByCanonical.get(resolve(task.worktree));
    if (existing) existing.aliasRepoRels.push(SINGULAR_RESET_WORKTREE_REPO_REL);
    else ignoredSingularWorktree = task.worktree;
  }
  const targets = [...targetsByCanonical.values()];
  const branchCleanupByRoot = new Map<string, Set<string>>();
  for (const target of targets) {
    const branches = branchCleanupByRoot.get(target.repoRootDir) ?? new Set<string>();
    const branch = target.branch?.trim();
    if (branch) branches.add(branch);
    branchCleanupByRoot.set(target.repoRootDir, branches);
  }
  /*
  A workspace with no recorded children has no trustworthy repository roots. Refusal paths must
  preserve workspaceWorktrees, because clearing that map would make a retry lose branch-cleanup scope.
  */
  const branchCleanupTargets = [...branchCleanupByRoot.entries()].map(([repoRootDir, recordedBranches]) => ({
    repoRootDir,
    recordedBranches: [...recordedBranches],
  }));
  return {
    kind: "workspace",
    layout: legacy ? "workspace-legacy" : "workspace-task-dir",
    targets,
    branchCleanupTargets,
    ...(legacy ? {} : { workspaceTaskDir }),
    ...(ignoredSingularWorktree ? { ignoredSingularWorktree } : {}),
  };
}
