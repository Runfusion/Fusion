/**
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * AI / planning session client API peeled from legacy.ts.
 */
import type { PlanningQuestion, ThinkingLevel } from "@fusion/core";
import { api, buildApiUrl, ApiRequestError, looksLikeHtml } from "../client/client.js";
import { withProjectId } from "../client/health.js";
import { withTokenHeader } from "../../auth";

// ── AI Sessions ────────────────────────────────────────────────────────────

/**
 * Needs-attention variants for a CLI agent session (CLI Agent Executor, U11).
 * Each carries pinned banner copy + action verbs:
 *  - userExited        → Advance / Retry / Cancel task
 *  - authFailed        → Re-authenticate / Retry
 *  - resume-exhausted  → Relaunch fresh / Cancel task
 */
export type CliNeedsAttentionVariant = "userExited" | "authFailed" | "resume-exhausted";

export interface AiSessionSummary {
  id: string;
  type:
    | "planning"
    | "subtask"
    | "mission_interview"
    | "milestone_interview"
    | "slice_interview"
    | "cli-agent";
  status:
    | "draft"
    | "generating"
    | "awaiting_input"
    | "complete"
    | "error"
    | "waiting_on_input"
    | "needs_attention";
  /** For cli-agent sessions: which needs-attention variant (drives pinned copy/actions). */
  cliVariant?: CliNeedsAttentionVariant;
  /** Underlying CLI session id, for action wiring (confirm-advance / re-auth / etc.). */
  cliSessionId?: string;
  title: string;
  /** Server-derived preview of the in-progress initialPlan; only set for draft planning sessions. */
  preview?: string;
  projectId: string | null;
  updatedAt: string;
  archived?: boolean;
}

export interface ConversationHistoryEntry {
  question?: PlanningQuestion;
  response?: Record<string, unknown>;
  thinkingOutput?: string;
}

export interface AiSessionDetail extends AiSessionSummary {
  inputPayload: string;
  conversationHistory: string;
  currentQuestion: string | null;
  result: string | null;
  thinkingOutput: string;
  error: string | null;
  createdAt: string;
}

