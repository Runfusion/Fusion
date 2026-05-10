import type { GlobalSettings, ProjectSettings, Task } from "./types.js";

export interface RepoSlug {
  owner: string;
  repo: string;
}

export interface ResolvedTaskGithubTracking {
  enabled: boolean;
  repo: RepoSlug | null;
  source: {
    enabled: "task" | "project" | "global" | "default";
    repo: "task" | "project" | "global" | "none";
  };
}

export const REPO_OVERRIDE_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function parseRepoSlugCandidate(input: unknown): RepoSlug | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (!REPO_OVERRIDE_RE.test(trimmed)) return null;

  const [owner, repo] = trimmed.split("/");
  return { owner, repo };
}

export function parseRepoSlug(input: string | undefined | null): RepoSlug | null {
  return parseRepoSlugCandidate(input);
}

export function isValidRepoSlug(input: string): boolean {
  return parseRepoSlug(input) !== null;
}

export function resolveTaskGithubTracking(
  task: Pick<Task, "githubTracking">,
  projectSettings?: Pick<ProjectSettings, "githubTrackingEnabledByDefault" | "githubTrackingDefaultRepo"> & {
    githubTrackingDefaultEnabledForNewTasks?: boolean;
    githubDefaultRepo?: string;
  },
  globalSettings?: Pick<GlobalSettings, "githubTrackingDefaultRepo"> & {
    githubTrackingDefaultEnabledForNewTasks?: boolean;
    githubDefaultRepo?: string;
  },
): ResolvedTaskGithubTracking {
  const taskEnabled = task.githubTracking?.enabled;
  const projectEnabled = projectSettings?.githubTrackingEnabledByDefault
    ?? projectSettings?.githubTrackingDefaultEnabledForNewTasks;
  // TODO(FN-3868): remove legacy fallback keys once all callers are migrated.
  const globalEnabled = globalSettings?.githubTrackingDefaultEnabledForNewTasks;

  let enabled = false;
  let enabledSource: ResolvedTaskGithubTracking["source"]["enabled"] = "default";

  if (typeof taskEnabled === "boolean") {
    enabled = taskEnabled;
    enabledSource = "task";
  } else if (typeof projectEnabled === "boolean") {
    enabled = projectEnabled;
    enabledSource = "project";
  } else if (typeof globalEnabled === "boolean") {
    enabled = globalEnabled;
    enabledSource = "global";
  } else {
    enabled = false;
    enabledSource = "default";
  }

  const taskRepo = parseRepoSlugCandidate(task.githubTracking?.repoOverride);
  const projectRepo = parseRepoSlugCandidate(projectSettings?.githubTrackingDefaultRepo ?? projectSettings?.githubDefaultRepo);
  const globalRepo = parseRepoSlugCandidate(globalSettings?.githubTrackingDefaultRepo ?? globalSettings?.githubDefaultRepo);

  let repo: RepoSlug | null = null;
  let repoSource: ResolvedTaskGithubTracking["source"]["repo"] = "none";

  if (taskRepo) {
    repo = taskRepo;
    repoSource = "task";
  } else if (projectRepo) {
    repo = projectRepo;
    repoSource = "project";
  } else if (globalRepo) {
    repo = globalRepo;
    repoSource = "global";
  }

  return {
    enabled,
    repo,
    source: {
      enabled: enabledSource,
      repo: repoSource,
    },
  };
}
