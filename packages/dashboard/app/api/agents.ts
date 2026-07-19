/**
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Agent CRUD / soul / memory client API peeled from legacy.ts.
 */
import type {
  Agent,
  AgentDetail,
  AgentCapability,
  AgentState,
  AgentHeartbeatEvent,
  AgentHeartbeatRun,
  AgentCreateInput,
  AgentUpdateInput,
  AgentTaskSession,
  AgentStats,
  HeartbeatInvocationSource,
  OrgTreeNode,
  AgentReflection,
  AgentPerformanceSummary,
  ReflectionTrigger,
  AgentBudgetStatus,
  AgentLogEntry,
} from "@fusion/core";
import type { MemoryFileInfo } from "./memory.js";
export type { Agent, AgentDetail, AgentCapability, AgentState, AgentHeartbeatEvent, AgentHeartbeatRun, AgentCreateInput, AgentUpdateInput, AgentTaskSession, AgentStats, HeartbeatInvocationSource, OrgTreeNode, AgentReflection, AgentPerformanceSummary, ReflectionTrigger, AgentBudgetStatus };
import { api, buildApiUrl } from "./client.js";
import type { FetchOptions } from "./client.js";
import { withProjectId } from "./health.js";
import { withTokenHeader } from "../auth";
import { dedupe } from "./dedupe.js";

// ── Agent API ────────────────────────────────────────────────────────────

export interface AgentPromptSizePoint {
  runId: string;
  createdAt: string;
  systemChars: number;
  execChars: number;
  totalChars: number;
}


/** Append repoPath query param for workspace-mode sub-repo targeting */

/** Fetch workspace sub-repos for a project */
export function fetchWorkspaceRepos(projectId?: string): Promise<{ repos: string[] }> {
  return api<{ repos: string[] }>(withProjectId("/git/workspace-repos", projectId));
}

/** Fetch all agents, optionally filtered by state or role */
export function fetchAgents(
  filter?: { state?: AgentState; role?: AgentCapability; includeEphemeral?: boolean },
  projectId?: string,
  options?: FetchOptions,
): Promise<Agent[]> {
  const params = new URLSearchParams();
  if (filter?.state) params.set("state", filter.state);
  if (filter?.role) params.set("role", filter.role);
  if (filter?.includeEphemeral === true) params.set("includeEphemeral", "true");
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const path = `/agents${query}`;
  return dedupe(path, () => api<Agent[]>(path), options);
}

/** Fetch a single agent with heartbeat history */
export function fetchAgent(agentId: string, projectId?: string): Promise<AgentDetail> {
  return api<AgentDetail>(withProjectId(`/agents/${encodeURIComponent(agentId)}`, projectId));
}

/** Create a new agent */
export function createAgent(input: AgentCreateInput, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId("/agents", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update an agent */
export function updateAgent(agentId: string, updates: AgentUpdateInput, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Upload an agent avatar image. */
export async function uploadAgentAvatar(agentId: string, file: File, projectId?: string): Promise<Agent> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(buildApiUrl(withProjectId(`/agents/${encodeURIComponent(agentId)}/avatar`, projectId)), {
    method: "POST",
    headers: withTokenHeader(),
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || "Avatar upload failed");
  }
  return data as Agent;
}

/** Delete an agent avatar image. */
export function deleteAgentAvatar(agentId: string, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/avatar`, projectId), {
    method: "DELETE",
  });
}

/** Backfill an existing agent onto the default heartbeat procedure file. */
export function upgradeAgentHeartbeatProcedure(
  agentId: string,
  projectId?: string,
): Promise<{ agent: Agent; heartbeatProcedurePath: string; procedureFileSeeded: boolean }> {
  return api(
    withProjectId(`/agents/${encodeURIComponent(agentId)}/upgrade-heartbeat-procedure`, projectId),
    { method: "POST" },
  );
}

/** Update agent custom instructions */
export function updateAgentInstructions(
  agentId: string,
  instructions: { instructionsPath?: string; instructionsText?: string },
  projectId?: string,
): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/instructions`, projectId), {
    method: "PATCH",
    body: JSON.stringify(instructions),
  });
}

/** Fetch agent soul/personality text */
export function fetchAgentSoul(agentId: string, projectId?: string): Promise<{ soul: string | null }> {
  return api<{ soul: string | null }>(withProjectId(`/agents/${encodeURIComponent(agentId)}/soul`, projectId));
}

