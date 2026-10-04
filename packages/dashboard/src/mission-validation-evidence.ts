import { redactSecrets, type TaskDetail } from "@fusion/core";
import type { MissionForgeEvidenceReader, MissionValidationEvidenceRecord } from "@fusion/engine";
import type { GitHubClient } from "./github.js";
import { resolveGitLabTarget } from "./gitlab-lifecycle.js";
import type { GitLabClient } from "./gitlab.js";

const MAX_FORGE_RECORDS = 8;
const MAX_EXCERPT_LENGTH = 500;

type GitLabReadClient = Pick<GitLabClient, "listNotes">;
type GitHubReadClient = Pick<GitHubClient, "listPrComments" | "getIssueDetail">;
type GitHubTarget = { kind: "pull" | "issue"; owner: string; repo: string; number: number };

function parseGitHubTarget(url: string | undefined): GitHubTarget | undefined {
  const match = url?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)\/?$/i);
  if (!match) return undefined;
  return { kind: match[3].toLowerCase() === "pull" ? "pull" : "issue", owner: match[1], repo: match[2], number: Number(match[4]) };
}

function resolveGitHubTargets(task: Pick<TaskDetail, "prInfo" | "prInfos" | "sourceIssue" | "source">): GitHubTarget[] {
  const targets: GitHubTarget[] = [];
  const sourceIssue = task.sourceIssue;
  if (sourceIssue?.provider === "github") {
    const [owner, repo, extra] = sourceIssue.repository.split("/");
    const number = sourceIssue.issueNumber;
    if (owner && repo && !extra && Number.isInteger(number) && number > 0) {
      targets.push({ kind: "issue", owner, repo, number });
    } else {
      const sourceUrl = sourceIssue.url
        ?? (typeof task.source?.sourceMetadata?.issueUrl === "string" ? task.source.sourceMetadata.issueUrl : undefined);
      const target = parseGitHubTarget(sourceUrl);
      if (target?.kind === "issue") targets.push(target);
    }
  }

  const primary = task.prInfo ?? task.prInfos?.[0];
  const pull = parseGitHubTarget(primary?.url);
  if (pull?.kind === "pull") targets.push(pull);

  return targets.filter((target, index, all) =>
    all.findIndex((candidate) => candidate.kind === target.kind
      && candidate.owner === target.owner
      && candidate.repo === target.repo
      && candidate.number === target.number) === index,
  );
}

/*
FNXC:MissionValidationEvidence 2026-10-04-22:32:
Forge comments are external, untrusted text. Apply the same shared redaction
policy as durable receipts before passing their excerpts to the validator.
*/
function excerpt(value: string): string {
  return redactSecrets(value).replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_LENGTH);
}

function unavailable(reason: string) {
  return { unavailable: { source: "forge-record" as const, retryable: true, reason } };
}

/**
 * FNXC:MissionValidationEvidence 2026-10-04-22:32:
 * Mission validation selects the configured forge from durable task provenance,
 * not from a repository remote or a GitHub-only URL. Both adapters are
 * read-only and turn unavailable transport into a bounded retryable result.
 *
 * FNXC:MissionValidationEvidence 2026-10-04-22:56:
 * Source issues are distinct from pull requests. Read both durable targets so an
 * issue-comment criterion cannot pass merely because a task has no PR metadata.
 */
export function createDashboardMissionForgeReader(options: {
  githubClient?: GitHubReadClient;
  getGitLabClient?: () => Promise<GitLabReadClient | undefined>;
}): MissionForgeEvidenceReader {
  return {
    async read(task: Pick<TaskDetail, "prInfo" | "prInfos" | "sourceIssue" | "source" | "gitlabTracking" | "mergeDetails">) {
      const gitLabTarget = resolveGitLabTarget(task);
      if (gitLabTarget) {
        if (!options.getGitLabClient) return unavailable("configured forge reader is unavailable");
        try {
          const client = await options.getGitLabClient();
          if (!client) return unavailable("configured forge reader is unavailable");
          const resource = gitLabTarget.kind === "merge_request" ? "merge_requests" : "issues";
          const notes = await client.listNotes(resource, gitLabTarget.project, gitLabTarget.iid);
          const start = Math.max(0, notes.length - MAX_FORGE_RECORDS);
          const records: MissionValidationEvidenceRecord[] = notes.slice(start).map((body, index) => ({
            source: "forge-record",
            identifier: `gitlab-${gitLabTarget.kind}-note:${gitLabTarget.label}:${start + index}`,
            excerpt: excerpt(body),
          }));
          return { records };
        } catch {
          return unavailable("configured forge record read is unavailable");
        }
      }

      const targets = resolveGitHubTargets(task);
      if (!targets.length) return { records: [] };
      if (!options.githubClient) return unavailable("configured forge reader is unavailable");
      try {
        const records: MissionValidationEvidenceRecord[] = [];
        for (const target of targets) {
          if (target.kind === "pull") {
            const comments = await options.githubClient.listPrComments(target.owner, target.repo, target.number);
            records.push(...comments.slice(-MAX_FORGE_RECORDS).map((comment) => ({
              source: "forge-record" as const,
              identifier: `github-pr-comment:${comment.id}`,
              timestamp: comment.updated_at ?? comment.created_at,
              excerpt: excerpt(comment.body),
            })));
          } else {
            const detail = await options.githubClient.getIssueDetail(target.owner, target.repo, target.number);
            const start = Math.max(0, detail.comments.length - MAX_FORGE_RECORDS);
            records.push(...detail.comments.slice(start).map((comment, index) => ({
              source: "forge-record" as const,
              identifier: `github-issue-comment:${target.owner}/${target.repo}#${target.number}:${start + index}`,
              timestamp: comment.createdAt,
              excerpt: excerpt(comment.body),
            })));
          }
        }
        return { records: records.slice(-MAX_FORGE_RECORDS) };
      } catch {
        return unavailable("configured forge record read is unavailable");
      }
    },
  };
}
