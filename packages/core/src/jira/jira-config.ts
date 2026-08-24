import type { GlobalSettings, ProjectSettings } from "../types.js";

export const DEFAULT_JIRA_TOKEN_SECRET_KEY = "JIRA_API_TOKEN";
export const DEFAULT_JIRA_BRANCH_NAME_TEMPLATE = "feature/{key}-{summary}";
export type JiraTokenSecretScope = "project" | "global";

export interface JiraConfigSettingsSource {
  jiraEnabled?: boolean;
  jiraBaseUrl?: string;
  jiraApiBaseUrl?: string;
  jiraAuthEmail?: string;
  jiraAuthTokenSecretKey?: string;
  jiraAuthTokenSecretScope?: JiraTokenSecretScope;
  jiraBranchNameTemplate?: string;
}
export interface ResolveJiraConfigInput { project?: JiraConfigSettingsSource | ProjectSettings | null; global?: JiraConfigSettingsSource | GlobalSettings | null; }
export interface ResolvedJiraConfig { enabled: boolean; baseUrl: string; apiBaseUrl: string; authEmail?: string; tokenSecretKey: string; tokenSecretScope: JiraTokenSecretScope; branchNameTemplate: string; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function pick(input: ResolveJiraConfigInput, key: keyof JiraConfigSettingsSource): unknown { return input.project?.[key] ?? input.global?.[key]; }
function normalizeHttpUrl(value: string, label: string): string { let url: URL; try { url = new URL(value); } catch { throw new Error(`${label} must be a valid absolute http(s) URL`); } if (!/^https?:$/u.test(url.protocol)) throw new Error(`${label} must use http:// or https://`); if (url.username || url.password) throw new Error(`${label} must not include username or password userinfo`); if (!url.hostname) throw new Error(`${label} must include a hostname`); url.hash = ""; url.search = ""; url.pathname = url.pathname.replace(/\/+$/u, "") || "/"; return url.toString().replace(/\/$/u, ""); }
export function resolveJiraEnabled(input: ResolveJiraConfigInput = {}): boolean { return typeof input.project?.jiraEnabled === "boolean" ? input.project.jiraEnabled : typeof input.global?.jiraEnabled === "boolean" ? input.global.jiraEnabled : false; }
/**
 * FNXC:JiraBranchNaming 2026-08-20-04:47:
 * FN-9165 keeps JIRA opt-in off and resolves dual-scope keys by active settings scope. Tokens are secret-store references, never plaintext settings values.
 */
export function resolveJiraConfig(input: ResolveJiraConfigInput = {}): ResolvedJiraConfig {
  const baseUrlValue = string(pick(input, "jiraBaseUrl"));
  if (!baseUrlValue) throw new Error("JIRA base URL is required when JIRA is enabled.");
  const baseUrl = normalizeHttpUrl(baseUrlValue, "JIRA base URL");
  const apiValue = string(pick(input, "jiraApiBaseUrl"));
  const apiBaseUrl = apiValue ? normalizeHttpUrl(apiValue, "JIRA API base URL") : `${baseUrl}/rest/api/3`;
  const scope = pick(input, "jiraAuthTokenSecretScope");
  return { enabled: resolveJiraEnabled(input), baseUrl, apiBaseUrl, authEmail: string(pick(input, "jiraAuthEmail")), tokenSecretKey: string(pick(input, "jiraAuthTokenSecretKey")) ?? DEFAULT_JIRA_TOKEN_SECRET_KEY, tokenSecretScope: scope === "global" ? "global" : "project", branchNameTemplate: string(pick(input, "jiraBranchNameTemplate")) ?? DEFAULT_JIRA_BRANCH_NAME_TEMPLATE };
}
