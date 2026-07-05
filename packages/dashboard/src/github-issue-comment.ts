import type { TaskStore } from "@fusion/core";
import { GitHubClient } from "./github.js";
import { getCliPackageVersion, isUnresolvedCliPackageVersion } from "./cli-package-version.js";

interface TaskMovedEvent {
  task: {
    id: string;
    title?: string;
    sourceIssue?: {
      provider: string;
      repository: string;
      issueNumber: number;
    };
  };
  to: string;
}

const DEFAULT_COMMENT_TEMPLATE = "✅ Task {taskId} ({taskTitle}) has been completed and resolved.";

/*
 * FNXC:GitHubIssueComment 2026-07-05-01:30:
 * Requirement: when a Fusion task's linked source GitHub issue lives in the
 * Fusion self-repo (`runfusion/fusion`, case-insensitive), the completion
 * comment posted on `done` must ALSO include both a "Current version:" line
 * and a "Target release:" line (the next-minor bump of the currently
 * published `@runfusion/fusion` version), so readers know which Fusion
 * release ships the fix. Every other linked repository's completion comment
 * must remain byte-for-byte identical to the pre-FN-7575 template output.
 * If the resolved version is unparseable/unresolved (the `0.0.0` sentinel),
 * fall back silently to the base comment with no version lines — never throw.
 */
const FUSION_SELF_REPO = "runfusion/fusion";

/** Case-insensitive, trimmed `owner/repo` slug comparison against the Fusion self-repo. */
function isFusionSelfRepo(repository: string): boolean {
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
function computeNextMinorVersion(current: string): string | null {
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

export class GitHubIssueCommentService {
  private readonly store: TaskStore;
  private readonly getGitHubToken: () => string | undefined;
  private readonly getCurrentVersion: () => string;
  private readonly onTaskMoved = (event: TaskMovedEvent): void => {
    void this.handleTaskMoved(event);
  };
  private started = false;

  constructor(
    store: TaskStore,
    getGitHubToken?: () => string | undefined,
    getCurrentVersion?: () => string,
  ) {
    this.store = store;
    this.getGitHubToken = getGitHubToken ?? (() => process.env.GITHUB_TOKEN);
    this.getCurrentVersion = getCurrentVersion ?? (() => getCliPackageVersion(import.meta.url));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.store.on("task:moved", this.onTaskMoved);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.store.off("task:moved", this.onTaskMoved);
  }

  private async handleTaskMoved(event: TaskMovedEvent): Promise<void> {
    if (event.to !== "done") {
      return;
    }

    const task = event.task;
    const settings = await this.store.getSettings();
    if (!settings.githubCommentOnDone) {
      return;
    }

    const sourceIssue = task.sourceIssue;
    if (!sourceIssue || sourceIssue.provider !== "github") {
      return;
    }

    const [owner, repo] = sourceIssue.repository.split("/");
    if (!owner || !repo) {
      await this.store.logEntry(
        task.id,
        "Failed to post GitHub issue comment",
        `Invalid GitHub repository format: ${sourceIssue.repository}`,
      );
      return;
    }

    const template = settings.githubCommentTemplate || DEFAULT_COMMENT_TEMPLATE;
    let commentBody = template
      .replaceAll("{taskId}", task.id)
      .replaceAll("{taskTitle}", task.title ?? "");

    if (isFusionSelfRepo(sourceIssue.repository)) {
      const currentVersion = this.getCurrentVersion();
      const nextMinorVersion = computeNextMinorVersion(currentVersion);
      if (nextMinorVersion) {
        const currentLine = currentVersion.startsWith("v") ? currentVersion : `v${currentVersion}`;
        commentBody += `\n\nCurrent version: ${currentLine}\nTarget release: v${nextMinorVersion}`;
      }
    }

    try {
      const client = new GitHubClient(this.getGitHubToken());
      await client.commentOnIssue(owner, repo, sourceIssue.issueNumber, commentBody);
      await this.store.logEntry(
        task.id,
        "Posted GitHub issue completion comment",
        `${sourceIssue.repository}#${sourceIssue.issueNumber}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.logEntry(
        task.id,
        "Failed to post GitHub issue comment",
        message,
      );
    }
  }
}

export { DEFAULT_COMMENT_TEMPLATE, FUSION_SELF_REPO, isFusionSelfRepo, computeNextMinorVersion };
