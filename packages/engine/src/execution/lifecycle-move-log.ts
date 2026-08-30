import {
  ENGINE_BACKWARD_MOVE_REASONS,
  LIFECYCLE_ROLE_RANK,
  type TaskMoveLanes,
  type TaskStore,
} from "@fusion/core";

type MoveSource = "user" | "engine" | "scheduler";

type MovedEvent = {
  task: { id: string };
  from: string;
  to: string;
  source: MoveSource;
  requestedSource?: MoveSource;
  lifecycleReason?: string;
  /*
  FNXC:LifecycleContainment 2026-08-28-04:47:
  FN-207 — the graph mover's own provenance, forwarded by the canonical `task:moved` emitter.
  It is the cause of record for FORWARD transitions, which never carry a `lifecycleReason`
  (that registry covers explicit engine/scheduler BACKWARD moves only).
  */
  workflowMoveSource?: string;
  lanes?: TaskMoveLanes;
};

function laneRole(column: string, lanes: TaskMoveLanes | undefined): keyof typeof LIFECYCLE_ROLE_RANK | undefined {
  if (!lanes) return undefined;
  for (const role of Object.keys(LIFECYCLE_ROLE_RANK) as Array<keyof typeof LIFECYCLE_ROLE_RANK>) {
    const lane = lanes[role];
    if (Array.isArray(lane) ? lane.includes(column) : lane === column) return role;
  }
  return undefined;
}

export function lifecycleMoveDirection(event: Pick<MovedEvent, "from" | "to" | "lanes">): string {
  const fromRole = laneRole(event.from, event.lanes);
  const toRole = laneRole(event.to, event.lanes);
  if (!fromRole || !toRole) return "unclassified";
  const delta = LIFECYCLE_ROLE_RANK[toRole] - LIFECYCLE_ROLE_RANK[fromRole];
  if (delta > 0) return "forward";
  if (delta < 0) return "backward";
  return "lateral";
}

/*
FNXC:LifecycleContainment 2026-08-28-04:47:
Cause resolution is ordered most-specific first: a registered backward reason, then the mover's
graph provenance, then — only when the move genuinely names nothing — "unattributed automatic move".
FN-207 requires that last string to mean "nobody declared a cause", not "the cause was discarded on
the way to the log": while forward graph moves rendered as unattributed, the operator could not tell
a legitimate pipeline advance from the unexplained wander the task was filed against, which is what
made the log useless for the diagnosis it exists to serve.
*/
export function formatLifecycleMoveLog(event: MovedEvent): string {
  const registeredReason = event.lifecycleReason
    ? (ENGINE_BACKWARD_MOVE_REASONS[event.lifecycleReason]?.summary ?? event.lifecycleReason)
    : undefined;
  const provenance = event.workflowMoveSource?.trim();
  const cause = registeredReason
    ?? (provenance ? `${provenance} transition` : "unattributed automatic move");
  return `Lifecycle move: ${event.from} → ${event.to} (${lifecycleMoveDirection(event)}) — ${cause} [source=${event.requestedSource ?? event.source}]`;
}

/**
 * Attach the sole operator-visible lifecycle log listener. The event is emitted
 * after commit; logging remains best effort so an activity sink cannot alter a
 * completed transition.
 */
export function registerLifecycleMoveLog(store: Pick<TaskStore, "on" | "off" | "logEntry">): () => void {
  const listener = (event: MovedEvent) => {
    if (event.from === event.to) return;
    void store.logEntry(event.task.id, formatLifecycleMoveLog(event)).catch(() => undefined);
  };
  store.on("task:moved", listener);
  return () => store.off("task:moved", listener);
}
