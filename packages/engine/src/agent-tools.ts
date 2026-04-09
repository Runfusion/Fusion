/**
 * Shared agent tool factory functions.
 *
 * Extracted from TaskExecutor so they can be reused by other subsystems
 * (e.g., HeartbeatMonitor execution) without pulling in the full executor.
 *
 * The parameter schemas are canonical here — executor.ts imports and reuses them.
 */

import type { TaskDocument, TaskDocumentCreateInput, TaskStore, RunMutationContext } from "@fusion/core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentReflectionService } from "./agent-reflection.js";

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

export const taskDocumentWriteParams = Type.Object({
  key: Type.String({
    description: "Document key (e.g., 'plan', 'notes', 'research'). Alphanumeric, hyphens, underscores, 1-64 chars.",
  }),
  content: Type.String({ description: "Document content to store" }),
  author: Type.Optional(Type.String({ description: "Who is writing (default: 'agent')" })),
});

export const taskDocumentReadParams = Type.Object({
  key: Type.Optional(
    Type.String({ description: "Document key to read. Omit to list all documents for this task." }),
  ),
});

export const reflectOnPerformanceParams = Type.Object({
  focus_area: Type.Optional(
    Type.String({ description: "Optional focus area for reflection (e.g., 'code quality', 'speed', 'testing')" }),
  ),
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

/**
 * Create a `task_log` tool with run context for mutation correlation.
 *
 * @param store - TaskStore for task persistence
 * @param taskId - The task ID to log entries against
 * @param runContext - Optional run context for mutation correlation
 * @returns ToolDefinition for the `task_log` tool
 */
export function createTaskLogToolWithContext(store: TaskStore, taskId: string, runContext?: RunMutationContext): ToolDefinition {
  return {
    name: "task_log",
    label: "Log Entry",
    description:
      "Log an important action, decision, or issue for this task. " +
      "Use for significant events — not every small step.",
    parameters: taskLogParams,
    execute: async (_id: string, params: Static<typeof taskLogParams>) => {
      await store.logEntry(taskId, params.message, params.outcome, runContext);
      return {
        content: [{ type: "text" as const, text: `Logged: ${params.message}` }],
        details: {},
      };
    },
  };
}

/**
 * Create a `task_document_write` tool that stores a named task document.
 *
 * @param store - TaskStore for task document persistence
 * @param taskId - The task ID to write documents against
 * @returns ToolDefinition for the `task_document_write` tool
 */
export function createTaskDocumentWriteTool(store: TaskStore, taskId: string): ToolDefinition {
  return {
    name: "task_document_write",
    label: "Write Document",
    description:
      "Save a named document for this task (for example plan, notes, or research). " +
      "Each write creates a new revision so you can update documents over time.",
    parameters: taskDocumentWriteParams,
    execute: async (_id: string, params: Static<typeof taskDocumentWriteParams>) => {
      const input: TaskDocumentCreateInput = {
        key: params.key,
        content: params.content,
        author: params.author || "agent",
      };

      try {
        const document: TaskDocument = await store.upsertTaskDocument(taskId, input);
        return {
          content: [{
            type: "text" as const,
            text: `Saved document "${document.key}" (revision ${document.revision}).`,
          }],
          details: {},
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: `ERROR: Failed to save document "${params.key}": ${err.message}`,
          }],
          details: {},
        };
      }
    },
  };
}

/**
 * Create a `task_document_read` tool that reads task-scoped documents.
 *
 * @param store - TaskStore for task document reads
 * @param taskId - The task ID to read documents from
 * @returns ToolDefinition for the `task_document_read` tool
 */
export function createTaskDocumentReadTool(store: TaskStore, taskId: string): ToolDefinition {
  return {
    name: "task_document_read",
    label: "Read Document",
    description:
      "Read a named document for this task, or list all documents when no key is provided.",
    parameters: taskDocumentReadParams,
    execute: async (_id: string, params: Static<typeof taskDocumentReadParams>) => {
      try {
        if (params.key) {
          const document: TaskDocument | null = await store.getTaskDocument(taskId, params.key);
          if (!document) {
            return {
              content: [{ type: "text" as const, text: `Document "${params.key}" not found.` }],
              details: {},
            };
          }

          return {
            content: [{
              type: "text" as const,
              text:
                `Document: ${document.key}\n` +
                `Revision: ${document.revision}\n` +
                `Updated: ${document.updatedAt}\n\n` +
                document.content,
            }],
            details: {},
          };
        }

        const documents: TaskDocument[] = await store.getTaskDocuments(taskId);
        if (documents.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No documents found for this task." }],
            details: {},
          };
        }

        const lines = documents.map((doc) => `- ${doc.key} (revision ${doc.revision}, updated ${doc.updatedAt})`);
        return {
          content: [{
            type: "text" as const,
            text: `Task documents:\n${lines.join("\n")}`,
          }],
          details: {},
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: `ERROR: Failed to read task documents: ${err.message}`,
          }],
          details: {},
        };
      }
    },
  };
}

/**
 * Create a `reflect_on_performance` tool that asks the reflection service to
 * analyze recent agent performance and return actionable insights.
 */
export function createReflectOnPerformanceTool(
  reflectionService: AgentReflectionService,
  agentId: string,
): ToolDefinition {
  return {
    name: "reflect_on_performance",
    label: "Reflect on Performance",
    description:
      'Review your past task performance and generate insights for improvement. Optionally focus on a specific area like "code quality", "speed", or "testing".',
    parameters: reflectOnPerformanceParams,
    execute: async (_id: string, params: Static<typeof reflectOnPerformanceParams>) => {
      const triggerDetail = params.focus_area
        ? `Agent-initiated reflection focused on: ${params.focus_area}`
        : "Agent-initiated reflection";

      const reflection = await reflectionService.generateReflection(agentId, "manual", {
        triggerDetail,
      });

      if (!reflection) {
        return {
          content: [{ type: "text" as const, text: "No reflection data available — not enough history yet." }],
          details: {},
        };
      }

      const formattedText = [
        `Summary: ${reflection.summary}`,
        "",
        "Insights:",
        ...reflection.insights.map((insight, index) => `${index + 1}. ${insight}`),
        "",
        "Suggested Improvements:",
        ...reflection.suggestedImprovements.map((improvement, index) => `${index + 1}. ${improvement}`),
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: formattedText }],
        details: {},
      };
    },
  };
}
