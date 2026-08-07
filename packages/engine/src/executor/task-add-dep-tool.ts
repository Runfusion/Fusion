/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * createTaskAddDepTool peeled from TaskExecutor (U4). Mid-execution dependency
 * declaration tool; confirm=true aborts the active session for re-planning.
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { TaskStore } from "@fusion/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { executorLog } from "../logger.js";

const taskAddDepParams = Type.Object({
  task_id: Type.String({ description: "The ID of the task to depend on (e.g. \"KB-001\")" }),
  confirm: Type.Optional(Type.Boolean({ description: "Set to true to confirm adding the dependency. Required because adding a dep to an in-progress task will stop execution and discard current work." })),
});

export type TaskAddDepToolDeps = {
  store: TaskStore;
  depAborted: Set<string>;
  getActiveSession: (taskId: string) => { session: { dispose: () => void } } | undefined;
  getActiveStepExecutor: (taskId: string) => { terminateAllSessions: () => Promise<unknown> } | undefined;
};

export function createTaskAddDepTool(deps: TaskAddDepToolDeps, taskId: string): ToolDefinition {
  const store = deps.store;
  return {
    name: "fn_task_add_dep",
    label: "Add Dependency",
    description:
      "Declare a dependency on an existing task. Use when you discover " +
      "mid-execution that another task must be completed first. " +
      "Adding a dependency to an in-progress task will stop execution " +
      "and discard current work, so confirm=true is required. " +
      "Without confirm=true, a warning is returned first.",
    parameters: taskAddDepParams,
    execute: async (_id: string, params: Static<typeof taskAddDepParams>) => {
      const targetId = params.task_id;

      // Prevent self-dependency
      if (targetId === taskId) {
        return {
          content: [{
            type: "text" as const,
            text: `Cannot add self-dependency: ${taskId} cannot depend on itself.`,
          }],
          details: {},
        };
      }

      // Validate target task exists
      try {
        await store.getTask(targetId);
      } catch {
        return {
          content: [{
            type: "text" as const,
            text: `Task ${targetId} not found. Cannot add dependency on a non-existent task.`,
          }],
          details: {},
        };
      }

      // Read current task to get existing dependencies
      const currentTask = await store.getTask(taskId);
      const existing = currentTask.dependencies;

      // Dedup check
      if (existing.includes(targetId)) {
        return {
          content: [{
            type: "text" as const,
            text: `${targetId} is already a dependency of ${taskId}. No changes made.`,
          }],
          details: {},
        };
      }

      // Confirmation gate — destructive action for in-progress tasks
      if (!params.confirm) {
        return {
          content: [{
            type: "text" as const,
            text: `Warning: adding a dependency to an in-progress task will stop execution and discard current work. Call with confirm=true to proceed.`,
          }],
          details: {},
        };
      }

      // Add the dependency
      await store.updateTask(taskId, { dependencies: [...existing, targetId] });
      await store.logEntry(taskId, `Added dependency on ${targetId} — stopping execution for re-planning`);

      // Trigger abort flow (same pattern as pausedAborted)
      deps.depAborted.add(taskId);
      const activeSession = deps.getActiveSession(taskId);
      activeSession?.session.dispose();

      // Also terminate step sessions if active
      const stepExecutor = deps.getActiveStepExecutor(taskId);
      if (stepExecutor) {
        stepExecutor.terminateAllSessions().catch(err =>
          executorLog.warn(`Failed to terminate step sessions for dep-abort ${taskId}: ${err}`)
        );
      }

      return {
        content: [{
          type: "text" as const,
          text: `Added dependency on ${targetId}. Stopping execution — task will move to triage for re-planning.`,
        }],
        details: {},
      };
    },
  };
}
