/**
 * FNXC:CodeOrganization 2026-07-15-16:00:
 * Dashboard health/engine/update client API peeled from legacy.ts.
 */
import type { TaskIdIntegrityReport } from "@fusion/core";
import { api } from "./client.js";

export function withProjectId(path: string, projectId?: string): string {
  if (!projectId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}projectId=${encodeURIComponent(projectId)}`;
}


export interface UpdateCheckResponse {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  lastChecked?: number;
  disabled?: boolean;
  error?: string;
}


export interface DashboardHealthResponse {
  status: string;
  version: string;
  uptime: number;
  /*
  FNXC:MigrationHoldingPage 2026-07-17-12:35:
  While the CLI's boot-window holding server owns the dashboard port (real
  server not yet listening), /api/health answers with status "migrating" (or
  "starting") and this progress snapshot — and OMITS engine/database/
  taskIdIntegrity. Consumers of those fields must optional-chain (the
  DashboardBanners gates already do) so boot-window polls don't fire the
  engine/db-corruption banners. After real listen, durable incomplete migration
  status is attached so the cutover banner remains visible while degraded.
  */
  holding?: boolean;
  migration?: {
    active: boolean;
    phase?: string;
    label?: string;
    table?: string;
    tableIndex?: number;
    tableCount?: number;
    processedRows?: number;
    sourceRows?: number;
    durableStatus?: "running" | "failed";
    lastError?: string | null;
    migrationKey?: string;
    updatedAt?: string;
  };
  engine?: {
    available: boolean;
  };
  database: {
    healthy: boolean;
    corruptionDetected: boolean;
    corruptionErrors: string[];
    lastCheckedAt: string | null;
    isRunning: boolean;
  };
  /*
  FNXC:PostgresHealth 2026-07-14-23:45:
  Health cannot label an unavailable PostgreSQL integrity detector as "ok". Preserve the existing report fields while exposing a distinct error state and diagnostic for the dashboard response contract.
  */
  taskIdIntegrity:
    | (TaskIdIntegrityReport & { recommendedAction: string | null })
    | {
        status: "error";
        checkedAt: string;
        anomalies: [];
        error: string;
        recommendedAction: string | null;
      };
}

export function fetchDashboardHealth(): Promise<DashboardHealthResponse> {
  return api<DashboardHealthResponse>("/health");
}

export function refreshDashboardHealth(): Promise<DashboardHealthResponse> {
  return api<DashboardHealthResponse>("/health/refresh", { method: "POST" });
}

export interface EngineStatusResponse {
  connected: boolean;
  starting: boolean;
  canStart: boolean;
  reason?: "dashboard-only" | "no-project" | string;
  projectId?: string;
}

/*
 * FNXC:EngineStatusBanner 2026-06-22-00:00:
 * Engine status is project-scoped because a multi-project dashboard can have one running engine while the current project is paused, failed, or not yet started. Thread `projectId` through the existing query helper so the server resolves the same project context as task and settings routes.
 */
export function fetchEngineStatus(projectId?: string): Promise<EngineStatusResponse> {
  return api<EngineStatusResponse>(withProjectId("/engine/status", projectId));
}

export function startEngine(projectId?: string): Promise<EngineStatusResponse> {
  return api<EngineStatusResponse>(withProjectId("/engine/start", projectId), { method: "POST" });
}

/*
 * FNXC:UpdateChannels 2026-07-21-20:33:
 * Settings footer "Check for updates" used to call GET /updates/check, which
 * always resolved npm dist-tag `latest` and ignored GlobalSettings.updateChannel.
 * Force-refresh through the channel-aware /update-check/refresh route so beta
 * users discover X.Y.Z-beta.N targets (and so a deliberate click always
 * re-queries the registry instead of serving a stale TTL cache).
 */
export function checkForUpdates(): Promise<UpdateCheckResponse> {
  return api<UpdateCheckResponse>("/update-check/refresh", { method: "POST" });
}


