/**
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Dev server detection and session management client API peeled from legacy.ts.
 */

import { api, buildApiUrl } from "../client/client.js";
import { withProjectId } from "../client/health.js";

export interface DevServerCandidate {
  scriptName: string;
  command: string;
  packagePath: string;
  confidence: number;
  name: string;
  cwd: string;
  source: string;
  workspaceName?: string;
  label: string;
}

// Backward-compatible alias for backend naming in FN-2178 scope.
export type DetectedCandidate = DevServerCandidate;

export interface DevServerState {
  id: string;
  name: string;
  status: "stopped" | "starting" | "running" | "failed";
  command: string;
  scriptName: string;
  cwd: string;
  pid?: number;
  startedAt?: string;
  previewUrl?: string;
  detectedUrl?: string;
  detectedPort?: number;
  manualPreviewUrl?: string;
  manualUrl?: string;
  logs: string[];
  exitCode?: number | null;
}

export type DevServerStatus = DevServerState;

export interface DevServerStartInput {
  command: string;
  scriptName?: string;
  cwd?: string;
  packagePath?: string;
}

export interface DevServerConfig {
  selectedScript: string | null;
  selectedSource: string | null;
  selectedCommand: string | null;
  previewUrlOverride: string | null;
  detectedPreviewUrl: string | null;
  selectedAt: string | null;
}

export interface DevServerLogHistoryEntry {
  id: number;
  text: string;
  stream: "stdout" | "stderr";
  timestamp: string;
}

export interface DevServerLogHistoryResponse {
  lines: DevServerLogHistoryEntry[];
  totalLines: number;
}

export interface FetchDevServerLogHistoryOptions {
  maxLines?: number;
  offset?: number;
  lastEventId?: number;
}

export interface DevServerConfig {
  selectedScript: string | null;
  selectedSource: string | null;
  selectedCommand: string | null;
  previewUrlOverride: string | null;
  detectedPreviewUrl: string | null;
  selectedAt: string | null;
}

interface BackendDevServerCandidate {
  name: string;
  command: string;
  source?: string;
  packageName?: string;
  packagePath?: string;
  confidence?: number;
}

interface BackendDevServerState {
  id?: string;
  name?: string;
  status?: "stopped" | "starting" | "running" | "failed";
  command?: string;
  scriptId?: string;
  cwd?: string;
  pid?: number;
  startedAt?: string;
  previewUrl?: string;
  detectedUrl?: string;
  detectedPort?: number;
  manualPreviewUrl?: string;
  manualUrl?: string;
  logHistory?: string[];
  exitCode?: number | null;
}

interface BackendDevServerLogHistoryLine {
  id?: number;
  text?: string;
  line?: string;
  stream?: "stdout" | "stderr";
  timestamp?: string;
}

interface BackendDevServerLogHistoryResponse {
  lines?: BackendDevServerLogHistoryLine[];
  totalLines?: number;
}

function mapBackendCandidateToFrontend(candidate: BackendDevServerCandidate): DevServerCandidate {
  const source = typeof candidate.source === "string" && candidate.source.trim().length > 0
    ? candidate.source.trim()
    : "root";
  const cwd = source === "root" ? "." : source;
  const scriptName = candidate.name;
  const packagePath = typeof candidate.packagePath === "string" && candidate.packagePath.trim().length > 0
    ? candidate.packagePath.trim()
    : cwd;
  const confidence = typeof candidate.confidence === "number"
    ? candidate.confidence
    : 1;

  const locationLabel = source === "root" ? "root" : source;
  const packageLabel = typeof candidate.packageName === "string" && candidate.packageName.trim().length > 0
    ? candidate.packageName.trim()
    : "project";

  return {
    name: candidate.name,
    command: candidate.command,
    scriptName,
    packagePath,
    confidence,
    cwd,
    source,
    workspaceName: typeof candidate.packageName === "string" ? candidate.packageName : undefined,
    label: `${packageLabel} · ${scriptName} (${locationLabel})`,
  };
}