/** Update agent soul/personality text */
export function updateAgentSoul(agentId: string, soul: string, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/soul`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ soul }),
  });
}

/** Fetch per-agent memory text */
export function fetchAgentMemory(agentId: string, projectId?: string): Promise<{ memory: string | null }> {
  return api<{ memory: string | null }>(withProjectId(`/agents/${encodeURIComponent(agentId)}/memory`, projectId));
}

/** Update per-agent memory text */
export function updateAgentMemory(agentId: string, memory: string, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/memory`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ memory }),
  });
}

/** List file-based memory entries for a specific agent */
export function fetchAgentMemoryFiles(agentId: string, projectId?: string): Promise<{ files: MemoryFileInfo[] }> {
  return api<{ files: MemoryFileInfo[] }>(withProjectId(`/agents/${encodeURIComponent(agentId)}/memory/files`, projectId));
}

/** Read one file-based memory entry for a specific agent */
export function fetchAgentMemoryFile(agentId: string, path: string, projectId?: string): Promise<{ path: string; content: string }> {
  const query = `path=${encodeURIComponent(path)}`;
  return api<{ path: string; content: string }>(withProjectId(`/agents/${encodeURIComponent(agentId)}/memory/file?${query}`, projectId));
}

/** Save one file-based memory entry for a specific agent */
export function saveAgentMemoryFile(agentId: string, path: string, content: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/agents/${encodeURIComponent(agentId)}/memory/file`, projectId), {
    method: "PUT",
    body: JSON.stringify({ path, content }),
  });
}

/** Update an agent's state */
export function updateAgentState(agentId: string, state: AgentState, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/state`, projectId), {
    method: "POST",
    body: JSON.stringify({ state }),
  });
}

/** Delete an agent */
export function deleteAgent(agentId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/agents/${encodeURIComponent(agentId)}`, projectId), {
    method: "DELETE",
  });
}

/** Record a heartbeat for an agent */
export function recordAgentHeartbeat(
  agentId: string,
  status: "ok" | "missed" | "recovered" = "ok",
  projectId?: string,
): Promise<AgentHeartbeatEvent> {
  return api<AgentHeartbeatEvent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/heartbeat`, projectId), {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

/** Fetch heartbeat history for an agent */
export function fetchAgentHeartbeats(agentId: string, limit?: number, projectId?: string): Promise<AgentHeartbeatEvent[]> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentHeartbeatEvent[]>(`/agents/${encodeURIComponent(agentId)}/heartbeats${query}`);
}

/** Fetch heartbeat runs for an agent */
export function fetchAgentRuns(agentId: string, limit?: number, projectId?: string): Promise<AgentHeartbeatRun[]> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentHeartbeatRun[]>(`/agents/${encodeURIComponent(agentId)}/runs${query}`);
}

/** Fetch a single heartbeat run detail */
export function fetchAgentRunDetail(agentId: string, runId: string, projectId?: string): Promise<AgentHeartbeatRun> {
  return api<AgentHeartbeatRun>(withProjectId(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, projectId));
}

/** Fetch agent logs for a specific run's time window */
export function fetchAgentRunLogs(agentId: string, runId: string, projectId?: string): Promise<AgentLogEntry[]> {
  return api<AgentLogEntry[]>(withProjectId(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/logs`, projectId));
}

/** Fetch recent prompt size points for an agent */
export function fetchAgentPromptSizes(agentId: string, limit?: number, projectId?: string): Promise<AgentPromptSizePoint[]> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentPromptSizePoint[]>(`/agents/${encodeURIComponent(agentId)}/prompt-sizes${query}`);
}

/** Manually start a heartbeat run for an agent */
export function startAgentRun(
  agentId: string,
  projectId?: string,
  options?: { source?: HeartbeatInvocationSource; triggerDetail?: string },
): Promise<AgentHeartbeatRun> {
  const source = options?.source ?? "manual";
  const triggerDetail = options?.triggerDetail ?? "Agent activated via dashboard";
  return api<AgentHeartbeatRun>(withProjectId(`/agents/${encodeURIComponent(agentId)}/runs`, projectId), {
    method: "POST",
    body: JSON.stringify({ source, triggerDetail }),
  });
}

/** Stop an active heartbeat run for an agent */
export function stopAgentRun(
  agentId: string,
  projectId?: string,
): Promise<{ ok: boolean; runId?: string; message?: string }> {
  return api<{ ok: boolean; runId?: string; message?: string }>(
    withProjectId(`/agents/${encodeURIComponent(agentId)}/runs/stop`, projectId),
    {
      method: "POST",
    },
  );
}

