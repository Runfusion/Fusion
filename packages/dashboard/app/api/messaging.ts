/**
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Mailbox, approvals, agent reflections/ratings, and budget client API peeled from legacy.ts.
 */
import type {
  Message,
  MessageMetadata,
  MessageType,
  ParticipantType,
  AgentRating,
  AgentRatingSummary,
  AgentRatingInput,
  AgentReflection,
  AgentPerformanceSummary,
  AgentBudgetStatus,
  ApprovalRequestStatus,
} from "@fusion/core";
import { api } from "./client.js";
import { withProjectId } from "./health.js";

// ── Messages API ──────────────────────────────────────────────────────────

/** Response shape for GET /messages/inbox */
export interface InboxResponse {
  messages: Message[];
  total: number;
  unreadCount: number;
}

/** Response shape for GET /messages/outbox */
export interface OutboxResponse {
  messages: Message[];
  total: number;
}

/** Response shape for GET /messages/unread-count */
export interface UnreadCountResponse {
  unreadCount: number;
  pendingApprovalCount?: number;
}

/** Response shape for POST /messages/read-all */
export interface MarkAllReadResponse {
  markedAsRead: number;
}

/** Response shape for GET /agents/:id/mailbox */
export interface AgentMailboxResponse {
  ownerId: string;
  ownerType: ParticipantType;
  unreadCount: number;
  lastMessage?: Message;
  messages: Message[];      // Backward compat alias for inbox
  inbox: Message[];
  outbox: Message[];
}

/** Response shape for GET /agents/mailbox/all */
export interface AllAgentsMailboxResponse {
  messages: Message[];
  total: number;
  unreadCount: number;
}

/** Input for sending a message via the dashboard */
export interface SendMessageInput {
  toId: string;
  toType: ParticipantType;
  content: string;
  type: MessageType;
  metadata?: MessageMetadata;
  wakeImmediately?: boolean;
}

export interface ApprovalRequestSummary {
  id: string;
  status: ApprovalRequestStatus;
  actionCategory: string;
  actionSummary: string;
  agentId: string;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface ApprovalRequestDetail extends ApprovalRequestSummary {
  requester: {
    actorId: string;
    actorType: "agent" | "user" | "system";
    actorName: string;
  };
  runId?: string;
  requestedAt: string;
  completedAt?: string;
  targetAction: {
    category: string;
    action: string;
    summary: string;
    resourceType: string;
    resourceId: string;
    context?: Record<string, unknown>;
  };
  history: Array<{
    id: string;
    eventType: string;
    actor: {
      actorId: string;
      actorType: "agent" | "user" | "system";
      actorName: string;
    };
    note?: string;
    createdAt: string;
  }>;
}

export interface ApprovalListResponse {
  requests: ApprovalRequestSummary[];
  total: number;
  pendingCount: number;
}

/** Fetch inbox messages for the current user. */
export function fetchInbox(
  options?: { limit?: number; offset?: number; unreadOnly?: boolean; type?: MessageType },
  projectId?: string,
): Promise<InboxResponse> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  if (options?.unreadOnly) params.set("unreadOnly", "true");
  if (options?.type) params.set("type", options.type);
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<InboxResponse>(`/messages/inbox${query}`);
}

/** Fetch sent messages for the current user. */
export function fetchOutbox(
  options?: { limit?: number; offset?: number; type?: MessageType },
  projectId?: string,
): Promise<OutboxResponse> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  if (options?.type) params.set("type", options.type);
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<OutboxResponse>(`/messages/outbox${query}`);
}

/** Fetch unread message count (lightweight, for header badge). */
export function fetchUnreadCount(projectId?: string): Promise<UnreadCountResponse> {
  return api<UnreadCountResponse>(withProjectId("/messages/unread-count", projectId));
}

/** Fetch a single message by ID. */
export function fetchMessage(id: string, projectId?: string): Promise<Message> {
  return api<Message>(withProjectId(`/messages/${encodeURIComponent(id)}`, projectId));
}

