/**
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Agent import catalog and generation client API peeled from legacy.ts.
 */

import type { GlobalSettings, ProjectSettings } from "@fusion/core";
import { api } from "./client.js";
import { withProjectId } from "./health.js";

// ── Agent Import API ────────────────────────────────────────────────────────

/** Company entry from companies.sh catalog */
export interface CompanyEntry {
  slug: string;
  name: string;
  tagline?: string;
  repo?: string;
  website?: string;
  installs?: number;
}

/** Response from companies.sh catalog API */
export interface CompaniesCatalogResponse {
  companies: CompanyEntry[];
  error?: string;
}

/** Result of importing agents from an Agent Companies source */
export interface AgentImportResult {
  companyName?: string;
  companySlug?: string;
  agents?: Array<{ name: string; role: string; title?: string; skills?: string[] }>;
  /** In dry-run mode: agent name strings. In live mode: agent objects with id and name. */
  created: string[] | Array<{ id: string; name: string }>;
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
  dryRun?: boolean;
}

/**
 * Fetch companies from companies.sh catalog.
 * Returns both companies and optional error message for proper error surfacing.
 */
export function fetchCompanies(): Promise<CompaniesCatalogResponse> {
  return api<CompaniesCatalogResponse>("/agents/companies");
}

/**
 * Import agents from an Agent Companies source via the API.
 * Uses dryRun for preview, then actual import.
 *
 * Supports four input modes:
 * - { manifest: string } - raw AGENTS.md content
 * - { source: string } - server directory path
 * - { agents: unknown[] } - parsed agent manifests
 * - { importSource: "companies.sh", companySlug: string } - companies.sh catalog entry
 */
export function importAgents(
  input:
    | { manifest: string }
    | { source: string }
    | { agents: unknown[] }
    | { importSource: "companies.sh"; companySlug: string },
  options?: { dryRun?: boolean; skipExisting?: boolean },
  projectId?: string,
): Promise<AgentImportResult> {
  return api<AgentImportResult>(withProjectId("/agents/import", projectId), {
    method: "POST",
    body: JSON.stringify({
      ...input,
      dryRun: options?.dryRun ?? false,
      skipExisting: options?.skipExisting ?? true,
    }),
  });
}

// ── Agent Generation API ────────────────────────────────────────────────────

/** Generated agent specification returned by the AI */
export interface AgentGenerationSpec {
  /** Display name for the agent */
  title: string;
  /** Single emoji icon */
  icon: string;
  /** Agent capability/role */
  role: string;
  /** Brief description of the agent's purpose */
  description: string;
  /** Detailed system prompt in markdown */
  systemPrompt: string;
  /** Suggested thinking level */
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Suggested max turns (1-500) */
  maxTurns: number;
}

/** State of an agent generation session */
export interface AgentGenerationSession {
  id: string;
  roleDescription: string;
  spec?: AgentGenerationSpec;
  createdAt: string;
  updatedAt: string;
}

/** Start an agent generation session with a role description */
export function startAgentGeneration(role: string, projectId?: string): Promise<{ sessionId: string; roleDescription: string }> {
  return api<{ sessionId: string; roleDescription: string }>(withProjectId("/agents/generate/start", projectId), {
    method: "POST",
    body: JSON.stringify({ role }),
  });
}

/** Generate the agent specification for an existing session */
export function generateAgentSpec(sessionId: string, projectId?: string): Promise<{ spec: AgentGenerationSpec }> {
  return api<{ spec: AgentGenerationSpec }>(withProjectId("/agents/generate/spec", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

/** Get the current state of an agent generation session */
export function getAgentGenerationSession(sessionId: string, projectId?: string): Promise<{ session: AgentGenerationSession }> {
  return api<{ session: AgentGenerationSession }>(withProjectId(`/agents/generate/${encodeURIComponent(sessionId)}`, projectId));
}

/** Cancel and clean up an agent generation session */
export function cancelAgentGeneration(sessionId: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/agents/generate/${encodeURIComponent(sessionId)}`, projectId), {
    method: "DELETE",
  });
}

// --- Backup API ---

/** Backup metadata from the API */
export interface BackupInfo {
  filename: string;
  createdAt: string;
  size: number;
  path: string;
}

/** Result of listing backups */
export interface BackupListResponse {
  backups: BackupInfo[];
  count: number;
  totalSize: number;
}

/** Result of creating a backup */
export interface BackupCreateResponse {
  success: boolean;
  backupPath?: string;
  output?: string;
  deletedCount?: number;
  error?: string;
}

/** Fetch all database backups */
export function fetchBackups(projectId?: string): Promise<BackupListResponse> {
  return api<BackupListResponse>(withProjectId("/backups", projectId));
}

/** Create a new database backup immediately */
export function createBackup(projectId?: string): Promise<BackupCreateResponse> {
  return api<BackupCreateResponse>(withProjectId("/backups", projectId), { method: "POST" });
}

// --- Settings Export/Import API ---

/** Exported settings data structure */
export interface SettingsExportData {
  version: 1;
  exportedAt: string;
  source?: string;
  global?: GlobalSettings;
  project?: Partial<ProjectSettings>;
}

/** Result of importing settings */
export interface SettingsImportResponse {
  success: boolean;
  globalCount: number;
  projectCount: number;
  workflowSettingsCount: number;
  error?: string;
}

/** Export settings as JSON */
export function exportSettings(scope?: 'global' | 'project' | 'both', projectId?: string): Promise<SettingsExportData> {
  const path = withProjectId("/settings/export", projectId);
  const scopedPath = scope ? `${path}${path.includes("?") ? "&" : "?"}scope=${encodeURIComponent(scope)}` : path;
  return api<SettingsExportData>(scopedPath);
}

/** Import settings from JSON data */
export function importSettings(
  data: SettingsExportData,
  options?: { scope?: 'global' | 'project' | 'both'; merge?: boolean },
  projectId?: string
): Promise<SettingsImportResponse> {
  return api<SettingsImportResponse>(withProjectId("/settings/import", projectId), {
    method: "POST",
    body: JSON.stringify({
      data,
      scope: options?.scope ?? "both",
      merge: options?.merge ?? true,
    }),
  });
}

