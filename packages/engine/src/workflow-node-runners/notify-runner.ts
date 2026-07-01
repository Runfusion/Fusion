import type { NotificationEvent, NotificationPayload } from "@fusion/core";

import { schedulerLog } from "../logger.js";
import type { WorkflowNodeHandler, WorkflowNodeResult } from "../workflow-graph-executor.js";
import type { WorkflowNodeRunner, WorkflowNodeRunnerContext } from "../workflow-node-runner.js";

const WORKFLOW_ID_CONTEXT_KEY = "workflow:id";

export type WorkflowNotifyDispatch = (
  event: NotificationEvent,
  payload: NotificationPayload,
) => Promise<void> | void;

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function interpolateNotifyTemplate(
  template: string,
  vars: {
    taskId: string;
    taskTitle: string;
    workflowName: string;
    context: Record<string, unknown>;
  },
): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    if (name === "taskId") return vars.taskId;
    if (name === "taskTitle") return vars.taskTitle;
    if (name === "workflowName") return vars.workflowName;
    if (name.startsWith("context:")) {
      return stringifyTemplateValue(vars.context[name.slice("context:".length)]);
    }
    return `{{${rawName}}}`;
  });
}

/*
FNXC:WorkflowNodeRunners 2026-07-01-00:00:
Notify nodes are a dedicated runner because their side effect is optional operator notification, not graph traversal. Missing dispatch stays a successful skipped outcome so workflows do not fail when notification infrastructure is unwired.
*/
export class NotifyNodeRunner implements WorkflowNodeRunner {
  public readonly kind = "notify" as const;

  public constructor(private readonly notifyDispatch?: WorkflowNotifyDispatch) {}

  public async run(node: Parameters<WorkflowNodeHandler>[0], ctx: WorkflowNodeRunnerContext): Promise<WorkflowNodeResult> {
    const cfg = (node.config ?? {}) as { event?: unknown; message?: unknown; title?: unknown };
    const event = typeof cfg.event === "string" ? cfg.event.trim() : "";
    if (!event) {
      schedulerLog.log(`Workflow notify node '${node.id}' skipped because it has no event`);
      return { outcome: "success", value: "notify-skipped" };
    }
    if (!this.notifyDispatch) {
      schedulerLog.log(`Workflow notify node '${node.id}' skipped because notification dispatch is unwired`);
      return { outcome: "success", value: "notify-skipped" };
    }

    const taskTitle = typeof ctx.task.title === "string" && ctx.task.title.trim() !== ""
      ? ctx.task.title
      : ctx.task.id;
    const workflowName = typeof ctx.context[WORKFLOW_ID_CONTEXT_KEY] === "string"
      ? ctx.context[WORKFLOW_ID_CONTEXT_KEY]
      : "unknown";
    const vars = { taskId: ctx.task.id, taskTitle, workflowName, context: ctx.context };
    const title = typeof cfg.title === "string" ? interpolateNotifyTemplate(cfg.title, vars) : taskTitle;
    const message = typeof cfg.message === "string" ? interpolateNotifyTemplate(cfg.message, vars) : "";
    const payload: NotificationPayload = {
      taskId: ctx.task.id,
      taskTitle,
      taskDescription: ctx.task.description,
      event,
      timestamp: new Date().toISOString(),
      metadata: {
        nodeId: node.id,
        workflowName,
        title,
        message,
      },
    };

    try {
      await this.notifyDispatch(event, payload);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      schedulerLog.log(`Workflow notify node '${node.id}' dispatch failed for event=${event}: ${detail}`);
    }

    return { outcome: "success" };
  }
}

export function createNotifyHandler(notifyDispatch?: WorkflowNotifyDispatch): WorkflowNodeHandler {
  const runner = new NotifyNodeRunner(notifyDispatch);
  return (node, context) => runner.run(node, context);
}