/** Send a new message. */
export function sendMessage(input: SendMessageInput, projectId?: string): Promise<Message> {
  return api<Message>(withProjectId("/messages", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Materialize an operator-approved task proposal exactly once. */
export function createProposedTask(id: string, projectId?: string): Promise<{ task: import("@fusion/core").Task; proposal: Message }> {
  return api(withProjectId(`/messages/${encodeURIComponent(id)}/create-proposed-task`, projectId), { method: "POST" });
}

/** Mark a specific message as read. */
export function markMessageRead(id: string, projectId?: string): Promise<Message> {
  return api<Message>(withProjectId(`/messages/${encodeURIComponent(id)}/read`, projectId), {
    method: "POST",
  });
}

/** Mark all inbox messages as read. */
export function markAllMessagesRead(projectId?: string): Promise<MarkAllReadResponse> {
  return api<MarkAllReadResponse>(withProjectId("/messages/read-all", projectId), {
    method: "POST",
  });
}

/** Delete a message. */
export function deleteMessage(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/messages/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/** Fetch conversation between current user and a specific participant. */
export function fetchConversation(
  participantId: string,
  participantType: ParticipantType,
  projectId?: string,
): Promise<Message[]> {
  const path = `/messages/conversation/${encodeURIComponent(participantType)}/${encodeURIComponent(participantId)}`;
  return api<Message[]>(withProjectId(path, projectId));
}

/** Fetch an agent's mailbox (admin read-only view). */
export function fetchAgentMailbox(agentId: string, projectId?: string): Promise<AgentMailboxResponse> {
  return api<AgentMailboxResponse>(withProjectId(`/agents/${encodeURIComponent(agentId)}/mailbox`, projectId));
}

/** Fetch aggregate mailbox across all agent-to-agent messages (admin read-only view). */
export function fetchAllAgentMailbox(projectId?: string): Promise<AllAgentsMailboxResponse> {
  return api<AllAgentsMailboxResponse>(withProjectId("/agents/mailbox/all", projectId));
}

export function fetchApprovals(
  options?: { status?: ApprovalRequestStatus; limit?: number; offset?: number },
  projectId?: string,
): Promise<ApprovalListResponse> {
  const params = new URLSearchParams();
  if (options?.status) params.set("status", options.status);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<ApprovalListResponse>(`/approvals${query}`);
}

export function fetchApprovalDetail(id: string, projectId?: string): Promise<ApprovalRequestDetail> {
  return api<ApprovalRequestDetail>(withProjectId(`/approvals/${encodeURIComponent(id)}`, projectId));
}

export function decideApproval(
  id: string,
  input: { decision: "approve" | "deny"; comment?: string },
  projectId?: string,
): Promise<ApprovalRequestDetail> {
  return api<ApprovalRequestDetail>(withProjectId(`/approvals/${encodeURIComponent(id)}/decision`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch reflection history for an agent. */
export function fetchAgentReflections(agentId: string, limit?: number, projectId?: string): Promise<AgentReflection[]> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentReflection[]>(`/agents/${encodeURIComponent(agentId)}/reflections${query}`);
}

/** Fetch the most recent reflection for an agent. */
export function fetchAgentReflection(agentId: string, projectId?: string): Promise<AgentReflection> {
  return api<AgentReflection>(withProjectId(`/agents/${encodeURIComponent(agentId)}/reflections/latest`, projectId));
}

/** Trigger a manual reflection for an agent. */
export function triggerAgentReflection(agentId: string, projectId?: string): Promise<AgentReflection | null> {
  return api<AgentReflection | null>(withProjectId(`/agents/${encodeURIComponent(agentId)}/reflections`, projectId), {
    method: "POST",
  });
}

/** Fetch aggregated performance summary for an agent. */
export function fetchAgentPerformance(agentId: string, windowMs?: number, projectId?: string): Promise<AgentPerformanceSummary> {
  const params = new URLSearchParams();
  if (windowMs !== undefined) params.set("windowMs", String(windowMs));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentPerformanceSummary>(`/agents/${encodeURIComponent(agentId)}/performance${query}`);
}

/** Fetch ratings for an agent */
export function fetchAgentRatings(
  agentId: string,
  options?: { limit?: number; category?: string },
  projectId?: string,
): Promise<AgentRating[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.category) params.set("category", options.category);
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentRating[]>(`/agents/${encodeURIComponent(agentId)}/ratings${query}`);
}

/** Add a rating for an agent */
export function addAgentRating(
  agentId: string,
  input: AgentRatingInput,
  projectId?: string,
): Promise<AgentRating> {
  return api<AgentRating>(withProjectId(`/agents/${encodeURIComponent(agentId)}/ratings`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch rating summary for an agent */
export function fetchAgentRatingSummary(agentId: string, projectId?: string): Promise<AgentRatingSummary> {
  return api<AgentRatingSummary>(withProjectId(`/agents/${encodeURIComponent(agentId)}/ratings/summary`, projectId));
}

/** Delete a specific rating */
export function deleteAgentRating(agentId: string, ratingId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/agents/${encodeURIComponent(agentId)}/ratings/${encodeURIComponent(ratingId)}`, projectId), {
    method: "DELETE",
  });
}

// ── Agent Budget API ──────────────────────────────────────────────────────

/** Fetch budget status for an agent */
export function fetchAgentBudgetStatus(agentId: string, projectId?: string): Promise<AgentBudgetStatus> {
  return api<AgentBudgetStatus>(withProjectId(`/agents/${encodeURIComponent(agentId)}/budget`, projectId));
}

/** Reset budget usage for an agent */
export function resetAgentBudget(agentId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/agents/${encodeURIComponent(agentId)}/budget/reset`, projectId), {
    method: "POST",
  });
}