export function parseConversationHistory(raw: string): ConversationHistoryEntry[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/*
FNXC:AiSessions 2026-07-19-12:30:
fetchAiSessions / fetchAiSession intentionally soft-fail to [] / null instead of
throwing via api(). Session pickers and multi-tab planners poll these endpoints and
prefer an empty/missing surface over error banners when auth blips or the engine is
momentarily unavailable — diverges from archive/ping helpers that must surface failures.
*/
export async function fetchAiSessions(
  projectId?: string,
  options?: { includeCompleted?: boolean; includeArchived?: boolean; type?: AiSessionSummary["type"] },
): Promise<AiSessionSummary[]> {
  const search = new URLSearchParams();
  if (projectId) search.set("projectId", projectId);
  if (options?.includeCompleted) search.set("includeCompleted", "1");
  if (options?.includeArchived) search.set("includeArchived", "1");
  if (options?.type) search.set("type", options.type);
  const qs = search.toString();
  const res = await fetch(buildApiUrl(`/ai-sessions${qs ? `?${qs}` : ""}`), {
    headers: withTokenHeader(),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.sessions ?? [];
}

export async function archiveAiSession(id: string): Promise<void> {
  return api<void>(`/ai-sessions/${encodeURIComponent(id)}/archive`, {
    method: "POST",
  });
}

export async function unarchiveAiSession(id: string): Promise<void> {
  return api<void>(`/ai-sessions/${encodeURIComponent(id)}/unarchive`, {
    method: "POST",
  });
}

/** Soft-fail companion to fetchAiSessions — see FNXC:AiSessions above. */
export async function fetchAiSession(id: string): Promise<AiSessionDetail | null> {
  const res = await fetch(buildApiUrl(`/ai-sessions/${encodeURIComponent(id)}`), {
    headers: withTokenHeader(),
  });
  if (!res.ok) return null;
  return res.json();
}

/*
FNXC:PlanningMultiTab 2026-07-14-00:00:
acquireSessionLock / releaseSessionLock / forceAcquireSessionLock were removed with the rest of
the per-tab session lock; their routes no longer exist. AI interview sessions are multi-tab —
the persisted session row is the shared source of truth and any tab may read and interact.
*/

export async function deleteAiSession(id: string): Promise<void> {
  const url = buildApiUrl(`/ai-sessions/${encodeURIComponent(id)}`);
  const res = await fetch(url, {
    method: "DELETE",
    headers: withTokenHeader(),
  });

  if (res.ok || res.status === 404) {
    return;
  }

  const contentType = res.headers.get("content-type") ?? "";
  const bodyText = await res.text();
  const isJson = contentType.includes("application/json");
  const isHtml = contentType.includes("text/html") || looksLikeHtml(bodyText);

  if (isHtml) {
    throw new Error(
      `API returned HTML instead of JSON for ${url}. ` +
      `The endpoint may not be properly configured. (${res.status} ${res.statusText})`
    );
  }

  if (!isJson) {
    const preview = bodyText.length > 160 ? `${bodyText.slice(0, 160)}...` : bodyText;
    throw new Error(
      `API returned ${contentType || "an unknown content type"} instead of JSON for ${url}. ` +
      `(${res.status} ${res.statusText})${preview ? ` Response: ${preview}` : ""}`
    );
  }

  let data: unknown;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    throw new Error(`API returned invalid JSON for ${url}. (${res.status} ${res.statusText})`);
  }

  const payload = data as { error?: string; details?: Record<string, unknown> } | null;
  throw new ApiRequestError(
    payload?.error || `Request failed for ${url}: ${res.status} ${res.statusText}`,
    res.status,
    payload?.details,
  );
}

export function pingSession(sessionId: string, projectId?: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(withProjectId(`/ai-sessions/${encodeURIComponent(sessionId)}/ping`, projectId), {
    method: "POST",
  });
}

export function updatePlanningSessionDraft(
  sessionId: string,
  draft: { initialPlan: string; modelProvider?: string; modelId?: string; thinkingLevel?: ThinkingLevel },
  projectId?: string,
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(withProjectId(`/ai-sessions/${encodeURIComponent(sessionId)}/draft`, projectId), {
    method: "PATCH",
    body: JSON.stringify(draft),
  });
}

/**
 * Ask the server to (re)generate the sidebar title for a draft planning
 * session from its persisted initialPlan. Server-side is idempotent and
 * a no-op once the session has been started, so callers can fire-and-
 * forget on textarea blur and modal close.
 */
export function summarizePlanningDraftTitle(
  sessionId: string,
  projectId?: string,
): Promise<{ title: string | null }> {
  return api<{ title: string | null }>(
    withProjectId(`/planning/${encodeURIComponent(sessionId)}/summarize-draft-title`, projectId),
    { method: "POST" },
  );
}

/*
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Preserve legacy `messaging` imports while implementations live in messaging.ts.
 */
export {
  addAgentRating,
  createProposedTask,
  decideApproval,
  deleteAgentRating,
  deleteMessage,
  fetchAgentBudgetStatus,
  fetchAgentMailbox,
  fetchAgentPerformance,
  fetchAgentRatingSummary,
  fetchAgentRatings,
  fetchAgentReflection,
  fetchAgentReflections,
  fetchAllAgentMailbox,
  fetchApprovalDetail,
  fetchApprovals,
  fetchConversation,
  fetchInbox,
  fetchMessage,
  fetchOutbox,
  fetchUnreadCount,
  markAllMessagesRead,
  markMessageRead,
  resetAgentBudget,
  sendMessage,
  triggerAgentReflection,
} from "../chat/messaging.js";
export type {
  AgentMailboxResponse,
  AllAgentsMailboxResponse,
  ApprovalListResponse,
  ApprovalRequestDetail,
  ApprovalRequestSummary,
  InboxResponse,
  MarkAllReadResponse,
  OutboxResponse,
  SendMessageInput,
  UnreadCountResponse,
} from "../chat/messaging.js";

/*
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Preserve legacy `plugins-and-skills` imports while implementations live in plugins-and-skills.ts.
 */
export {
  disablePlugin,
  enablePlugin,
  fetchDiscoveredSkills,
  fetchPluginDashboardViews,
  fetchPluginDetail,
  fetchPluginRegistry,
  fetchPluginRuntimes,
  fetchPluginSettings,
  fetchPluginSetupStatus,
  fetchPluginUiContributions,
  fetchPluginUiSlots,
  fetchPlugins,
  fetchSkillContent,
  fetchSkillFileContent,
  fetchSkillsCatalog,
  installPlugin,
  installPluginSetup,
  installSkill,
  reloadPlugin,
  rescanPlugin,
  toggleExecutionSkill,
  uninstallPlugin,
  updatePlugin,
  updatePluginSettings,
} from "../system/plugins-and-skills.js";
export type {
  PluginDashboardViewEntry,
  PluginRuntimeInfo,
  PluginSetupStatusResponse,
  PluginUiContributionEntry,
  PluginUiSlotEntry,
  RegistryPluginEntry,
} from "../system/plugins-and-skills.js";

export function startKeepAlive(
  sessionId: string,
  projectId?: string,
  intervalMs = 25_000,
): { stop: () => void } {
  const timer = setInterval(() => {
    void pingSession(sessionId, projectId).catch(() => {
      // Best-effort keepalive: ignore failures so streams remain active.
    });
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
