import { loadWorkspaceConfig, type Task, type TaskStore, type WorkspaceConfig } from "@fusion/core";

/**
 * FNXC:Workspace 2026-08-14-21:06:
 * Workspace detection has one host-owned writer: a per-lane copy silently routes a multi-repo
 * project through its non-git root. Memoization is per host so concurrent projects and tests
 * cannot share configuration, and a config with no usable repositories is single-repo mode.
 */
const inFlightWorkspaceConfigLoads = new WeakMap<object, Promise<WorkspaceConfig | null>>();
const workspaceConfigEpochs = new WeakMap<object, number>();

/**
 * FNXC:Workspace 2026-08-15-05:28:
 * A settings toggle can change workspace.json while a prior disk read is pending. Bump an owner
 * epoch as well as deleting its promise so that stale completion cannot repopulate the old mode.
 */
export function invalidateWorkspaceConfigCache(owner: object): void {
  inFlightWorkspaceConfigLoads.delete(owner);
  workspaceConfigEpochs.set(owner, (workspaceConfigEpochs.get(owner) ?? 0) + 1);
}

/*
FNXC:WorkspaceRootRouting 2026-08-19-12:15:
Resolve stale singular routing through the TaskStore's atomic PostgreSQL mutation before a review or
recovery path interprets task.worktree/branch/session metadata. The compatibility fallback updates
only singular fields and never replaces workspaceWorktrees, preserving sub-repository siblings in
structural test stores that predate the persistence seam.
*/
export async function normalizeWorkspaceTaskRouting(store: TaskStore, taskId: string): Promise<Task> {
  const normalize = (store as TaskStore & {
    normalizeWorkspaceTaskWorktreeMetadata?: (id: string) => Promise<Task>;
  }).normalizeWorkspaceTaskWorktreeMetadata;
  if (typeof normalize === "function") return normalize.call(store, taskId);

  let task = await store.getTask(taskId);
  if (task.worktree || task.branch || task.executionStartBranch || task.baseCommitSha) {
    if (typeof (store as Partial<TaskStore>).updateTask !== "function") return task;
    await store.updateTask(taskId, {
      worktree: null,
      branch: null,
      branchWriteOrigin: "engine" as const,
      executionStartBranch: null,
      baseCommitSha: null,
      sessionFile: null,
    });
    task = await store.getTask(taskId);
  }
  return task;
}

export type WorkspaceConfigResolverDeps = {
  rootDir: string;
  workspaceConfigOwner: object;
  getWorkspaceConfig: () => WorkspaceConfig | null | undefined;
  setWorkspaceConfig: (config: WorkspaceConfig | null) => void;
};

export async function resolveWorkspaceConfigOnce(
  deps: WorkspaceConfigResolverDeps,
): Promise<WorkspaceConfig | null> {
  const current = deps.getWorkspaceConfig();
  if (current !== undefined) return current;

  const existing = inFlightWorkspaceConfigLoads.get(deps.workspaceConfigOwner);
  if (existing) return existing;

  const epoch = workspaceConfigEpochs.get(deps.workspaceConfigOwner) ?? 0;
  const promise = loadWorkspaceConfig(deps.rootDir).then((config) => {
    const normalized = config && config.repos.length > 0 ? config : null;
    if ((workspaceConfigEpochs.get(deps.workspaceConfigOwner) ?? 0) === epoch) {
      deps.setWorkspaceConfig(normalized);
    }
    return normalized;
  });
  inFlightWorkspaceConfigLoads.set(deps.workspaceConfigOwner, promise);
  try {
    return await promise;
  } finally {
    if (inFlightWorkspaceConfigLoads.get(deps.workspaceConfigOwner) === promise) {
      inFlightWorkspaceConfigLoads.delete(deps.workspaceConfigOwner);
    }
  }
}