function mapBackendStateToFrontend(state: BackendDevServerState): DevServerState {
  const status = state.status;
  const normalizedStatus = status === "starting" || status === "running" || status === "failed" || status === "stopped"
    ? status
    : "stopped";

  const previewUrl = typeof state.previewUrl === "string"
    ? state.previewUrl
    : state.detectedUrl;
  const manualPreviewUrl = typeof state.manualPreviewUrl === "string"
    ? state.manualPreviewUrl
    : state.manualUrl;

  return {
    id: typeof state.id === "string" ? state.id : "",
    name: typeof state.name === "string" && state.name.length > 0 ? state.name : "default",
    status: normalizedStatus,
    command: typeof state.command === "string" ? state.command : "",
    scriptName: typeof state.scriptId === "string" ? state.scriptId : "",
    cwd: typeof state.cwd === "string" ? state.cwd : "",
    pid: state.pid,
    startedAt: state.startedAt,
    previewUrl,
    detectedUrl: typeof state.detectedUrl === "string" ? state.detectedUrl : previewUrl,
    detectedPort: state.detectedPort,
    manualPreviewUrl,
    manualUrl: typeof state.manualUrl === "string" ? state.manualUrl : manualPreviewUrl,
    logs: Array.isArray(state.logHistory) ? state.logHistory : [],
    exitCode: state.exitCode,
  };
}

function normalizeDevServerLogLine(line: BackendDevServerLogHistoryLine, fallbackId: number): DevServerLogHistoryEntry {
  return {
    id: typeof line.id === "number" && Number.isFinite(line.id) ? line.id : fallbackId,
    text: typeof line.text === "string" ? line.text : (typeof line.line === "string" ? line.line : ""),
    stream: line.stream === "stderr" ? "stderr" : "stdout",
    timestamp: typeof line.timestamp === "string" ? line.timestamp : "",
  };
}

function normalizeDevServerLogHistoryResponse(response: BackendDevServerLogHistoryResponse): DevServerLogHistoryResponse {
  const rawLines = Array.isArray(response.lines) ? response.lines : [];
  const lines = rawLines.map((line, index) => normalizeDevServerLogLine(line, index + 1));

  return {
    lines,
    totalLines: typeof response.totalLines === "number" && Number.isFinite(response.totalLines)
      ? response.totalLines
      : lines.length,
  };
}

function mapLegacyDevServerLogs(logs: string[], options: FetchDevServerLogHistoryOptions): DevServerLogHistoryResponse {
  const maxLines = typeof options.maxLines === "number" && Number.isFinite(options.maxLines)
    ? Math.max(1, Math.floor(options.maxLines))
    : 100;
  const offset = typeof options.offset === "number" && Number.isFinite(options.offset)
    ? Math.max(0, Math.floor(options.offset))
    : 0;
  const lastEventId = typeof options.lastEventId === "number" && Number.isFinite(options.lastEventId)
    ? Math.max(0, Math.floor(options.lastEventId))
    : null;

  const totalLines = logs.length;
  const fullLines = logs.map<DevServerLogHistoryEntry>((text, index) => ({
    id: index + 1,
    text,
    stream: "stdout",
    timestamp: "",
  }));

  if (lastEventId !== null) {
    return {
      lines: fullLines.filter((line) => line.id > lastEventId).slice(0, maxLines),
      totalLines,
    };
  }

  const endExclusive = Math.max(totalLines - offset, 0);
  const start = Math.max(endExclusive - maxLines, 0);

  return {
    lines: fullLines.slice(start, endExclusive),
    totalLines,
  };
}

type DevServerCandidatesResponse =
  | { candidates?: BackendDevServerCandidate[] }
  | BackendDevServerCandidate[];

function mapCandidatesResponse(response: DevServerCandidatesResponse): DevServerCandidate[] {
  if (Array.isArray(response)) {
    return response.map(mapBackendCandidateToFrontend);
  }

  return (response.candidates ?? []).map(mapBackendCandidateToFrontend);
}

