import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "@fusion/core";

/*
FNXC:Workspace 2026-08-20-20:05:
A populated workspaceWorktrees map fences stale singular routing in browser snapshots while the
store's asynchronous normalization catches up. Presentation must show every acquired repository,
even for a one-repository workspace, rather than hiding it behind task.worktree.

Task Detail lifts the former flat-list ceiling with durable landed/pending/failed repository
status. TaskCard remains count-only because its dense layout cannot safely grow a per-repo list;
legacy and empty rows stay pending because task error prose cannot attribute a repository failure.
*/

export function isWorkspaceTask(task: Pick<Task, "workspaceWorktrees">): boolean {
  const entries = task.workspaceWorktrees;
  return Boolean(entries && Object.keys(entries).length > 0);
}

type WorkspaceEntry = NonNullable<Task["workspaceWorktrees"]>[string];
type WorkspaceStatus = "landed" | "pending" | "failed";

export function deriveWorkspaceRepoStatus(
  entry: WorkspaceEntry,
  repoRelPath: string,
  mergeDetails?: Task["mergeDetails"],
): { status: WorkspaceStatus; landedSha?: string; failureMessage?: string; failureResource?: string; failureAction?: string } {
  const landedSha = entry.landedSha ?? mergeDetails?.workspaceLandedShas?.[repoRelPath];
  if (landedSha) return { status: "landed", landedSha };
  if (entry.landFailure) {
    return {
      status: "failed",
      failureMessage: entry.landFailure.message,
      failureResource: entry.landFailure.resource,
      failureAction: entry.landFailure.action,
    };
  }
  return { status: "pending" };
}

interface WorkspaceWorktreesSummaryProps {
  task: Pick<Task, "worktree" | "workspaceWorktrees" | "repositoryScope" | "modifiedFiles" | "mergeDetails" | "error">;
  compact?: boolean;
  onScopeChange?: (input: { repositories: string[]; reason: string; action: "add" | "remove" | "refuse" }) => Promise<void>;
}

function RepositoryScopeControls({
  onScopeChange,
}: Pick<WorkspaceWorktreesSummaryProps, "onScopeChange">) {
  const { t } = useTranslation("app");
  const [repository, setRepository] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!onScopeChange) return null;
  const submit = async (action: "add" | "remove" | "refuse") => {
    const selected = repository.trim();
    if (!selected || !reason.trim()) {
      setError(t("tasks.workspaceScopeReasonRequired", "Repository and reason are required."));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onScopeChange({ repositories: [selected], reason: reason.trim(), action });
      setRepository("");
      setReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("tasks.workspaceScopeUpdateFailed", "Repository scope could not be updated."));
    } finally {
      setSaving(false);
    }
  };
  return <section className="workspace-repository-scope-controls" aria-label={t("tasks.workspaceScopeControls", "Repository scope controls")}>
    <label>
      {t("tasks.workspaceScopeRepository", "Repository")}
      <input value={repository} onChange={(event) => setRepository(event.target.value)} disabled={saving} />
    </label>
    <label>
      {t("tasks.workspaceScopeReason", "Reason")}
      <input value={reason} onChange={(event) => setReason(event.target.value)} disabled={saving} />
    </label>
    <div className="workspace-repository-scope-actions">
      <button type="button" className="btn btn-sm" onClick={() => void submit("add")} disabled={saving}>{t("tasks.workspaceScopeAdd", "Add")}</button>
      <button type="button" className="btn btn-sm" onClick={() => void submit("remove")} disabled={saving}>{t("tasks.workspaceScopeRemove", "Remove")}</button>
      <button type="button" className="btn btn-sm" onClick={() => void submit("refuse")} disabled={saving}>{t("tasks.workspaceScopeRefuse", "Refuse")}</button>
    </div>
    {error && <div role="alert" className="workspace-repository-scope-error">{error}</div>}
  </section>;
}

