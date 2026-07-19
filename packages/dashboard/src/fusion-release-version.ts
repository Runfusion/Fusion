import { isUnresolvedCliPackageVersion } from "./cli-package-version.js";

/*
 * FNXC:GitHubIssueComment 2026-07-15-09:40:
 * Requirement (FN-7575, issue #1916): when a Fusion task's linked source issue lives in the
 * Fusion self-repo (`runfusion/fusion`, case-insensitive), the completion comment posted on
 * `done` must ALSO report the current published `@runfusion/fusion` version and the targeted
 * next-minor release that will ship the fix. Comments on every other linked repository stay
 * byte-for-byte identical to the base template output.
 *
 * FNXC:GitHubIssueComment 2026-07-15-10:40:
 * These helpers live in a shared module because FOUR services can post a done comment, and the
 * original FN-7575 fix only covered one. They gate on DIFFERENT, non-interchangeable linkages —
 * neither is redundant, and neither may be deleted as a "duplicate":
 *   - {GitHub,GitLab}IssueCommentService — gate on `task.sourceIssue` (the IMPORT linkage, set
 *     unconditionally by buildGitHubIssueSource/the GitLab equivalent) plus the documented
 *     `githubCommentOnDone`/`gitlabCommentOnDone` settings. No Settings UI, but reachable via the
 *     settings API/file; see docs/settings-reference.md.
 *   - {GitHub,GitLab}TrackingCommentService — gate on per-task `githubTracking.enabled` /
 *     `gitlabTracking.item` (the explicit TRACKING linkage), and post the "✅ Done —" comments.
 * An imported issue has sourceIssue but NO tracking linkage unless `githubLinkImportedIssuesToTracking`
 * or the tracking defaults resolve on (resolveImportedIssueGithubTracking), so with tracking off the
 * issue-comment service is the ONLY surface that comments. FN-7575 covered only that surface while
 * users saw the tracking surface, so the version lines were invisible in production for ~10 days.
 *
 * Known overlap: a task carrying BOTH linkages with comment-on-done enabled gets two comments from
 * the two services. Pre-existing, orthogonal to release lines, not deduped here.
 *
 * Any NEW done-comment surface must import from here rather than re-deriving the version logic.
 */
export const FUSION_SELF_REPO = "runfusion/fusion";

/** Case-insensitive, trimmed `owner/repo` slug comparison against the Fusion self-repo. */
export function isFusionSelfRepo(repository: string): boolean {
  return repository.trim().toLowerCase() === FUSION_SELF_REPO;
}

/** `major.minor.patch` leading numeric semver shape; ignores any trailing prerelease/build metadata. */
const SEMVER_PREFIX_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)/;

/**
 * Compute the next-minor release version (patch reset to 0) from a semver string,
 * e.g. `"0.55.0"` -> `"0.56.0"`, `"1.2.9"` -> `"1.3.0"`, `"v0.55.0"` -> `"0.56.0"`.
 * Returns `null` for the unresolved `"0.0.0"` sentinel or any unparseable input so
 * callers can skip appending version lines rather than emit garbage.
 */
export function computeNextMinorVersion(current: string): string | null {
  if (isUnresolvedCliPackageVersion(current)) {
    return null;
  }

  const match = SEMVER_PREFIX_PATTERN.exec(current.trim());
  if (!match) {
    return null;
  }

  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return null;
  }

  return `${major}.${minor + 1}.0`;
}

/**
 * Build the release-version lines for a done comment on a Fusion self-repo issue.
 *
 * Returns `[]` — never throws — when the repo is not the self-repo or the version is
 * unresolvable, so callers can spread the result unconditionally and non-self-repo
 * comments stay byte-for-byte unchanged.
 *
 * `currentVersion` accepts a resolver so the self-repo check short-circuits BEFORE
 * `getCliPackageVersion()` walks the filesystem — every other repo's done comment pays nothing.
 */
export function formatReleaseVersionLines(
  repository: string,
  currentVersion: string | (() => string),
): string[] {
  if (!isFusionSelfRepo(repository)) {
    return [];
  }

  const resolved = typeof currentVersion === "function" ? currentVersion() : currentVersion;
  const nextMinorVersion = computeNextMinorVersion(resolved);
  if (!nextMinorVersion) {
    return [];
  }

  const trimmed = resolved.trim();
  const currentLine = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  return [`Current version: ${currentLine}`, `Target release: v${nextMinorVersion}`];
}
