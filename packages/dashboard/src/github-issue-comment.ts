import type { TaskStore } from "@fusion/core";
import { GitHubClient } from "./github.js";
import { getCliPackageVersion } from "./cli-package-version.js";
import {
  FUSION_SELF_REPO,
  computeNextMinorVersion,
  formatReleaseVersionLines,
  isFusionSelfRepo,
} from "./fusion-release-version.js";

interface TaskSourceIssueRef {
  provider: string;
  repository: string;
  issueNumber: number;
}

interface TaskMovedEvent {
  task: {
    id: string;
    title?: string;
    sourceIssue?: TaskSourceIssueRef;
    githubTracking?: {
      enabled?: boolean;
      issue?: { owner?: string; repo?: string; number?: number };
    };
  };
  /** Present on the real store event; GitHubTrackingCommentService no-ops when `from === to`. */
  from?: string;
  to: string;
}

const DEFAULT_COMMENT_TEMPLATE = "✅ Task {taskId} ({taskTitle}) has been completed and resolved.";

/*
 * FNXC:GitHubIssueComment 2026-07-15-11:20:
 * Requirement: a task must never receive TWO done comments on the SAME issue. A task can carry both
 * linkages at once — maybeCreateTrackingIssue() ADOPTS a github sourceIssue as githubTracking.issue
 * (github-tracking.ts, `source_issue_linked`), pointing both services at one issue — so with
 * `githubCommentOnDone` on, this service and GitHubTrackingCommentService both commented on it.
 *
 * Suppress THIS service only when the tracking service will provably post to the SAME issue: it owns
 * the richer comment (commit/branch/PR/files/merged + release lines). The two may legitimately target
 * DIFFERENT issues (a tracking issue linked separately from the source issue) — that is two comments
 * on two issues, which is correct and must keep working, so match on identity, never on "both linked".
 *
 * Mirrors the tracking service's own `from === to` no-op guard: on a same-column re-emit the tracking
 * service stays silent, so suppressing here would drop the only comment.
 */
function sameGitHubIssue(
  sourceIssue: TaskSourceIssueRef,
  trackingIssue: { owner?: string; repo?: string; number?: number },
): boolean {
  const [owner, repo] = sourceIssue.repository.split("/");
  if (!owner || !repo || !trackingIssue.owner || !trackingIssue.repo) {
    return false;
  }
  return owner.toLowerCase() === trackingIssue.owner.toLowerCase()
    && repo.toLowerCase() === trackingIssue.repo.toLowerCase()
    && sourceIssue.issueNumber === trackingIssue.number;
}

/** True when GitHubTrackingCommentService will post its own done comment to this exact issue. */
function trackingCommentCoversSourceIssue(event: TaskMovedEvent, sourceIssue: TaskSourceIssueRef): boolean {
  if (event.from === event.to) {
    return false;
  }
  const tracking = event.task.githubTracking;
  if (tracking?.enabled !== true || !tracking.issue) {
    return false;
  }
  return sameGitHubIssue(sourceIssue, tracking.issue);
}

/*
 * FNXC:GitHubIssueComment 2026-07-15-10:40:
 * Self-repo detection and next-minor computation live in `fusion-release-version.ts` so this
 * service and GitHubTrackingCommentService share one implementation. See that module for the
 * requirement and the FN-7575 miss.
 *
 * NOT redundant with GitHubTrackingCommentService: this service covers the `sourceIssue` IMPORT
 * linkage (documented `githubCommentOnDone`; docs/settings-reference.md), while that one covers the
 * `githubTracking.enabled` linkage. An issue imported with tracking defaults off has sourceIssue and
 * no tracking, so THIS is the only surface that comments. Do not delete it as a duplicate.
 */

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

    if (trackingCommentCoversSourceIssue(event, sourceIssue)) {
      /*
       * FNXC:GitHubIssueComment 2026-07-15-11:20:
       * Logged, not silent: suppression is otherwise invisible, and a custom `githubCommentTemplate`
       * not appearing on a tracked issue is surprising enough to need a breadcrumb. Once per task
       * completion, so this is not the high-frequency skip-log noise FN-8024 removed.
       */
      await this.store.logEntry(
        task.id,
        "Skipped GitHub issue completion comment",
        `${sourceIssue.repository}#${sourceIssue.issueNumber} is tracked; GitHub tracking comment covers it`,
      );
      return;
    }

    const template = settings.githubCommentTemplate || DEFAULT_COMMENT_TEMPLATE;
    let commentBody = template
      .replaceAll("{taskId}", task.id)
      .replaceAll("{taskTitle}", task.title ?? "");

    const versionLines = formatReleaseVersionLines(sourceIssue.repository, () => this.getCurrentVersion());
    if (versionLines.length > 0) {
      commentBody += `\n\n${versionLines.join("\n")}`;
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

export { DEFAULT_COMMENT_TEMPLATE };
// Re-exported from ./fusion-release-version.js for back-compat with existing importers/tests.
export { FUSION_SELF_REPO, isFusionSelfRepo, computeNextMinorVersion };
