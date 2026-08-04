/**
 * FNXC:CodeOrganization 2026-08-04-08:15:
 * Active-session / step / CLI / configured-command bookkeeping facades peeled from
 * TaskExecutor (U4). Sits above pure worktree facades so executor.ts stays impl/bags thin.
 */
import * as impl from "./impl-bindings.js";
import * as bags from "./deps-bags.js";
import { type FacadeRestArgs } from "./facade-methods.js";
import { TaskExecutorWorktreePureFacades } from "./task-executor-worktree-pure-facades.js";

export abstract class TaskExecutorSessionFacades extends TaskExecutorWorktreePureFacades {
  protected addActiveWorktree(taskId: string, worktreePath: string): void { impl.addActiveWorktreeImpl(this.activeWorktrees, taskId, worktreePath); }
  protected getActiveWorktreePaths(taskId: string): ReturnType<typeof impl.getActiveWorktreePathsImpl> { return impl.getActiveWorktreePathsImpl(this.activeWorktrees, taskId); }
  protected sessionRegistryPath(taskId: string, worktreePath: string): ReturnType<typeof impl.sessionRegistryPathImpl> { return impl.sessionRegistryPathImpl(this.rootDir, taskId, worktreePath); }
  protected acquireSessionRegistryPath(...args: FacadeRestArgs<typeof impl.acquireSessionRegistryPathImpl>): void { impl.acquireSessionRegistryPathImpl(bags.buildAcquireSessionRegistryPathDeps(this), ...args); }
  protected setActiveSession(taskId: string, sessionState: Parameters<typeof impl.setActiveSessionImpl>[2], worktreePath: string): void { impl.setActiveSessionImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId, sessionState, worktreePath); }
  protected markGraphExecuteSelfRequeued(taskId: string): void { impl.markGraphExecuteSelfRequeuedImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId); }
  protected deleteActiveSession(taskId: string, worktreePath?: string): void { impl.deleteActiveSessionImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId, worktreePath); }
  protected setActiveStepExecutor(taskId: string, stepExecutor: Parameters<typeof impl.setActiveStepExecutorImpl>[2], worktreePath: string, seenSteeringIds = new Set<string>()): void { impl.setActiveStepExecutorImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId, stepExecutor, worktreePath, seenSteeringIds); }
  protected deleteActiveStepExecutor(taskId: string, worktreePath?: string): void { impl.deleteActiveStepExecutorImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId, worktreePath); }
  protected setActiveWorkflowStepSession(taskId: string, session: Parameters<typeof impl.setActiveWorkflowStepSessionImpl>[2], worktreePath: string, seenSteeringIds = new Set<string>()): void { impl.setActiveWorkflowStepSessionImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId, session, worktreePath, seenSteeringIds); }
  protected deleteActiveWorkflowStepSession(taskId: string, worktreePath?: string): void { impl.deleteActiveWorkflowStepSessionImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId, worktreePath); }
  protected registerConfiguredCommandController(taskId: string, controller: AbortController): void { impl.registerConfiguredCommandControllerImpl(this.activeConfiguredCommandControllers, taskId, controller); }
  protected unregisterConfiguredCommandController(taskId: string, controller: AbortController): void { impl.unregisterConfiguredCommandControllerImpl(this.activeConfiguredCommandControllers, taskId, controller); }
  protected registerSubagentSession(taskId: string, session: Parameters<typeof impl.registerSubagentSessionImpl>[2]): void { impl.registerSubagentSessionImpl(this.activeSubagentSessions, taskId, session); }
  protected unregisterSubagentSession(taskId: string, session: Parameters<typeof impl.unregisterSubagentSessionImpl>[2]): void { impl.unregisterSubagentSessionImpl(this.activeSubagentSessions, taskId, session); }
  protected disposeSubagentsForTask(taskId: string, reason: string): void { impl.disposeSubagentsForTaskImpl(this.activeSubagentSessions, taskId, reason); }
  protected getRunContextFor(taskId: string) { return this.currentRunContexts.get(taskId); }
}
