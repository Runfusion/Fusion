import { resolveGitlabConfig, resolveGitlabEnabled, type GlobalSettings, type ProjectSettings } from "@fusion/core";
import type { GitlabAuthTokenType } from "@fusion/core";

export const GITLAB_AUTH_HEADER_NAME = "PRIVATE-TOKEN" as const;
export const GITLAB_AUTH_TOKEN_TYPES = ["personal", "project", "group"] as const satisfies readonly GitlabAuthTokenType[];

export interface GitlabAuthSettingsSource {
  gitlabEnabled?: boolean;
  gitlabInstanceUrl?: string;
  gitlabApiBaseUrl?: string;
  gitlabAuthToken?: string;
  gitlabAuthTokenType?: GitlabAuthTokenType | string;
}

export interface ResolvedGitlabAuth {
  apiBaseUrl: string;
  webBaseUrl: string;
  token: string;
  tokenType: GitlabAuthTokenType;
  headerName: typeof GITLAB_AUTH_HEADER_NAME;
}

export type GitlabAuthResolution =
  | { ok: true; auth: ResolvedGitlabAuth }
  | {
    ok: false;
    reason: "disabled" | "token_missing" | "invalid_token_type" | "invalid_config";
    message: string;
  };

export interface ResolveGitlabAuthDeps {
  projectSettings?: GitlabAuthSettingsSource | Pick<ProjectSettings, "gitlabEnabled" | "gitlabInstanceUrl" | "gitlabApiBaseUrl" | "gitlabAuthToken" | "gitlabAuthTokenType"> | null;
  globalSettings?: GitlabAuthSettingsSource | Partial<GlobalSettings> | Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
}

function pickString(source: Record<string, unknown> | undefined | null, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" ? value : undefined;
}

function readConfiguredString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTokenType(value: unknown): GitlabAuthTokenType | undefined | "invalid" {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return (GITLAB_AUTH_TOKEN_TYPES as readonly string[]).includes(trimmed) ? trimmed as GitlabAuthTokenType : "invalid";
}

function firstConfiguredTokenType(...values: unknown[]): GitlabAuthTokenType | undefined | "invalid" {
  for (const value of values) {
    const normalized = normalizeTokenType(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

/**
 * FNXC:GitLabAuthentication 2026-07-02-00:00:
 * FN-7423 resolves personal, project, and group GitLab access tokens for future HTTP API integrations without invoking `glab` or any GitLab CLI. GitLab REST auth uses the PRIVATE-TOKEN header; read-only features require read_api or api, while future write/comment/close features require api and token resource membership.
 */
export function resolveGitlabAuth(deps: ResolveGitlabAuthDeps = {}): GitlabAuthResolution {
  if (!resolveGitlabEnabled({ project: deps.projectSettings ?? undefined, global: deps.globalSettings as Partial<GlobalSettings> | undefined })) {
    return { ok: false, reason: "disabled", message: "GitLab integration is disabled in Settings." };
  }

  let config: ReturnType<typeof resolveGitlabConfig>;
  try {
    config = resolveGitlabConfig({
      project: deps.projectSettings ?? undefined,
      global: deps.globalSettings as Partial<GlobalSettings> | undefined,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_config",
      message: error instanceof Error ? error.message : "Invalid GitLab configuration.",
    };
  }

  const project = deps.projectSettings as Record<string, unknown> | null | undefined;
  const global = deps.globalSettings as Record<string, unknown> | null | undefined;
  const env = deps.env ?? process.env;
  const token = readConfiguredString(project?.gitlabAuthToken)
    ?? readConfiguredString(global?.gitlabAuthToken)
    ?? readConfiguredString(pickString(global, "projectGitlabAuthToken"))
    ?? readConfiguredString(env.GITLAB_TOKEN)
    ?? "";

  const tokenType = firstConfiguredTokenType(
    project?.gitlabAuthTokenType,
    global?.gitlabAuthTokenType,
    pickString(global, "projectGitlabAuthTokenType"),
  );

  if (tokenType === "invalid") {
    return {
      ok: false,
      reason: "invalid_token_type",
      message: "Invalid gitlabAuthTokenType. Expected \"personal\", \"project\", or \"group\".",
    };
  }

  if (!token) {
    return {
      ok: false,
      reason: "token_missing",
      message: "GitLab auth requires gitlabAuthToken or GITLAB_TOKEN.",
    };
  }

  return {
    ok: true,
    auth: {
      apiBaseUrl: config.apiBaseUrl,
      webBaseUrl: config.instanceUrl,
      token,
      tokenType: tokenType ?? "personal",
      headerName: GITLAB_AUTH_HEADER_NAME,
    },
  };
}
