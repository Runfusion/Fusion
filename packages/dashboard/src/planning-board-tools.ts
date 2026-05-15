import type { TaskStore } from "@fusion/core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export function createPlanningBoardTools(store: TaskStore): ToolDefinition[] {
  const taskGetParams = {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID (e.g. KB-001)" },
    },
    required: ["id"],
    additionalProperties: false,
  } as const;

  const taskList: ToolDefinition = {
    name: "fn_task_list",
    label: "List Tasks",
    description:
      "List all tasks that aren't done. Returns ID, description, column, " +
      "and dependencies for each. Use to check for duplicates before planning.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const tasks = await store.listTasks({ slim: true, includeArchived: false });
      const active = tasks.filter((t) => t.column !== "done");
      if (active.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No active tasks." }],
          details: {},
        };
      }
      const lines = active.map((t) => {
        const desc = t.title || t.description.slice(0, 80);
        const deps = t.dependencies.length ? ` [deps: ${t.dependencies.join(", ")}]` : "";
        return `${t.id} (${t.column}): ${desc}${deps}`;
      });
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {},
      };
    },
  };

  const taskGet: ToolDefinition = {
    name: "fn_task_get",
    label: "Get Task",
    description:
      "Get full details of a specific task including its PROMPT.md content. " +
      "Use to verify duplicates and to read dependency task specs before writing a new PROMPT.md.",
    parameters: taskGetParams,
    execute: async (_callId: string, params: { id: string }) => {
      try {
        const task = await store.getTask(params.id);
        const parts = [
          `ID: ${task.id}`,
          `Column: ${task.column}`,
          `Description: ${task.description}`,
          task.dependencies.length ? `Dependencies: ${task.dependencies.join(", ")}` : null,
          "",
          "PROMPT.md:",
          task.prompt || "(not yet specified)",
        ].filter(Boolean);
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: {},
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: `Task ${params.id} not found.` }],
          details: {},
        };
      }
    },
  };

  return [taskList, taskGet];
}
