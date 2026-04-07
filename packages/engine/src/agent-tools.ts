/**
 * Shared agent tool factory functions.
 *
 * Extracted from TaskExecutor so they can be reused by other subsystems
 * (e.g., HeartbeatMonitor execution) without pulling in the full executor.
 *
 * The parameter schemas are canonical here — executor.ts imports and reuses them.
 */

import type { TaskStore } from "@fusion/core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@mariozechner/pi-ai";

// ── Tool parameter schemas (canonical definitions) ────────────────────────

export const taskCreateParams = Type.Object({
  description: Type.String({ description: "What needs to be done" }),
  dependencies: Type.Optional(
    Type.Array(Type.String(), { description: "Task IDs this new task depends on (e.g. [\"KB-001\"])" }),
  ),
});

export const taskLogParams = Type.Object({
  message: Type.String({ description: "What happened" }),
  outcome: Type.Optional(Type.String({ description: "Result or consequence (optional)" })),
});

// ── Tool factory functions ────────────────────────────────────────────────

/**
 * Create a `task_create` tool that creates a new task in triage.
 *
 * @param store - TaskStore for task persistence
 * @returns ToolDefinition for the `task_create` tool
 */
export function createTaskCreateTool(store: TaskStore): ToolDefinition {
  return {
    name: "task_create",
    label: "Create Task",
    description:
      "Create a new task for out-of-scope work discovered during execution. " +
      "The task goes into triage where it will be specified by the AI. " +
      "Optionally set dependencies (e.g., the new task depends on the current one, " +
      "or the current task should wait for the new one).",
    parameters: taskCreateParams,
    execute: async (_id: string, params: Static<typeof taskCreateParams>) => {
      const task = await store.createTask({
        description: params.description,
        dependencies: params.dependencies,
        column: "triage",
      });
      const deps = task.dependencies.length ? ` (depends on: ${task.dependencies.join(", ")})` : "";
      return {
        content: [{
          type: "text" as const,
          text: `Created ${task.id}: ${params.description}${deps}`,
        }],
        details: {},
      };
    },
  };
}

/**
 * Create a `task_log` tool that logs an entry for a specific task.
 *
 * @param store - TaskStore for task persistence
 * @param taskId - The task ID to log entries against
 * @returns ToolDefinition for the `task_log` tool
 */
export function createTaskLogTool(store: TaskStore, taskId: string): ToolDefinition {
  return {
    name: "task_log",
    label: "Log Entry",
    description:
      "Log an important action, decision, or issue for this task. " +
      "Use for significant events — not every small step.",
    parameters: taskLogParams,
    execute: async (_id: string, params: Static<typeof taskLogParams>) => {
      await store.logEntry(taskId, params.message, params.outcome);
      return {
        content: [{ type: "text" as const, text: `Logged: ${params.message}` }],
        details: {},
      };
    },
  };
}
