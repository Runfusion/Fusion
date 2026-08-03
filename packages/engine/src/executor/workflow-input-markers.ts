/**
 * FNXC:CodeOrganization 2026-08-03-17:15:
 * Workflow-input watermark + marker resolution peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowInput 2026-06-29-10:00:
 * A workflow graph can restart at an earlier node after pause/resume recovery while the durable pausedReason still points at the later skill node that asked the question. If the user already supplied a post-watermark reply, clear that stale marker before any node executes so Compound Engineering cannot loop at Plan while Commit & open PR's answered question remains attached.
 */
import type { TaskDetail, TaskStore } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";

export type WorkflowInputMarkerDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export function workflowInputRepliesAfterWatermark(
  task: TaskDetail,
  marker: string,
): Array<{ createdAt?: string }> {
  const pausedReason = task.pausedReason ?? "";
  const watermark = (() => {
    const match = pausedReason.slice(marker.length).match(/^@(\d+)/);
    const parsed = match ? Number(match[1]) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  })();
  const steering = Array.isArray(task.steeringComments) ? task.steeringComments : [];
  return watermark === undefined
    ? steering
    : steering.filter((comment) => {
        const created = Date.parse((comment as { createdAt?: string }).createdAt ?? "");
        return Number.isFinite(created) ? created >= watermark : false;
      });
}

export async function resolveWorkflowInputMarkerForGraphNode(
  deps: WorkflowInputMarkerDeps,
  live: TaskDetail,
  nodeId: string,
): Promise<"clear" | "waiting" | "none"> {
  const pausedReason = live.pausedReason ?? "";
  if (!pausedReason.startsWith("workflow-input:")) return "none";
  const markerMatch = /^workflow-input:([^:@\s]+)(?:@\d+)?[:]/.exec(pausedReason);
  if (!markerMatch) return "none";
  const marker = `workflow-input:${markerMatch[1]}`;
  const replies = workflowInputRepliesAfterWatermark(live, marker);
  if (live.paused || replies.length === 0) {
    await deps.store.updateTask(live.id, { status: "awaiting-user-input", paused: true }, deps.getRunContextFor(live.id));
    return "waiting";
  }
  /*
   * FNXC:WorkflowInput 2026-06-29-10:00:
   * A workflow graph can restart at an earlier node after pause/resume recovery while the durable pausedReason still points at the later skill node that asked the question. If the user already supplied a post-watermark reply, clear that stale marker before any node executes so Compound Engineering cannot loop at Plan while Commit & open PR's answered question remains attached.
   */
  await deps.store.updateTask(live.id, { status: null, pausedReason: null }, deps.getRunContextFor(live.id));
  await deps.store.logEntry(
    live.id,
    marker === `workflow-input:${nodeId}`
      ? `Workflow input received for step '${nodeId}' — resuming`
      : `Workflow input marker '${markerMatch[1]}' already has a reply — clearing stale marker before step '${nodeId}'`,
    undefined,
    deps.getRunContextFor(live.id),
  );
  return "clear";
}
