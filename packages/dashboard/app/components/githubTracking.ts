import { REPO_OVERRIDE_RE, type GlobalSettings, type ProjectSettings } from "@fusion/core";

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
