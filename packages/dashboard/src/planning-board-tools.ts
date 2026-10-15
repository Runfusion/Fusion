import * as fusionCore from "@fusion/core";
import { storeErrorResult } from "@fusion/engine";
import { MAX_TASK_LIST_TEXT_CHARS, TASK_BOARD_READ_CAVEAT, type TaskStore } from "@fusion/core";
import { completeColumnsForTask } from "./task-lifecycle-lanes.js";
import type { WorkflowIr } from "@fusion/core";
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
  /*
  FNXC:CommentDelivery 2026-09-27-17:05 (RUFU-259):
  The planning interview lane receives operator steering too, so its `fn_task_show` carries the same
  optional comment-id read as the engine factory, the planner lane, and the pi extension. A fourth
  variant without it would just move the unreadable-comment bug to whichever surface the planner
  happens to be holding.
  */
  const taskGetParams = {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID (e.g. KB-001)" },
      commentIds: {
        type: "array",
        items: { type: "string" },
        maxItems: 20,
        description: "Optional comment or steering-comment ids to return bodies for. Resolved against both `comments` and `steeringComments`.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  } as const;

  const taskList: ToolDefinition = {
    name: "fn_task_list",
    label: "List Tasks",
    description:
      "List all tasks that aren't done. Returns ID, label, column, " +
      "and dependencies for each. Use to check for duplicates before planning. " +
      TASK_BOARD_READ_CAVEAT,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const tasks = await store.listTasks({ slim: true, includeArchived: false });
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-06:05 (batch-core):
      "Not finished yet" for the planner's duplicate check. Keyed on the literal, a renamed board
      listed every FINISHED task as active, so the planner was told to check for duplicates against
      work that was already done — the opposite of the tool's purpose, and it degrades quietly
      because the list is merely wrong rather than empty.

      Complete only (the query already passes `includeArchived: false`), and one shared IR cache
      across the scan so this costs one workflow read per distinct workflow rather than per task.
      */
      const activeIrCache = new Map<string, WorkflowIr>();
      const active: typeof tasks = [];
      for (const t of tasks) {
        if (!(await completeColumnsForTask(store, t.id, activeIrCache)).has(t.column)) active.push(t);
      }
      if (active.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No active tasks." }],
          details: {},
        };
      }
      const lines = active.map((t) => {
        // FNXC:TaskTitleDerivation 2026-09-26-02:43: RUFU-295 — planning-board task listings show the
        // canonical derived label instead of a raw 80-character description prefix.
        const desc = t.title?.trim() || fusionCore.deriveTaskLabelFromDescription(t.description, 80);
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

  /**
   * FNXC:AgentTooling 2026-06-27-00:00:
   * Planning-board interviews must expose the task detail read tool as canonical `fn_task_show`, matching prompt text and the FN-7118 shared read-tool factory so every agent surface learns one model-visible show-tool name.
   */
  const taskShow: ToolDefinition = {
    name: "fn_task_show",
    label: "Get Task",
    description:
      "Get full details of a specific task including its PROMPT.md content. " +
      "Use to verify duplicates and to read dependency task specs before writing a new PROMPT.md. " +
      "Pass commentIds to read the body of comment or steering comments by id.",
    parameters: taskGetParams,
    execute: async (_callId: string, params: { id: string; commentIds?: string[] }) => {
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
          fusionCore.renderTaskCommentSection(task, params.commentIds) || null,
        ].filter(Boolean);
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: {},
        };
      } catch (err: unknown) {
        // A store outage is not a missing card: only the store's own not-found may say so.
        if (!fusionCore.isTaskNotFoundError(err)) {
          return storeErrorResult(`Task ${params.id} could not be read`, err);
        }
        return {
          content: [{ type: "text" as const, text: `Task ${params.id} not found.` }],
          details: {},
        };
      }
    },
  };

  return [taskList, taskShow];
}
