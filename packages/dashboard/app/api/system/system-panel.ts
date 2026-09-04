/**
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Command Center System panel client API peeled from legacy.ts.
 */
import { api } from "../client/client.js";
import { withProjectId } from "../client/health.js";

// ── System Panel (Command Center → System) ──────────────────────────────────

/*
FNXC:SystemPanel 2026-07-12-11:35:
Typed client for the /api/system operator controls: capability discovery,
in-place restart, rebuild jobs with streamed output, engine/agent restarts,
plugin reload, and the host-process log viewer.
*/

/*
FNXC:SystemPanelFnBinary 2026-07-15-09:54:
Job snapshots cover rebuild scopes and the fn-binary link-local / use-global
actions that stream into the same System panel log viewer.
*/
export interface SystemRebuildJobSnapshot {
  id: string;
  kind: "rebuild" | "fn-binary" | "source-update";
  scope: "app" | "full" | "plugins" | "link-local" | "use-global" | "source-update";
  restartAfter: boolean;
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  error?: string;
  restartScheduled?: boolean;
  pluginsReloaded?: string[];
  droppedLines: number;
  lineCount: number;
  lines?: SystemRebuildJobLine[];
}

export interface SystemRebuildJobLine {
  i: number;
  ts: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface SystemInfoResponse {
  supervised: boolean;
  restartSupported: boolean;
  rebuildSupported: boolean;
  /** True when the host is a Fusion source checkout (dev) — can build & link local fn. */
  fnBinaryLinkLocalSupported?: boolean;
  /** Always true when the route is wired; UI may still disable while a job runs. */
  fnBinaryUseGlobalSupported?: boolean;
  /*
  FNXC:SystemPanelSourceUpdate 2026-09-01-01:22:
  True when the running process was launched from a GIT checkout it can pull and rebuild. The
  container's image-baked /app is a workspace root but not a git checkout, so this is deliberately
  narrower than rebuildSupported.
  */
  sourceUpdateSupported?: boolean;
  sourceWorkspaceRoot?: string;
  logsSupported: boolean;
  engineAvailable: boolean;
  pluginReloadSupported: boolean;
  pid: number;
  uptimeSeconds: number;
  nodeVersion: string;
  platform: string;
  arch: string;
  memoryRssBytes: number;
  activeRebuild: SystemRebuildJobSnapshot | null;
  lastRebuild: SystemRebuildJobSnapshot | null;
}

export interface SystemLogEntryDto {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  prefix?: string;
}

export function fetchSystemInfo(): Promise<SystemInfoResponse> {
  return api<SystemInfoResponse>("/system/info");
}

export function requestSystemRestart(reason?: string): Promise<{ scheduled: boolean }> {
  return api<{ scheduled: boolean }>("/system/restart", {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/*
FNXC:SystemPanelSourceUpdate 2026-09-01-01:22:
Start the pull-build-restart job for the source checkout the server runs from. Returns the same job
snapshot shape as rebuild, so the System panel streams it through /system/jobs/:id/stream unchanged.
A remote contributor with only dashboard access uses this to ship and run new code; the server never
restarts unless the build succeeded.
*/
export function startSystemSourceUpdate(restart?: boolean): Promise<SystemRebuildJobSnapshot> {
  return api<SystemRebuildJobSnapshot>("/system/source/update", {
    method: "POST",
    body: JSON.stringify({ restart }),
  });
}

export function startSystemRebuild(
  scope: "app" | "full" | "plugins",
  restart?: boolean,
): Promise<SystemRebuildJobSnapshot> {
  return api<SystemRebuildJobSnapshot>("/system/rebuild", {
    method: "POST",
    body: JSON.stringify({ scope, restart }),
  });
}

/*
FNXC:SystemPanelFnBinary 2026-07-15-09:54:
Client wrappers for System panel fn-binary actions. Both return a job snapshot
that the panel streams via /system/jobs/:id/stream (same path as rebuild).
*/
export function startFnBinaryLinkLocal(): Promise<SystemRebuildJobSnapshot> {
  return api<SystemRebuildJobSnapshot>("/system/fn-binary/link-local", { method: "POST" });
}

export function startFnBinaryUseGlobal(): Promise<SystemRebuildJobSnapshot> {
  return api<SystemRebuildJobSnapshot>("/system/fn-binary/use-global", { method: "POST" });
}

export function fetchCurrentSystemRebuild(): Promise<{ job: SystemRebuildJobSnapshot | null }> {
  return api<{ job: SystemRebuildJobSnapshot | null }>("/system/rebuild/current");
}

export function restartSystemEngines(): Promise<{
  restarted: string[];
  failed: Array<{ projectId: string; error: string }>;
}> {
  return api("/system/engine/restart", { method: "POST" });
}

export function restartAllSystemAgents(projectId?: string): Promise<{
  restarted: string[];
  failed: Array<{ agentId: string; error: string }>;
}> {
  return api(withProjectId("/system/agents/restart-all", projectId), { method: "POST" });
}

export function reloadAllSystemPlugins(): Promise<{
  reloaded: string[];
  failed: Array<{ id: string; error: string }>;
}> {
  return api("/system/plugins/reload-all", { method: "POST" });
}

export function fetchSystemLogs(limit?: number): Promise<{ entries: SystemLogEntryDto[] }> {
  const suffix = limit ? `?limit=${limit}` : "";
  return api<{ entries: SystemLogEntryDto[] }>(`/system/logs${suffix}`);
}

export type ResearchFindingPromotionInput = {
  findingId: string;
  sliceId: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  triage?: boolean;
  taskId?: string;
};

export function promoteResearchFinding(
  runId: string,
  input: ResearchFindingPromotionInput,
  projectId?: string,
): Promise<{ runId: string; findingId: string; feature: { id: string; status: string; taskId?: string }; citations: string[]; reused: boolean }> {
  return api(withProjectId(`/research/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(input.findingId)}/promote`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}