export function WorkspaceWorktreesSummary({ task, compact = false, onScopeChange }: WorkspaceWorktreesSummaryProps) {
  const { t } = useTranslation("app");
  const entries = task.workspaceWorktrees;
  if (!isWorkspaceTask(task) || !entries) return null;

  const repos = Object.entries(entries).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  /* FNXC:RepositoryScope 2026-08-20-23:07: task detail distinguishes acquired checkout state from explicit intent and diff evidence. */
  const scopedRepos = new Set(task.repositoryScope?.repositories ?? []);
  const statuses = repos.map(([repoRelPath, entry]) => ({
    repoRelPath,
    entry,
    scopeState: task.repositoryScope ? (scopedRepos.has(repoRelPath) ? "scoped" : "out-of-scope") : "legacy",
    modified: (task.modifiedFiles ?? []).some((file) => file.startsWith(`${repoRelPath}/`)),
    ...deriveWorkspaceRepoStatus(entry, repoRelPath, task.mergeDetails),
  }));
  const landedCount = statuses.filter(({ status }) => status === "landed").length;
  const hasStatusEvidence = statuses.some(({ status }) => status !== "pending");
  const fullyLanded = landedCount === repos.length;
  const acquiredLabel = t(
    "tasks.workspaceReposAcquired",
    repos.length === 1 ? "{{count}} repo acquired" : "{{count}} repos acquired",
    { count: repos.length },
  );
  const placeholder = hasStatusEvidence
    ? t("tasks.workspaceReposLanded", "{{landed}} of {{count}} repos landed", { landed: landedCount, count: repos.length })
    : acquiredLabel;

  if (compact) {
    return <div className="card-branch-row" aria-label={t("tasks.workspaceWorktrees", "Workspace repos")}><span className="card-branch-chip" data-testid="workspace-worktrees-placeholder" title={acquiredLabel}><span className="card-branch-label">{t("tasks.workspace", "Workspace")}</span><span className="card-branch-value">{acquiredLabel}</span></span></div>;
  }

  return <div className="workspace-worktrees-summary" data-testid="workspace-worktrees-summary" aria-label={t("tasks.workspaceWorktrees", "Workspace repos")}>
    <div className="workspace-worktrees-placeholder" data-testid="workspace-worktrees-placeholder">{placeholder}</div>
    {!fullyLanded && task.error && <div className="workspace-worktrees-failure" data-testid="workspace-partial-land-detail">{task.error}</div>}
    <RepositoryScopeControls onScopeChange={onScopeChange} />
    {task.repositoryScope?.extensions?.length ? <ul className="workspace-repository-scope-history" aria-label={t("tasks.workspaceScopeHistory", "Repository scope history")}>
      {task.repositoryScope.extensions.map((event, index) => <li key={`${event.repository}-${event.requestedAt}-${index}`}>{event.repository}: {event.status} — {event.reason}</li>)}
    </ul> : null}
    <ul className="workspace-worktrees-list">
      {statuses.map(({ repoRelPath, entry, status, scopeState, modified, landedSha, failureMessage, failureResource, failureAction }) => <li key={repoRelPath} className="workspace-worktrees-item workspace-worktrees-item--wrapping">
        <span className="workspace-worktrees-repo" title={repoRelPath}>{repoRelPath}</span>
        <span className={`workspace-worktrees-status workspace-worktrees-status--${status}`} data-testid={`workspace-repo-status-${status}`} aria-label={`${repoRelPath}: ${status}`}>{status}</span>
        <span className="workspace-worktrees-scope" data-testid={`workspace-repo-scope-${scopeState}`}>{scopeState === "out-of-scope" ? t("tasks.workspaceRepoOutOfScope", "Out of scope") : modified ? t("tasks.workspaceRepoModified", "Modified") : t("tasks.workspaceRepoNotReviewed", "No changes — not reviewed")}</span>
        {landedSha && <span className="workspace-worktrees-sha">{landedSha.slice(0, 8)}</span>}
        <span className="workspace-worktrees-path" title={entry.worktreePath}>{entry.worktreePath}</span>
        <span className="workspace-worktrees-branch" title={entry.branch}>{entry.branch}</span>
        {entry.baseBranch && <span className="workspace-worktrees-base" data-testid="workspace-repo-base-branch" title={t("tasks.workspaceRepoBaseBranch", "Base branch for {{repo}}", { repo: repoRelPath })}>{t("tasks.workspaceRepoBase", "Base: {{branch}}", { branch: entry.baseBranch })}</span>}
        {entry.baseBranchFallbackFrom && <span className="workspace-worktrees-base-fallback" data-testid="workspace-repo-base-fallback" title={t("tasks.workspaceRepoBaseFallbackTitle", "{{requested}} was unavailable in {{repo}}; using {{resolved}}", { requested: entry.baseBranchFallbackFrom, repo: repoRelPath, resolved: entry.baseBranch ?? entry.branch })}>{t("tasks.workspaceRepoBaseFallback", "Base fallback")}</span>}
        {failureMessage && <span className="workspace-worktrees-failure-message">{failureMessage}{failureResource ? ` ${failureResource}.` : ""}{failureAction ? ` ${failureAction}.` : ""}</span>}
      </li>)}
    </ul>
  </div>;
}