export async function fetchDevServerCandidates(projectId?: string): Promise<DevServerCandidate[]> {
  try {
    const response = await api<DevServerCandidatesResponse>(withProjectId("/dev-server/candidates", projectId));
    return mapCandidatesResponse(response);
  } catch (error) {
    // Backward compatibility for workspaces that still expose /dev-server/detect.
    if (error instanceof Error && /\/dev-server\/candidates/.test(error.message)) {
      const fallback = await api<DevServerCandidatesResponse>(withProjectId("/dev-server/detect", projectId));
      return mapCandidatesResponse(fallback);
    }
    throw error;
  }
}

export function detectDevServer(projectId?: string): Promise<DevServerCandidate[]> {
  return fetchDevServerCandidates(projectId);
}

export function fetchDevServerConfig(projectId?: string): Promise<DevServerConfig> {
  return api<DevServerConfig>(withProjectId("/dev-server/config", projectId));
}

export function saveDevServerConfig(config: Partial<DevServerConfig>, projectId?: string): Promise<DevServerConfig> {
  return api<DevServerConfig>(withProjectId("/dev-server/config", projectId), {
    method: "PUT",
    body: JSON.stringify(config),
  });
}

export function fetchDevServerStatus(projectId?: string): Promise<DevServerState> {
  return api<BackendDevServerState>(withProjectId("/dev-server/status", projectId)).then(mapBackendStateToFrontend);
}

