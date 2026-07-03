import type { GlobalSettings, ProjectSettings } from "./types.js";

export const DEFAULT_GITLAB_INSTANCE_URL = "https://gitlab.com";
export const DEFAULT_GITLAB_API_BASE_URL = "https://gitlab.com/api/v4";

export interface GitlabConfigSettingsSource {
  gitlabEnabled?: boolean;
  gitlabInstanceUrl?: string;
  gitlabApiBaseUrl?: string;
}

export interface ResolveGitlabConfigInput {
  project?: GitlabConfigSettingsSource | ProjectSettings | null;
  global?: GitlabConfigSettingsSource | GlobalSettings | null;
}

export interface ResolvedGitlabConfig {
  enabled: boolean;
  instanceUrl: string;
  apiBaseUrl: string;
}

export function resolveGitlabEnabled(input: ResolveGitlabConfigInput = {}): boolean {
  /*
  FNXC:GitLabEnablement 2026-07-02-00:00:
  FN-7453 separates saved GitLab URL/token configuration from whether GitLab integrations are active. Undefined remains effectively enabled for backward compatibility; explicit project false overrides global true/undefined and short-circuits runtime network paths before URL or token validation.
  */
  if (typeof input.project?.gitlabEnabled === "boolean") return input.project.gitlabEnabled;
  if (typeof input.global?.gitlabEnabled === "boolean") return input.global.gitlabEnabled;
  return true;
}

function readConfiguredString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeHttpUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute http(s) URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http:// or https://`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not include username or password userinfo`);
  }
  if (!parsed.hostname) {
    throw new Error(`${label} must include a hostname`);
  }

  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  const normalized = parsed.toString().replace(/\/$/u, "");
  return normalized;
}

function deriveApiBaseUrl(instanceUrl: string): string {
  const parsed = new URL(instanceUrl);
  const basePath = parsed.pathname.replace(/\/+$/u, "");
  parsed.pathname = `${basePath}/api/v4`.replace(/\/+/gu, "/");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

/**
 * FNXC:GitLabConfiguration 2026-07-02-00:00:
 * FN-7422 only establishes typed GitLab.com and self-managed URL configuration for later GitLab auth/import/tracking subtasks. Normalize and validate here before any future network client consumes these settings, preserving self-managed path prefixes while rejecting non-http(s) URLs and userinfo-bearing URLs.
 */
export function resolveGitlabConfig(input: ResolveGitlabConfigInput = {}): ResolvedGitlabConfig {
  const enabled = resolveGitlabEnabled(input);
  const projectInstanceUrl = readConfiguredString(input.project?.gitlabInstanceUrl);
  const globalInstanceUrl = readConfiguredString(input.global?.gitlabInstanceUrl);
  const projectApiBaseUrl = readConfiguredString(input.project?.gitlabApiBaseUrl);
  const globalApiBaseUrl = readConfiguredString(input.global?.gitlabApiBaseUrl);

  const instanceUrl = normalizeHttpUrl(projectInstanceUrl ?? globalInstanceUrl ?? DEFAULT_GITLAB_INSTANCE_URL, "GitLab instance URL");
  const apiBaseUrl = projectApiBaseUrl ?? globalApiBaseUrl
    ? normalizeHttpUrl(projectApiBaseUrl ?? globalApiBaseUrl ?? "", "GitLab API base URL")
    : instanceUrl === DEFAULT_GITLAB_INSTANCE_URL
      ? DEFAULT_GITLAB_API_BASE_URL
      : deriveApiBaseUrl(instanceUrl);

  return { enabled, instanceUrl, apiBaseUrl };
}
