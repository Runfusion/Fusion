import type { Agent, AgentActivityEvent, AgentActivityEventType } from "../api";
import { getAgentHealthStatus } from "../utils/agentHealth";
import type { AgentHealthStatus } from "../utils/agentHealth";

/** The time an in-flight event continues to communicate live work. */
export const ACTIVE_STATE_WINDOW_MS = 30_000;
/** The shorter time a delegation remains visible on an org-chart connector. */
export const FLOW_EDGE_WINDOW_MS = 10_000;

export type ActivityEventClassification = "in-flight" | "terminal" | "delegation" | "ignored";
export type NodeActivityState = "active" | "idle" | "error" | "unknown";
export type OrgChartLink = { parentId: string; childId: string };
export type OrgChartFlowDirection = "down" | "up" | null;

/** A client-only receipt-time clamp used for future timestamps in activity window math. */
export type WindowedAgentActivityEvent = AgentActivityEvent & { activityWindowOccurredAt?: number };

/*
FNXC:AgentOrgChartActivity 2026-08-09-21:42:
FN-8865 needs every dashboard activity surface to interpret the durable event enum identically.
Keep this exhaustive mapping as the sole classification authority; agent state changes remain
agent-state authority rather than becoming a second event-derived activity signal.
*/
export const AGENT_ACTIVITY_EVENT_CLASSIFICATION: Readonly<Record<AgentActivityEventType, ActivityEventClassification>> = {
  "task:started": "in-flight",
  "task:handed-off": "delegation",
  "task:completed": "terminal",
  "agent:state-changed": "ignored",
  "workflow:gate-passed": "terminal",
  "workflow:gate-failed": "terminal",
  "approval:requested": "in-flight",
};

/** Returns milliseconds for a valid ISO timestamp, otherwise null for store-side rejection. */
export function parseActivityOccurredAt(occurredAt: unknown): number | null {
  /*
  FNXC:AgentActivityOrdering 2026-08-09-22:59:
  SSE frames cross an untyped JSON boundary. Date.parse coerces numbers, which would
  incorrectly make a malformed non-string timestamp orderable instead of dropping it.
  */
  if (typeof occurredAt !== "string") return null;
  const value = Date.parse(occurredAt);
  return Number.isFinite(value) ? value : null;
}

/*
FNXC:AgentActivityOrdering 2026-08-09-22:35:
Arrival order is unsafe because seeds, reconnect replays, and live frames race. Keep this
newest-first total order so every consumer selects the same activity without receipt-time drift.
*/
export function compareActivityEvents(a: AgentActivityEvent, b: AgentActivityEvent): number {
  const aTime = parseActivityOccurredAt(a.occurredAt);
  const bTime = parseActivityOccurredAt(b.occurredAt);
  if (aTime !== null && bTime !== null && aTime !== bTime) return bTime - aTime;
  if (aTime === null && bTime !== null) return 1;
  if (aTime !== null && bTime === null) return -1;
  return a.eventId < b.eventId ? 1 : a.eventId > b.eventId ? -1 : 0;
}

/** Stable lookup identity shared by connector geometry and activity flow derivation. */
export function orgChartEdgeKey(parentId: string, childId: string): string {
  return `${parentId}\u0000${childId}`;
}

/*
FNXC:AgentActivityFutureClock 2026-08-09-22:16:
Ordering retains the server's raw occurredAt timestamp, but recency needs a receipt-time clamp.
Without this separate anchor, repeatedly evaluating min(occurredAt, now) makes a future event
remain fresh until the wall clock reaches its bad timestamp. The store stamps this optional
client field once; pure callers may omit it and receive the current-evaluation fallback.
*/
export function withActivityWindowTimestamp(event: AgentActivityEvent, now: number): WindowedAgentActivityEvent {
  const occurredAt = parseActivityOccurredAt(event.occurredAt);
  return { ...event, activityWindowOccurredAt: occurredAt === null ? undefined : Math.min(occurredAt, now) };
}

export function getActivityEventAgeMs(event: WindowedAgentActivityEvent, now: number): number | null {
  const rawOccurredAt = parseActivityOccurredAt(event.occurredAt);
  if (rawOccurredAt === null) return null;
  const occurredAt = typeof event.activityWindowOccurredAt === "number"
    ? event.activityWindowOccurredAt
    : Math.min(rawOccurredAt, now);
  return Math.max(0, now - occurredAt);
}

function isStuckOrOverdue(agent: Agent, now: number): boolean {
  return getAgentHealthStatus(agent, 1, now).label === "Unresponsive";
}

/**
 * Resolves node state solely from its current roster record, latest retained event, and caller clock.
 * The caller supplies `now` so expiry is deterministic and can be driven by one shared store clock.
 */
export function resolveNodeActivityState(
  agent: Agent,
  latestEvent: AgentActivityEvent | undefined,
  now: number,
  healthStatus?: Pick<AgentHealthStatus, "label">,
): NodeActivityState {
  /*
  FNXC:AgentActivityHealth 2026-08-09-23:45:
  AgentsView supplies the same configured health result it renders, so activity cannot contradict a non-default heartbeat multiplier. Pure callers retain the default fallback.
  */
  if (agent.state === "error" || (healthStatus?.label ?? (isStuckOrOverdue(agent, now) ? "Unresponsive" : "")) === "Unresponsive") return "error";
  if (agent.state === "running") return "active";
  if (!latestEvent) return "unknown";

  const classification = AGENT_ACTIVITY_EVENT_CLASSIFICATION[latestEvent.type];
  const age = getActivityEventAgeMs(latestEvent, now);
  if (age === null) return "unknown";
  if (classification === "terminal") return "idle";
  if (classification === "in-flight") return age < ACTIVE_STATE_WINDOW_MS ? "active" : "idle";

  // Delegation/state-change events are not evidence of current work, but once they age out
  // they are still positive evidence that this roster agent is no longer active.
  return age >= ACTIVE_STATE_WINDOW_MS ? "idle" : "unknown";
}

function flowDirectionForLink(link: OrgChartLink, event: AgentActivityEvent): Exclude<OrgChartFlowDirection, null> | null {
  if (event.fromAgentId === link.parentId && event.toAgentId === link.childId) return "down";
  if (event.fromAgentId === link.childId && event.toAgentId === link.parentId) return "up";
  return null;
}

/**
 * Resolves the newest still-recent hand-off for each actual chart edge. Events that do not name
 * adjacent endpoints cannot create a phantom connector flow.
 */
export function resolveFlowEdges(
  links: readonly OrgChartLink[],
  events: readonly AgentActivityEvent[],
  now: number,
): ReadonlyMap<string, OrgChartFlowDirection> {
  const result = new Map<string, OrgChartFlowDirection>();
  const newestByEdge = new Map<string, AgentActivityEvent>();

  for (const event of events) {
    if (AGENT_ACTIVITY_EVENT_CLASSIFICATION[event.type] !== "delegation") continue;
    const age = getActivityEventAgeMs(event, now);
    if (age === null || age >= FLOW_EDGE_WINDOW_MS) continue;

    for (const link of links) {
      if (!flowDirectionForLink(link, event)) continue;
      const key = orgChartEdgeKey(link.parentId, link.childId);
      const current = newestByEdge.get(key);
      if (!current || compareActivityEvents(event, current) < 0) newestByEdge.set(key, event);
    }
  }

  for (const link of links) {
    const key = orgChartEdgeKey(link.parentId, link.childId);
    const event = newestByEdge.get(key);
    result.set(key, event ? flowDirectionForLink(link, event) : null);
  }
  return result;
}
