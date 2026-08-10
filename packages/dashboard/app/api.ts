/**
 * Compatibility barrel for the dashboard client API surface.
 *
 * Existing callers import from `../api` / `../../api`; keep this entrypoint stable
 * while implementation lives under `app/api/*` modules.
 */
import { api } from "./api/client/client";

export * from "./api/legacy";
export * from "./api/settings/provider-status";
export * from "./api/planning/models-usage";
export * from "./api/chat";
export * from "./api-node";
export * from "./api/system/report";

/*
FNXC:AgentActivityStream 2026-08-09-09:38:
The monitoring clients receive durable event frames and an explicit truncation marker on the same SSE event name. A marker is not an activity row; consumers fetch the omitted range through the typed history route.
*/
export type AgentActivityEventType =
  | "task:started"
  | "task:handed-off"
  | "task:completed"
  | "agent:state-changed"
  | "workflow:gate-passed"
  | "workflow:gate-failed"
  | "approval:requested";

export interface AgentActivityEvent {
  seq: string;
  eventId: string;
  projectId: string;
  agentId: string;
  agentAttribution: "agent" | "lane" | "actor";
  taskId: string | null;
  type: AgentActivityEventType;
  fromAgentId: string | null;
  toAgentId: string | null;
  summary: string;
  occurredAt: string;
  metadata: Record<string, unknown> | null;
}

export interface AgentActivityTruncatedFrame {
  truncated: true;
  fromSeq: string;
  toSeq: string;
}

export type AgentActivitySseFrame = AgentActivityEvent | AgentActivityTruncatedFrame;

export interface AgentActivityPage {
  events: AgentActivityEvent[];
  nextCursor: string | null;
}

export async function getAgentActivity(
  params: Record<string, string | number | undefined> = {},
  options?: Pick<RequestInit, "signal">,
): Promise<AgentActivityPage> {
  const query = new URLSearchParams(
    Object.entries(params)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  /*
  FNXC:AgentActivityClient 2026-08-09-23:44:
  Activity seeding must use the shared client so project auth, base-path handling, and request identity match every dashboard API request.
  */
  return api<AgentActivityPage>(`/agent-activity${query.size ? `?${query}` : ""}`, options);
}
