import * as fusionCore from "@fusion/core";
import { MAX_TASK_LIST_TEXT_CHARS, type TaskStore } from "@fusion/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type TaskListClamp = (lines: string[], opts?: { maxChars?: number }) => string;
type TaskListFormatter = (
  lines: string[],
  opts?: { maxChars?: number; clamp?: TaskListClamp },
) => string;

export function inlineTaskListFallback(
  lines: string[],
  opts: { maxChars?: number } = {},
): string {
  /*
  FNXC:TaskListOutput 2026-06-18-03:20:
  FN-6629 requires stale-runtime fallback formatting to mirror the shared host-safe task-list budget; otherwise missing @fusion/core formatter exports can re-emit imageified board listings.
  */
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? MAX_TASK_LIST_TEXT_CHARS));
  try {
    const text = lines.join("\n");
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, Math.max(0, maxChars - 1)) + "…";
  } catch {
    return "";
  }
}

export function resolveTaskListFormatter(core: { formatTaskListText?: unknown }): TaskListFormatter {
  return typeof core.formatTaskListText === "function"
    ? (core.formatTaskListText as TaskListFormatter)
    : inlineTaskListFallback;
}

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
      /*
      FNXC:TaskListOutput 2026-06-16-17:47:
      FN-6492 keeps dashboard planning-board duplicate checks within the shared plain-text budget so large boards stay readable to non-vision agents.

      FNXC:TaskListOutput 2026-06-17-05:46:
      FN-6570 keeps the planning-board fn_task_list surface resilient when runtime @fusion/core lacks clampTaskListText by passing the namespace binding through the defensive formatter fallback.

      FNXC:TaskListOutput 2026-06-17-07:25:
      FN-6573 requires dashboard fn_task_list to resolve formatTaskListText from the runtime @fusion/core namespace with a typeof guard and a self-contained bounded fallback. A stale @fusion/core dist missing the FN-6570 formatter export crashed ambient heartbeat agents as `(0 , _core.formatTaskListText) is not a function`; duplicate checks must now return bounded text instead.
      */
      const formatter = resolveTaskListFormatter(fusionCore);
      return {
        content: [{ type: "text" as const, text: formatter(lines, { clamp: fusionCore.clampTaskListText }) }],
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
