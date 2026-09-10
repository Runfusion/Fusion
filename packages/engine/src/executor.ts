// port-4040-allowlist: never kill port 4040. FNXC:CodeOrganization 2026-08-04-09:45: thin TaskExecutor shell (U4).
export * from "./executor/executor-reexports.js";
import { type TaskStore, type Task, type MergeResult, type TaskMoveLanes, dropPreHeldExecutorSlot, wireTaskExecutorLifecycle, type TaskExecutorOptions, TaskExecutorGraphFacades } from "./executor/task-executor-imports.js";
export class TaskExecutor extends TaskExecutorGraphFacades {
  private isBackwardMoveOutOfPlanning(_taskId: string, from: string, to: string, moveLanes: TaskMoveLanes | undefined): boolean { const lanes = moveLanes ?? { hold: "todo", intake: "triage", wip: "in-progress", review: "in-review", complete: "done" }; return (from === lanes.hold || from === lanes.intake) && ![lanes.wip, lanes.review, lanes.complete].filter((c): c is string => typeof c === "string").includes(to); }
  setOnExecutorLogFlushed(cb: TaskExecutorOptions["onExecutorLogFlushed"]): void { this.options = { ...this.options, onExecutorLogFlushed: cb }; }
  constructor(store: TaskStore, rootDir: string, options: TaskExecutorOptions = {}) { super(); this.store = store; this.rootDir = rootDir; this.options = options; wireTaskExecutorLifecycle(this); }
  setMergeRequester(requestMerge: (taskId: string, options?: { signal?: AbortSignal }) => Promise<MergeResult>): void { this.mergeRequester = requestMerge; }
  // FNXC:WorkspaceLateAcquire 2026-08-24-06:11: KTD16 — the same provider seam self-healing uses, so the workspace late-acquire gate sees a queued-or-running merge.
  setMergePendingProvider(isMergePending: (taskId: string) => boolean | Promise<boolean>): void { this.mergePendingProvider = isMergePending; }
  setActiveMergeTaskIdProvider(getActiveMergeTaskId: () => string | null): void { this.activeMergeTaskIdProvider = getActiveMergeTaskId; }
  async isTaskMergePendingOrActive(taskId: string): Promise<boolean> { return this.activeMergeTaskIdProvider?.() === taskId || await this.mergePendingProvider?.(taskId) === true; }
  async execute(task: Task): Promise<void> { try { await this.executeCore(task); } finally { if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release(); } }
}
