import type { GlobalSettings, ProjectSettings } from "@fusion/core";

export const REPO_OVERRIDE_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function normalizeRepoValue(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  return REPO_OVERRIDE_RE.test(trimmed) ? trimmed : "";
}

export function resolveEffectiveGithubRepoDefault(
  projectSettings?: Pick<ProjectSettings, "githubTrackingDefaultRepo"> | null,
  globalSettings?: Pick<GlobalSettings, "githubTrackingDefaultRepo"> | null,
): string {
  const projectRepo = normalizeRepoValue(projectSettings?.githubTrackingDefaultRepo);
  if (projectRepo) return projectRepo;

  return normalizeRepoValue(globalSettings?.githubTrackingDefaultRepo);
}
