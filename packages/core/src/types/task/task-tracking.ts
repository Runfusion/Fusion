/**
 * FNXC:CodeOrganization 2026-07-16-00:00:
 * PR/issue/GitHub/GitLab task tracking types peeled from types.ts.
 */
import type { PrStatus } from "../merge/merge-policy.js";

export type PrConflictState = "clean" | "conflicting" | "behind" | "blocked" | "unknown";

export interface PrConflictDiagnostics {
  conflictingFiles: string[];
  suggestedCommands: string[];
  capturedAt: string;
}

export interface PrInfo {
  url: string;
  number: number;
  status: PrStatus;
  title: string;
  headBranch: string;
  baseBranch: string;
  commentCount: number;
  isDraft?: boolean;
  draft?: boolean;
  /**
   * FNXC:PrAutoMergeGate 2026-06-28-00:33:
   * FN-7182: `true` means this PR was created or linked by the dashboard Create PR action as an explicit human handoff.
   * Pipeline PR-merge-strategy PRs leave this unset so automatic PR-mode merging keeps working. PrInfo is persisted as JSON, so this provenance flag needs no SQLite migration.
   */
  manual?: boolean;
  autoMergeOnGreen?: boolean;
  autoMergeStrategy?: "merge" | "squash" | "rebase";
  lastMergeError?: string;
  lastMergeErrorAt?: string;
  checkRollup?: "success" | "failure" | "pending" | "none";
  mergeable?: PrConflictState;
  conflictDiagnostics?: PrConflictDiagnostics;
  lastCommentAt?: string;
  lastCheckedAt?: string;
  lastReviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
}

export type IssueState = "open" | "closed";

export interface IssueInfo {
  url: string;
  number: number;
  state: IssueState;
  title: string;
  stateReason?: "completed" | "not_planned" | "reopened";
  lastCheckedAt?: string;
}

export interface TaskGithubTrackedIssue {
  owner: string;
  repo: string;
  number: number;
  url: string;
  nodeId?: string;
  createdAt: string;
  lastSyncedAt?: string;
}

export type GithubIssueAction = "close" | "delete" | "leave" | "auto";

export type GitLabTrackedItemKind = "project_issue" | "group_issue" | "merge_request";

/*
FNXC:GitLabTracking 2026-07-02-00:00:
GitLab tracking is a first-class task contract instead of overloading GitHub tracking because GitLab items can come from GitLab.com or self-managed instances and may be project issues, group issues, or merge requests. Store only public metadata and stale/link timestamps; never persist GitLab tokens here.
*/
export interface TaskGitLabTrackedItem {
  /** GitLab work item kind imported or linked to this task. */
  kind: GitLabTrackedItemKind;
  /** Canonical browser URL for GitLab.com or a self-managed GitLab instance. */
  url: string;
  /** GitLab web instance/base URL, for example https://gitlab.com or a self-managed host. */
  instanceUrl: string;
  /** Parsed host for compact display/dedup diagnostics. */
  host: string;
  /** GitLab IID visible inside a project or group namespace. */
  iid: number;
  /** Optional global GitLab database id when import APIs supplied it. */
  id?: number;
  /** Project numeric id when the item belongs to a concrete project. */
  projectId?: number;
  /** Project path with namespace, when available from import or URL parsing. */
  projectPath?: string;
  /** Group id/path for group-issue searches where GitLab returns a group-scoped source. */
  groupId?: number | string;
  groupPath?: string;
  /** Optional display title and live state snapshot; these are staleable metadata, not auth state. */
  title?: string;
  state?: string;
  createdAt: string;
  linkedAt?: string;
  lastSyncedAt?: string;
  staleAt?: string;
  staleReason?: string;
}

export interface TaskGitLabTracking {
  /** Per-task linked GitLab metadata. Separate from GitHub tracking because GitLab supports GitLab.com plus self-managed project/group/MR URLs without GitHub issue semantics. */
  item?: TaskGitLabTrackedItem;
  /** ISO-8601 of the most recent manual unlink, retained for audit. */
  unlinkedAt?: string;
}

export interface TaskGithubTracking {
  /** Per-task enabled override. When undefined, project/global default applies. */
  enabled?: boolean;
  /** "owner/repo" override; when undefined, project/global default repo applies. */
  repoOverride?: string;
  /** Linked GitHub issue. Set after issue creation succeeds. Cleared via unlinkGithubIssue(). */
  issue?: TaskGithubTrackedIssue;
  /** ISO-8601 timestamp of the task's one permitted in-progress tracking comment. */
  inProgressCommentedAt?: string;
  /** ISO-8601 of the most recent manual unlink, retained for audit. */
  unlinkedAt?: string;
}

/**
 * Durable provenance metadata for tasks imported from external issue trackers.
 *
 * Distinct from {@link IssueInfo}, which captures live issue status snapshots.
 * This contract stores source identity so the originating issue can be
 * re-associated even when live status is unavailable.
 */
export interface TaskSourceIssue {
  /** Issue provider key (for example: "github", "gitlab", "jira"). */
  provider: string;
  /** Repository/project identifier in provider-specific canonical form. */
  repository: string;
  /** Stable provider-specific external issue identifier (string to support non-numeric IDs). */
  externalIssueId: string;
  /** Human-visible issue number in the source tracker. */
  issueNumber: number;
  /** Optional canonical URL to the source issue. */
  url?: string;
  /**
   * FNXC:GithubSourceIssueAnalytics 2026-06-18-17:56:
   * Command Center "Fixed by Fusion" analytics need the real source-issue closure time when Fusion closed or observed the issue, replacing the prior `updatedAt` completion approximation when exact data is available.
   * ISO-8601 timestamp for when the source issue was closed; absent when the issue has never been observed closed.
   */
  closedAt?: string;
}
