// port-4040-allowlist: never kill port 4040. FNXC:CodeOrganization 2026-08-04-09:45: thin TaskExecutor shell (U4).
export * from "./executor/executor-reexports.js";
import { type TaskStore, type Task, type MergeResult, type TaskMoveLanes, resolvePlannerLanes, dropPreHeldExecutorSlot, wireTaskExecutorLifecycle, type TaskExecutorOptions, TaskExecutorGraphFacades } from "./executor/task-executor-imports.js";
export class TaskExecutor extends TaskExecutorGraphFacades {
  private isBackwardMoveOutOfPlanning(taskId: string, from: string, to: string, moveLanes: TaskMoveLanes | undefined): boolean { const sync = moveLanes ? undefined : resolvePlannerLanes(this.store, taskId); const lanes = { hold: moveLanes?.hold ?? sync?.hold ?? "todo", intake: moveLanes?.intake ?? sync?.intake ?? "triage", wip: moveLanes?.wip ?? sync?.wip ?? "in-progress", review: moveLanes?.review ?? sync?.review ?? "in-review", complete: moveLanes?.complete ?? sync?.complete ?? "done" }; return (from === lanes.hold || from === lanes.intake) && ![lanes.wip, lanes.review, lanes.complete].filter((c): c is string => typeof c === "string").includes(to); }
  setOnExecutorLogFlushed(cb: TaskExecutorOptions["onExecutorLogFlushed"]): void { this.options = { ...this.options, onExecutorLogFlushed: cb }; }
  constructor(store: TaskStore, rootDir: string, options: TaskExecutorOptions = {}) { super(); this.store = store; this.rootDir = rootDir; this.options = options; wireTaskExecutorLifecycle(this); }
  setMergeRequester(requestMerge: (taskId: string, options?: { signal?: AbortSignal }) => Promise<MergeResult>): void { this.mergeRequester = requestMerge; }
  async execute(task: Task): Promise<void> { try { await this.executeCore(task); } finally { if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release(); } }
}
