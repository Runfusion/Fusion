/*
FNXC:EventDrivenDispatch 2026-09-18-00:40:
FN-519 — which TaskStore publications are worth an advisory dispatch wake.

This is the filter that keeps an event-driven engine from becoming a busy loop. `TaskStore` emits
far more than lifecycle changes — agent log lines, streamed token usage, comments, artifacts,
heartbeats, lease renewals — and a wake per emission would run an admission pass per streamed
token. Only the CANONICAL task and settings publications are classified; everything else returns
null and publishes nothing.

Scope note, stated honestly: this classifier sees an event name and a task snapshot, not a field
diff, so it cannot distinguish "moved to the hold column" from "same column, new updatedAt". It
therefore does the smallest safe thing — classify by canonical event, and let the signal's
per-(project, reason, taskId) coalescing collapse a burst. The consumers it wakes are the same
passes `task:updated` already drives today (`taskColumnWakeHandler`, the scheduler's lane wake), so
this adds no publication class the engine was not already reacting to; what it adds is that the
reaction no longer depends on a listener being attached in THIS process.

Both emission paths must be covered. `TaskStore.emit` goes through EventEmitter, while
`emitTaskLifecycleEventSafely` invokes listeners directly and RETURNS EARLY when there is no
subscriber — so a store with no local listener (a CLI process, a second store) would publish
nothing at all if only `emit` were decorated. The wake must be published regardless of local
subscriber count, because its whole purpose is to reach a consumer in ANOTHER process.
*/

import type { DispatchWakeReason } from "../dispatch-wake.js";

/** Canonical task publications that can change what a lane may select. */
const TASK_ELIGIBILITY_EVENTS: ReadonlySet<string> = new Set([
  "task:created",
  "task:updated",
  "task:moved",
]);

/**
 * Classify a store event name into a wake reason, or null to publish nothing.
 *
 * `task:deleted` maps to `release` rather than `task-eligibility`: a deleted card returns whatever
 * capacity and file-scope it held, which is a reason for OTHER cards to be looked at.
 */
export function classifyDispatchWakeReason(event: string): DispatchWakeReason | null {
  if (TASK_ELIGIBILITY_EVENTS.has(event)) return "task-eligibility";
  if (event === "task:deleted") return "release";
  if (event === "settings:updated") return "settings";
  return null;
}

/** Extract a task id from a store event's argument list, when one is safely present. */
export function resolveDispatchWakeTaskId(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (!first || typeof first !== "object") return undefined;
  const id = (first as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
