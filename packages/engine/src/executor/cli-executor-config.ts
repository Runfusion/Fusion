/**
 * FNXC:CodeOrganization 2026-08-03-13:35:
 * Pure CLI executor config resolver peeled from TaskExecutor (U4).
 */
import type { ResolvedCliExecutorConfig } from "../cli-agent/task-session.js";

/**
 * Resolve cli-agent node config into a snapshotted ResolvedCliExecutorConfig.
 * Returns null when cliAdapterId is missing/blank.
 */
export function resolveCliExecutorConfig(cfg: Record<string, unknown>): ResolvedCliExecutorConfig | null {
  const cliAdapterId = typeof cfg.cliAdapterId === "string" && cfg.cliAdapterId.trim()
    ? cfg.cliAdapterId.trim()
    : undefined;
  if (!cliAdapterId) return null;
  const cliAutonomy = cfg.cliAutonomy && typeof cfg.cliAutonomy === "object"
    ? (cfg.cliAutonomy as ResolvedCliExecutorConfig["cliAutonomy"])
    : null;
  const cliNotify = cfg.cliNotify && typeof cfg.cliNotify === "object"
    ? (cfg.cliNotify as Record<string, unknown>)
    : null;
  const settings = cfg.cliSettings && typeof cfg.cliSettings === "object"
    ? (cfg.cliSettings as Record<string, unknown>)
    : undefined;
  return { cliAdapterId, cliAutonomy, cliNotify, settings };
}
