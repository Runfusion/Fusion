import type { GlobalSettings, ProjectSettings, Task, TaskStore } from "@fusion/core";
import type { CreatedIssue } from "./github.js";
import type { GitHubClient } from "./github.js";

export interface MaybeCreateTrackingIssueDeps {
  taskStore: TaskStore;
  githubClient: GitHubClient;
  projectSettings: ProjectSettings;
  globalSettings: GlobalSettings;
  logger?: Pick<Console, "warn" | "info">;
}

function parseRepo(value: string | undefined): { owner: string; repo: string } | null {
  if (!value) return null;
  const trimmed = value.trim();
  const [owner, repo, ...rest] = trimmed.split("/");
  if (!owner || !repo || rest.length > 0) return null;
  return { owner, repo };
}

export async function maybeCreateTrackingIssue(
  task: Task,
  deps: MaybeCreateTrackingIssueDeps,
): Promise<{ created: false; reason: string } | { created: true; issue: CreatedIssue }> {
  const tracking = task.githubTracking;
  if (tracking?.enabled !== true) {
    return { created: false, reason: "tracking_disabled" };
  }

  if (tracking.issue) {
    return { created: false, reason: "issue_already_linked" };
  }

  if (task.sourceType === "github_import") {
    return { created: false, reason: "github_import_source" };
  }

  const repo =
    parseRepo(tracking.repoOverride) ??
    parseRepo(deps.projectSettings.githubTrackingDefaultRepo) ??
    parseRepo(deps.globalSettings.githubTrackingDefaultRepo);

  if (!repo) {
    deps.logger?.warn?.(`[github-tracking] No repo configured for ${task.id}`);
    await deps.taskStore.recordActivity({
      type: "task:updated",
      taskId: task.id,
      taskTitle: task.title,
      details: "GitHub tracking issue not created: no repository configured",
      metadata: { type: "github-tracking-no-repo" },
    });
    return { created: false, reason: "no_repo_configured" };
  }

  const title = `[${task.id}] ${task.title ?? task.description.slice(0, 80)}`;
  const body = `Tracking issue for ${task.id}.\n\n_Summary placeholder — populated by FN-3871._`;

  try {
    const issue = await deps.githubClient.createIssue({ owner: repo.owner, repo: repo.repo, title, body });

    await deps.taskStore.linkGithubIssue(task.id, {
      owner: repo.owner,
      repo: repo.repo,
      number: issue.number,
      url: issue.htmlUrl,
      createdAt: issue.createdAt,
    });

    await deps.taskStore.recordActivity({
      type: "task:updated",
      taskId: task.id,
      taskTitle: task.title,
      details: `Linked tracking issue ${repo.owner}/${repo.repo}#${issue.number}`,
      metadata: {
        type: "github-issue-created",
        repo: `${repo.owner}/${repo.repo}`,
        number: issue.number,
        htmlUrl: issue.htmlUrl,
      },
    });

    return { created: true, issue };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger?.warn?.(`[github-tracking] Failed to create issue for ${task.id} in ${repo.owner}/${repo.repo}: ${message}`);
    return { created: false, reason: "github_error" };
  }
}
