/**
 * FNXC:CodeOrganization 2026-08-04-02:05:
 * Shared multi-arg binders for worktree create/conflict facades (U4).
 *
 * tryCreateWorktree / handleWorktreeConflict take many optional params; free peels
 * pass full arity while TaskExecutor methods fill defaults. Writing the same
 * `(...args) => this.tryCreateWorktree(..., allow ?? false, settings ?? {})`
 * three times bloated the façade — one binder per entry keeps semantics identical.
 *
 * Host is intentionally untyped (`any`): private TaskExecutor methods cannot be
 * assigned to a public structural host type, same posture as facadeMethods.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- private host methods; see FNXC
export function bindTryCreateWorktree(host: any) {
  return (
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    attemptNumber?: number,
    recoveryDepth?: number,
    allowSiblingBranchRename?: boolean,
    settings?: Record<string, unknown>,
  ) =>
    host.tryCreateWorktree(
      branch,
      path,
      taskId,
      startPoint,
      attemptNumber,
      recoveryDepth,
      allowSiblingBranchRename ?? false,
      settings ?? {},
    );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- private host methods; see FNXC
export function bindHandleWorktreeConflict(host: any) {
  return (
    conflictPath: string,
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    attemptNumber?: number,
    allowSiblingBranchRename?: boolean,
    settings?: Record<string, unknown>,
  ) =>
    host.handleWorktreeConflict(
      conflictPath,
      branch,
      path,
      taskId,
      startPoint,
      attemptNumber,
      allowSiblingBranchRename ?? false,
      settings ?? {},
    );
}
