/**
 * FNXC:CodeOrganization 2026-08-04-07:20:
 * Collapsed import surface for TaskExecutor facades (U4). Keeps executor.ts free of
 * long multi-module import lists while preserving static analyzable @fusion/* imports.
 */
export type {
  TaskStore, Task, TaskDetail, TaskTokenUsage, Settings, RunMutationContext,
  Agent, MergeResult, WorkflowIrNode, WorkflowIr, WorkflowColumnAgent, TaskMoveLanes,
  ApprovalRequestStore,
} from "@fusion/core";
export { resolvePlannerLanes } from "../execution/replan-target.js";
export type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
export type { WorkflowLegacySeams } from "../workflows/workflow-node-handlers.js";
export type { WorkflowRuntimePrimitives } from "../execution/runtime-primitives.js";
export { createWorkflowRuntimePrimitiveProvider } from "../workflows/workflow-runtime-primitive-provider.js";
export { ModelRegistry, type AgentSession } from "@earendil-works/pi-coding-agent";
export { dropPreHeldExecutorSlot } from "../concurrency/concurrency.js";
export { activeSessionRegistry } from "../agents/active-session-registry.js";
export { CliTaskSession } from "../cli-agent/task-session.js";
export { StepSessionExecutor } from "../execution/step-session-executor.js";
export type { RunAuditor } from "../util/run-audit.js";
export { getTaskCompletionBlockerForStore } from "../execution/task-completion.js";
export * as constants from "./executor-constants.js";
export * as pure from "./pure-bindings.js";
export * as impl from "./impl-bindings.js";
export * as bags from "./deps-bags.js";
export type { ActiveSessionBookkeepingDeps } from "./active-session-bookkeeping.js";
export type { TaskLivenessDeps } from "./task-liveness.js";
export {
  facadeFields,
  facadeMethods,
  type FacadeRestArgs,
  type FacadeAfterFirst,
  type FacadeAfterSecond,
} from "./facade-methods.js";
export { bindHandleWorktreeConflict, bindTryCreateWorktree } from "./worktree-create-binders.js";
export {
  buildWireExecutorLifecycleDeps,
  wireExecutorLifecycle,
  applyWireExecutorLifecycleDisposers,
} from "./wire-executor-lifecycle.js";
export type {
  TaskExecutorOptions,
  CliAgentRuntime,
  ActiveExecutorSessionState,
  GraphCompletionCallback,
} from "./task-executor-options.js";
export { TaskExecutorState } from "./task-executor-state.js";
