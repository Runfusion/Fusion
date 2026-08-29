import { isGhAuthenticated, isGhAvailable, type GlobalSettings, type ProjectSettings } from "@fusion/core";

// FN-3868 field names are authoritative; if ProjectSettings.githubAuthMode / githubAuthToken were renamed during FN-3868 review, update the imports/types here to match.

export type GithubTrackingAuth =
  | { mode: "token"; token: string }
  | { mode: "gh-cli" };

export type GithubTrackingAuthResolution =
  | { ok: true; auth: GithubTrackingAuth }
  | {
    ok: false;
    requestedMode: "token" | "gh-cli";
    reason: "token_missing" | "gh_not_installed" | "gh_not_authenticated" | "invalid_mode";
    message: string;
  };

export interface ResolveGithubTrackingAuthDeps {
  projectSettings: Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
  globalSettings?: Partial<GlobalSettings> | Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}

function pickString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" ? value : undefined;
}

export function resolveGithubTrackingAuth(
  deps: ResolveGithubTrackingAuthDeps,
): GithubTrackingAuthResolution {
  const global = (deps.globalSettings ?? {}) as Record<string, unknown>;
  const requestedMode = deps.projectSettings.githubAuthMode
    ?? pickString(global, "githubAuthMode")
    ?? pickString(global, "projectGithubAuthMode")
    ?? "gh-cli";
  const env = deps.env ?? process.env;

  if (requestedMode === "token") {
    const token = deps.projectSettings.githubAuthToken?.trim()
      || pickString(global, "githubAuthToken")?.trim()
      || pickString(global, "projectGithubAuthToken")?.trim()
      || env.GITHUB_TOKEN?.trim()
      || "";
    if (!token) {
      return {
        ok: false,
        requestedMode: "token",
        reason: "token_missing",
        message: "GitHub tracking auth mode is token, but githubAuthToken and GITHUB_TOKEN are both empty.",
      };
    }
    return { ok: true, auth: { mode: "token", token } };
  }

  if (requestedMode === "gh-cli") {
    if (!isGhAvailable()) {
      return {
        ok: false,
        requestedMode: "gh-cli",
        reason: "gh_not_installed",
        message: "GitHub tracking auth mode is gh-cli, but the gh CLI is not installed or not on PATH.",
      };
    }

    if (!isGhAuthenticated()) {
      return {
        ok: false,
        requestedMode: "gh-cli",
        reason: "gh_not_authenticated",
        message: "GitHub tracking auth mode is gh-cli, but gh is not authenticated. Run `gh auth login`.",
      };
    }

    return { ok: true, auth: { mode: "gh-cli" } };
  }

  return {
    ok: false,
    requestedMode: "gh-cli",
    reason: "invalid_mode",
    message: `Invalid githubAuthMode: ${String(requestedMode)}. Expected "gh-cli" or "token".`,
  };
}
