import { resolveEngineIncarnationId, resolveEngineNodeId, type TaskStore, type WorkspaceLeaseHandle } from "@fusion/core";

export class WorkspaceMergeDispatchBusyError extends Error {
  readonly retryable = true;

  constructor(readonly holderTaskId: string, readonly requestingTaskId: string) {
    super(`workspace merge dispatch is in progress for task ${holderTaskId}`);
    this.name = "WorkspaceMergeDispatchBusyError";
  }
}

/**
 * FNXC:WorkspaceIntegration 2026-08-21-22:07:
 * Every production workspace land door shares the task dispatch lease. Local-only targets do not
 * publish a remote pin, but still require this durable owner fence before any repository lease or CAS.
 */
export async function withWorkspaceMergeDispatchLease<T>(
  store: TaskStore,
  taskId: string,
  body: (handle?: WorkspaceLeaseHandle) => Promise<T>,
  options: { onLeaseLost?: () => void } = {},
): Promise<T> {
  const acquire = (store as Partial<TaskStore>).acquireWorkspaceLease;
  if (typeof acquire !== "function") return body();
  let claim: Awaited<ReturnType<NonNullable<TaskStore["acquireWorkspaceLease"]>>>;
  try {
    claim = await acquire.call(store, {
      leaseKey: `merge-dispatch:${taskId}`, kind: "merge-dispatch",
      owner: { taskId, nodeId: resolveEngineNodeId(), incarnationId: resolveEngineIncarnationId() }, leaseMs: 5 * 60_000,
    });
  } catch {
    throw new WorkspaceMergeDispatchBusyError("durable-workspace-lease", taskId);
  }
  if (claim.outcome === "conflict") throw new WorkspaceMergeDispatchBusyError(claim.conflict.taskId, taskId);
  let handle = claim.handle;
  let lost = false;
  const renew = (store as Partial<TaskStore>).renewWorkspaceLease;
  const timer = typeof renew === "function" ? setInterval(() => {
    void renew.call(store, handle, 5 * 60_000).then((next) => {
      if (next) handle = next;
      else { lost = true; options.onLeaseLost?.(); }
    }).catch(() => { lost = true; options.onLeaseLost?.(); });
  }, 60_000) : undefined;
  timer?.unref?.();
  try {
    const result = await body(handle);
    if (lost) throw new WorkspaceMergeDispatchBusyError("durable-workspace-lease", taskId);
    return result;
  } finally {
    if (timer) clearInterval(timer);
    const release = (store as Partial<TaskStore>).releaseWorkspaceLease;
    if (typeof release === "function") await release.call(store, handle).catch(() => undefined);
  }
}