export async function fetchDevServerLogHistory(
  options: FetchDevServerLogHistoryOptions = {},
  projectId?: string,
): Promise<DevServerLogHistoryResponse> {
  const query = new URLSearchParams();
  if (typeof options.maxLines === "number" && Number.isFinite(options.maxLines)) {
    query.set("maxLines", String(Math.max(1, Math.floor(options.maxLines))));
  }
  if (typeof options.offset === "number" && Number.isFinite(options.offset)) {
    query.set("offset", String(Math.max(0, Math.floor(options.offset))));
  }
  if (typeof options.lastEventId === "number" && Number.isFinite(options.lastEventId)) {
    query.set("lastEventId", String(Math.max(0, Math.floor(options.lastEventId))));
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  try {
    const response = await api<BackendDevServerLogHistoryResponse>(
      withProjectId(`/dev-server/logs/history${suffix}`, projectId),
    );
    return normalizeDevServerLogHistoryResponse(response);
  } catch (error) {
    // Backward compatibility for workspaces without /dev-server/logs/history.
    if (error instanceof Error && /\/dev-server\/logs\/history/.test(error.message)) {
      const status = await fetchDevServerStatus(projectId);
      return mapLegacyDevServerLogs(status.logs, options);
    }
    throw error;
  }
}

export function startDevServer(body: DevServerStartInput, projectId?: string): Promise<DevServerState> {
  const cwd = body.cwd ?? body.packagePath ?? ".";
  const scriptName = body.scriptName;

  return api<BackendDevServerState>(withProjectId("/dev-server/start", projectId), {
    method: "POST",
    body: JSON.stringify({
      command: body.command,
      scriptName,
      scriptId: scriptName,
      cwd,
      packagePath: body.packagePath,
    }),
  }).then(mapBackendStateToFrontend);
}

export function stopDevServer(projectId?: string): Promise<DevServerState> {
  return api<BackendDevServerState>(withProjectId("/dev-server/stop", projectId), {
    method: "POST",
  }).then(mapBackendStateToFrontend);
}

export function restartDevServer(projectId?: string): Promise<DevServerState> {
  return api<BackendDevServerState>(withProjectId("/dev-server/restart", projectId), {
    method: "POST",
  }).then(mapBackendStateToFrontend);
}

export async function setDevServerPreviewUrl(urlOrBody: string | { url: string | null }, projectId?: string): Promise<DevServerState> {
  const body = typeof urlOrBody === "string"
    ? { url: urlOrBody }
    : urlOrBody;

  try {
    const response = await api<BackendDevServerState>(withProjectId("/dev-server/preview-url", projectId), {
      method: "POST",
      body: JSON.stringify(body),
    });
    return mapBackendStateToFrontend(response);
  } catch (error) {
    // Backward compatibility for workspaces that still use PUT.
    if (error instanceof Error && /\/dev-server\/preview-url/.test(error.message)) {
      const fallback = await api<BackendDevServerState>(withProjectId("/dev-server/preview-url", projectId), {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return mapBackendStateToFrontend(fallback);
    }
    throw error;
  }
}

export function getDevServerLogsStreamUrl(projectId?: string): string {
  return buildApiUrl(withProjectId("/dev-server/logs/stream", projectId));
}

// =============================================================================
// Session-based DevServer API (FN-2184 / FN-2185)
// Target /api/devserver/* with fallback to /api/dev-server/* for migration safety
// =============================================================================

/**
 * Canonical session-based DevServer types.
 * These align with the new session model introduced in FN-2184.
 */

// Detected dev server command (result of detectDevServerCommands)
export interface DetectedDevServerCommand {
  name: string;
  command: string;
  cwd: string;
  scriptName: string;
  packagePath: string;
  framework?: string;
}

// Dev server log entry format
export interface DevServerLogEntry {
  timestamp: string;
  stream: "stdout" | "stderr";
  text: string;
}

// Preview URL response from backend
export interface DevServerPreviewResponse {
  url: string | null;
  source: "auto" | "manual" | null;
}

// Dev server runtime info (process details)
export interface DevServerRuntime {
  pid: number;
  startedAt: string;
  exitCode?: number;
  previewUrl?: string;
}

// Dev server configuration (saved settings)
export interface DevServerSessionConfig {
  id: string;
  name: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  autoStart?: boolean;
}

// Full DevServer session combining config, status, runtime, and logs
export interface DevServerSession {
  config: DevServerSessionConfig;
  status: "stopped" | "starting" | "running" | "failed" | "stopping";
  runtime?: DevServerRuntime;
  previewUrl?: string;
  logHistory: DevServerLogEntry[];
}

// Options for fetching log history
export interface FetchDevServerLogsOptions {
  maxLines?: number;
  offset?: number;
  lastEventId?: number;
}

// Backend response shape for log history
interface BackendSessionLogResponse {
  lines?: DevServerLogEntry[];
  totalLines?: number;
}

// Backend response for preview endpoint
interface BackendPreviewResponse {
  url?: string | null;
  source?: string | null;
}

// Backend response for list sessions
interface BackendSessionsListResponse {
  sessions?: DevServerSession[];
}

// Backend response for detect commands
interface BackendDetectCommandsResponse {
  candidates?: DetectedDevServerCommand[];
}

/**
 * Fetch all dev server sessions.
 * Targets /api/devserver with fallback to /api/dev-server (legacy compatibility).
 */
export async function fetchDevServers(projectId?: string): Promise<DevServerSession[]> {
  try {
    const response = await api<BackendSessionsListResponse>(withProjectId("/devserver", projectId));
    return response.sessions ?? [];
  } catch {
    // Fallback: try to get the legacy single-server state and wrap it in session format
    try {
      const legacy = await fetchDevServerStatus(projectId);
      // Convert legacy state to session format
      const session: DevServerSession = {
        config: {
          id: legacy.id ?? "default",
          name: legacy.name ?? "Dev Server",
          command: legacy.command ?? "",
          cwd: legacy.cwd ?? ".",
        },
        status: legacy.status,
        runtime: legacy.pid
          ? {
            pid: legacy.pid,
            startedAt: legacy.startedAt ?? new Date().toISOString(),
            exitCode: legacy.exitCode ?? undefined,
            previewUrl: legacy.previewUrl,
          }
          : undefined,
        previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? undefined,
        logHistory: (legacy.logs ?? []).map<DevServerLogEntry>((text) => ({
          timestamp: new Date().toISOString(),
          stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
          text: text.replace(/^\[stderr\]\s*/, ""),
        })),
      };
      return [session];
    } catch {
      return [];
    }
  }
}

/**
 * Create a new dev server session.
 * Targets /api/devserver with fallback to /api/dev-server/start (legacy compatibility).
 */
export async function createDevServer(
  data: { command: string; cwd?: string; name?: string; env?: Record<string, string> },
  projectId?: string,
): Promise<DevServerSession> {
  const body = {
    command: data.command,
    cwd: data.cwd ?? ".",
    name: data.name,
    env: data.env,
  };

  try {
    return await api<DevServerSession>(withProjectId("/devserver", projectId), {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch {
    // Fallback: use legacy start endpoint
    const legacy = await startDevServer({ command: data.command, cwd: data.cwd }, projectId);
    return {
      config: {
        id: legacy.id ?? "default",
        name: legacy.name ?? data.name ?? "Dev Server",
        command: legacy.command,
        cwd: legacy.cwd ?? data.cwd ?? ".",
      },
      status: legacy.status,
      runtime: legacy.pid
        ? {
          pid: legacy.pid,
          startedAt: legacy.startedAt ?? new Date().toISOString(),
          exitCode: legacy.exitCode ?? undefined,
          previewUrl: legacy.previewUrl,
        }
        : undefined,
      previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? undefined,
      logHistory: (legacy.logs ?? []).map<DevServerLogEntry>((text) => ({
        timestamp: new Date().toISOString(),
        stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
        text: text.replace(/^\[stderr\]\s*/, ""),
      })),
    };
  }
}

/**
 * Fetch a specific dev server session by ID.
 * Targets /api/devserver/:id with fallback to /api/dev-server/status (legacy compatibility).
 */
export async function fetchDevServer(id: string, projectId?: string): Promise<DevServerSession | null> {
  try {
    return await api<DevServerSession>(withProjectId(`/devserver/${encodeURIComponent(id)}`, projectId));
  } catch {
    // Fallback: try legacy status endpoint (single-server model)
    try {
      const legacy = await fetchDevServerStatus(projectId);
      // If no ID or ID matches default, return legacy state as session
      if (!id || id === "default" || id === legacy.id) {
        return {
          config: {
            id: legacy.id ?? "default",
            name: legacy.name ?? "Dev Server",
            command: legacy.command ?? "",
            cwd: legacy.cwd ?? ".",
          },
          status: legacy.status,
          runtime: legacy.pid
            ? {
              pid: legacy.pid,
              startedAt: legacy.startedAt ?? new Date().toISOString(),
              exitCode: legacy.exitCode ?? undefined,
              previewUrl: legacy.previewUrl,
            }
            : undefined,
          previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? undefined,
          logHistory: (legacy.logs ?? []).map<DevServerLogEntry>((text) => ({
            timestamp: new Date().toISOString(),
            stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
            text: text.replace(/^\[stderr\]\s*/, ""),
          })),
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Start a specific dev server by ID.
 * Targets /api/devserver/:id/start with fallback to /api/dev-server/start (legacy compatibility).
 */
export async function startDevServerById(id: string, projectId?: string): Promise<DevServerSession> {
  try {
    return await api<DevServerSession>(withProjectId(`/devserver/${encodeURIComponent(id)}/start`, projectId), {
      method: "POST",
    });
  } catch {
    // Fallback: use legacy start endpoint (single-server model)
    const legacy = await startDevServer({ command: "" }, projectId);
    return {
      config: {
        id: legacy.id ?? id,
        name: legacy.name ?? "Dev Server",
        command: legacy.command ?? "",
        cwd: legacy.cwd ?? ".",
      },
      status: legacy.status,
      runtime: legacy.pid
        ? {
          pid: legacy.pid,
          startedAt: legacy.startedAt ?? new Date().toISOString(),
          exitCode: legacy.exitCode ?? undefined,
          previewUrl: legacy.previewUrl,
        }
        : undefined,
      previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? undefined,
      logHistory: (legacy.logs ?? []).map<DevServerLogEntry>((text) => ({
        timestamp: new Date().toISOString(),
        stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
        text: text.replace(/^\[stderr\]\s*/, ""),
      })),
    };
  }
}

/**
 * Stop a specific dev server by ID.
 * Targets /api/devserver/:id/stop with fallback to /api/dev-server/stop (legacy compatibility).
 */
export async function stopDevServerById(id: string, projectId?: string): Promise<DevServerSession> {
  try {
    return await api<DevServerSession>(withProjectId(`/devserver/${encodeURIComponent(id)}/stop`, projectId), {
      method: "POST",
    });
  } catch {
    // Fallback: use legacy stop endpoint
    const legacy = await stopDevServer(projectId);
    return {
      config: {
        id: legacy.id ?? id,
        name: legacy.name ?? "Dev Server",
        command: legacy.command ?? "",
        cwd: legacy.cwd ?? ".",
      },
      status: legacy.status,
      runtime: legacy.pid
        ? {
          pid: legacy.pid,
          startedAt: legacy.startedAt ?? new Date().toISOString(),
          exitCode: legacy.exitCode ?? undefined,
          previewUrl: legacy.previewUrl,
        }
        : undefined,
      previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? undefined,
      logHistory: (legacy.logs ?? []).map<DevServerLogEntry>((text) => ({
        timestamp: new Date().toISOString(),
        stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
        text: text.replace(/^\[stderr\]\s*/, ""),
      })),
    };
  }
}

/**
 * Restart a specific dev server by ID.
 * Targets /api/devserver/:id/restart with fallback to /api/dev-server/restart (legacy compatibility).
 */
export async function restartDevServerById(id: string, projectId?: string): Promise<DevServerSession> {
  try {
    return await api<DevServerSession>(withProjectId(`/devserver/${encodeURIComponent(id)}/restart`, projectId), {
      method: "POST",
    });
  } catch {
    // Fallback: use legacy restart endpoint
    const legacy = await restartDevServer(projectId);
    return {
      config: {
        id: legacy.id ?? id,
        name: legacy.name ?? "Dev Server",
        command: legacy.command ?? "",
        cwd: legacy.cwd ?? ".",
      },
      status: legacy.status,
      runtime: legacy.pid
        ? {
          pid: legacy.pid,
          startedAt: legacy.startedAt ?? new Date().toISOString(),
          exitCode: legacy.exitCode ?? undefined,
          previewUrl: legacy.previewUrl,
        }
        : undefined,
      previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? undefined,
      logHistory: (legacy.logs ?? []).map<DevServerLogEntry>((text) => ({
        timestamp: new Date().toISOString(),
        stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
        text: text.replace(/^\[stderr\]\s*/, ""),
      })),
    };
  }
}

/**
 * Delete a specific dev server by ID.
 * Targets /api/devserver/:id with fallback (no legacy equivalent).
 */
export async function deleteDevServer(id: string, projectId?: string): Promise<void> {
  try {
    await api<void>(withProjectId(`/devserver/${encodeURIComponent(id)}`, projectId), {
      method: "DELETE",
    });
  } catch {
    // No fallback for delete in legacy API (single-server model)
    // Silently ignore - deletion may not be supported in legacy mode
  }
}

/**
 * Fetch logs for a specific dev server by ID.
 * Targets /api/devserver/:id/logs with fallback to /api/dev-server/logs/history (legacy compatibility).
 */
export async function fetchDevServerLogs(
  id: string,
  opts: FetchDevServerLogsOptions = {},
  projectId?: string,
): Promise<{ lines: DevServerLogEntry[]; totalLines: number }> {
  const query = new URLSearchParams();
  if (typeof opts.maxLines === "number" && Number.isFinite(opts.maxLines)) {
    query.set("maxLines", String(Math.max(1, Math.floor(opts.maxLines))));
  }
  if (typeof opts.offset === "number" && Number.isFinite(opts.offset)) {
    query.set("offset", String(Math.max(0, Math.floor(opts.offset))));
  }
  if (typeof opts.lastEventId === "number" && Number.isFinite(opts.lastEventId)) {
    query.set("lastEventId", String(Math.max(0, Math.floor(opts.lastEventId))));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  try {
    const response = await api<BackendSessionLogResponse>(
      withProjectId(`/devserver/${encodeURIComponent(id)}/logs${suffix}`, projectId),
    );
    return {
      lines: response.lines ?? [],
      totalLines: response.totalLines ?? response.lines?.length ?? 0,
    };
  } catch {
    // Fallback: use legacy log history endpoint
    try {
      const response = await fetchDevServerLogHistory(opts, projectId);
      return {
        lines: response.lines.map<DevServerLogEntry>((entry) => ({
          timestamp: entry.timestamp,
          stream: entry.stream,
          text: entry.text,
        })),
        totalLines: response.totalLines,
      };
    } catch {
      return { lines: [], totalLines: 0 };
    }
  }
}

/**
 * Fetch preview URL for a specific dev server by ID.
 * Targets /api/devserver/:id/preview with fallback to /api/dev-server/status (legacy compatibility).
 */
export async function fetchDevServerPreview(id: string, projectId?: string): Promise<DevServerPreviewResponse> {
  try {
    const response = await api<BackendPreviewResponse>(
      withProjectId(`/devserver/${encodeURIComponent(id)}/preview`, projectId),
    );
    return {
      url: response.url ?? null,
      source: (response.source as DevServerPreviewResponse["source"]) ?? null,
    };
  } catch {
    // Fallback: use legacy status endpoint
    try {
      const legacy = await fetchDevServerStatus(projectId);
      return {
        url: legacy.previewUrl ?? legacy.detectedUrl ?? legacy.manualUrl ?? null,
        source: legacy.manualUrl ? "manual" : "auto",
      };
    } catch {
      return { url: null, source: null };
    }
  }
}

/**
 * Set preview URL for a specific dev server by ID.
 * Targets /api/devserver/:id/preview with fallback to /api/dev-server/preview-url (legacy compatibility).
 */
export async function setDevServerPreviewUrlById(
  id: string,
  url: string | null,
  projectId?: string,
): Promise<DevServerPreviewResponse> {
  try {
    const response = await api<BackendPreviewResponse>(
      withProjectId(`/devserver/${encodeURIComponent(id)}/preview`, projectId),
      {
        method: "POST",
        body: JSON.stringify({ url }),
      },
    );
    return {
      url: response.url ?? null,
      source: (response.source as DevServerPreviewResponse["source"]) ?? null,
    };
  } catch {
    // Fallback: use legacy preview URL endpoint
    const legacy = await setDevServerPreviewUrl({ url }, projectId);
    return {
      url: legacy.previewUrl ?? legacy.manualUrl ?? null,
      source: "manual",
    };
  }
}

/**
 * Detect available dev server commands.
 * Targets /api/devserver/detect with fallback to /api/dev-server/detect (legacy compatibility).
 */
export async function detectDevServerCommands(projectId?: string): Promise<DetectedDevServerCommand[]> {
  try {
    const response = await api<BackendDetectCommandsResponse>(withProjectId("/devserver/detect", projectId));
    return response.candidates ?? [];
  } catch {
    // Fallback: use legacy detect endpoint
    try {
      const legacy = await fetchDevServerCandidates(projectId);
      return legacy.map<DetectedDevServerCommand>((candidate) => ({
        name: candidate.name,
        command: candidate.command,
        cwd: candidate.cwd,
        scriptName: candidate.scriptName,
        packagePath: candidate.packagePath,
      }));
    } catch {
      return [];
    }
  }
}

/**
 * Get the SSE stream URL for a specific dev server session's logs.
 * Targets /api/devserver/:id/logs/stream with fallback to /api/dev-server/logs/stream (legacy compatibility).
 */
export function getDevServerSessionLogsStreamUrl(id: string, projectId?: string): string {
  // Try new session-scoped endpoint first
  return buildApiUrl(withProjectId(`/devserver/${encodeURIComponent(id)}/logs/stream`, projectId));
}


/** Get the SSE stream URL for a planning session */
