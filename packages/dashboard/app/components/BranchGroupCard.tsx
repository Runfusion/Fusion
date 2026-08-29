import "./BranchGroupCard.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ChevronDown, ChevronRight, CircleDashed, ExternalLink, GitBranch, GitPullRequest, Loader2 } from "lucide-react";
import type { BranchGroupSummary } from "../api";
import { ApiRequestError, apiAbandonBranchGroup, apiAssignTaskBranchGroup, apiGetBranchGroup, apiPromoteBranchGroup } from "../api";
import { subscribeSse } from "../sse-bus";
import { BRANCH_GROUP_REFRESH_TASK_EVENTS, shouldRefreshBranchGroupForTaskEvent } from "../utils/branchGroupSse";

interface BranchGroupCardProps {
  groupId: string;
  taskId?: string;
  projectId?: string;
  onBranchGroupReset?: () => Promise<void> | void;
  /** Opens a landed member in the existing Review surface. */
  onOpenReviewTask?: (taskId: string) => void;
}

export function BranchGroupCard({ groupId, taskId, projectId, onBranchGroupReset, onOpenReviewTask }: BranchGroupCardProps) {
  const { t } = useTranslation("app");
  const [group, setGroup] = useState<BranchGroupSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missingGroup, setMissingGroup] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [confirmPromotion, setConfirmPromotion] = useState(false);
  /*
  FNXC:BranchGroupDetails 2026-06-30-00:00:
  Task-detail branch groups must be collapsed by default on every breakpoint while preserving the user's expand/collapse control for member and action inspection.
  */
  const [collapsed, setCollapsed] = useState(true);

  const loadGroup = useCallback(async () => {
    try {
      const response = await apiGetBranchGroup(groupId, projectId);
      setGroup(response.group);
      setError(null);
      setMissingGroup(false);
    } catch (loadError) {
      const isMissing = loadError instanceof ApiRequestError && loadError.status === 404;
      const message = loadError instanceof Error ? loadError.message : t("branchGroup.loadError", "Failed to load branch group");
      setMissingGroup(isMissing);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [groupId, projectId, t]);

  const loadGroupRef = useRef(loadGroup);

  useEffect(() => {
    loadGroupRef.current = loadGroup;
  }, [loadGroup]);

  useEffect(() => {
    setLoading(true);
    void loadGroup();
  }, [loadGroup]);

  useEffect(() => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const refreshFromCurrentGroup = (event?: MessageEvent) => {
      if (event && !shouldRefreshBranchGroupForTaskEvent(event, projectId)) {
        return;
      }
      void loadGroupRef.current();
    };
    /*
    FNXC:BranchGroupDetails 2026-06-30-18:04:
    Task-detail branch group refreshes use the current loader callback so live SSE updates do not reset the local collapsed/expanded state.
    */
    const events = Object.fromEntries(BRANCH_GROUP_REFRESH_TASK_EVENTS.map((eventName) => [eventName, refreshFromCurrentGroup]));
    return subscribeSse(`/api/events${query}`, {
      events,
      onReconnect: () => refreshFromCurrentGroup(),
    });
  }, [projectId]);

  const completionText = useMemo(() => {
    if (!group) return "";
    return t("branchGroup.completionText", "{{landed}} of {{total}} members finished", {
      landed: group.completion.landed,
      total: group.completion.total,
    });
  }, [group, t]);

  const onPromote = useCallback(async () => {
    setConfirmPromotion(false);
    setPromoting(true);
    try {
      await apiPromoteBranchGroup(groupId, projectId);
      await loadGroup();
    } finally {
      setPromoting(false);
    }
  }, [groupId, loadGroup, projectId]);

  const onAbandon = useCallback(async () => {
    setAbandoning(true);
    try {
      await apiAbandonBranchGroup(groupId, projectId);
      await loadGroup();
    } finally {
      setAbandoning(false);
    }
  }, [groupId, loadGroup, projectId]);

  /*
  FNXC:BranchGroupRecovery 2026-07-02-11:55:
  Stale branch-group references must be recoverable from task detail by clearing only the affected task through the supported branch-group assignment API. Do not require operators to stop Fusion or run raw SQLite json_remove repairs.
  */
  const onResetStaleContext = useCallback(async () => {
    if (!taskId) return;
    setResetting(true);
    try {
      await apiAssignTaskBranchGroup({ taskId, groupId: null }, projectId);
      await onBranchGroupReset?.();
    } finally {
      setResetting(false);
    }
  }, [onBranchGroupReset, projectId, taskId]);

  if (loading) {
    return <div className="card branch-group-card"><Loader2 className="spin" size={14} /> {t("branchGroup.loading", "Loading branch group…")}</div>;
  }

  if (error || !group) {
    if (missingGroup) {
      return (
        <section className="card branch-group-card branch-group-card-error" aria-live="polite">
          <div className="branch-group-card-error-title">{t("branchGroup.staleTitle", "Stale branch group reference")}</div>
          <p className="branch-group-card-error-copy">
            {t(
              "branchGroup.staleDescription",
              "This task references branch group {{groupId}}, but that group is no longer available. Reset only this task's branch group to continue without raw SQLite edits.",
              { groupId },
            )}
          </p>
          {taskId ? (
            <button type="button" className="btn" onClick={() => void onResetStaleContext()} disabled={resetting}>
              {resetting ? <Loader2 size={14} className="spin" /> : null}
              {t("branchGroup.resetTask", "Reset branch group for this task")}
            </button>
          ) : (
            <span className="branch-group-card-error-copy">{t("branchGroup.resetUnavailable", "Open the task detail view to reset this stale branch group reference.")}</span>
          )}
        </section>
      );
    }

    return <div className="card branch-group-card branch-group-card-error">{error ?? t("branchGroup.unavailable", "Branch group unavailable")}</div>;
  }

  const completionPercent = group.completion.total > 0
    ? (group.completion.landed / group.completion.total) * 100
    : 0;
  const complete = group.completion.complete;
  const advisories = group.advisories ?? [];

  return (
    <section className={`card branch-group-card${collapsed ? " branch-group-card--collapsed" : ""}`}>
      <header className="branch-group-card-header">
        <div className="branch-group-card-title">
          <GitBranch size={14} />
          <strong>{group.branchName}</strong>
        </div>
        <div className="branch-group-card-header-meta">
          <span className="badge branch-group-card-badge">{t("branchGroup.groupLabel", "Group {{id}}", { id: group.id })}</span>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("branchGroup.expandLabel", "Expand branch group") : t("branchGroup.collapseLabel", "Collapse branch group")}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </header>
      <div className="branch-group-card-progress-text">{completionText}</div>
      <div className="branch-group-card-progress" role="progressbar" aria-valuenow={group.completion.landed} aria-valuemin={0} aria-valuemax={group.completion.total}>
        <span className="branch-group-card-progress-fill" style={{ width: `${completionPercent}%` }} />
      </div>

      {!collapsed && (
        <ul className="branch-group-card-members">
          {group.members.map((member) => (
            <li key={member.taskId} className="branch-group-card-member">
              <span className={`status-dot ${member.landed ? "status-dot--online" : "status-dot--pending"}`} />
              <span className="branch-group-card-member-title">{member.taskId} · {member.title}</span>
              {advisories.some((advisory) => advisory.taskId === member.taskId) && onOpenReviewTask ? (
                <button type="button" className="btn branch-group-card-review" onClick={() => onOpenReviewTask(member.taskId)}>
                  {t("branchGroup.reviewAdvisory", "Review")}
                </button>
              ) : null}
              <span className="branch-group-card-member-status">{member.landed ? <CheckCircle2 size={14} /> : <CircleDashed size={14} />}</span>
            </li>
          ))}
        </ul>
      )}

      {!collapsed && (group.prState === "merged" || group.prState === "closed") && (
        <div className="branch-group-card-actions">
          <span className="badge">{group.prState === "merged" ? "Group PR merged" : "Group PR closed"}</span>
          {group.prUrl && (
            <a className="btn" href={group.prUrl} target="_blank" rel="noreferrer">
              <GitPullRequest size={14} /> {t("branchGroups.prNumber", "PR #{{number}}", { number: group.prNumber ?? "—" })}
              <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}

      {!collapsed && (complete || group.prState === "open") && group.prState !== "merged" && group.prState !== "closed" && (
        <div className="branch-group-card-actions">
          {group.prUrl && (
            <a className="btn" href={group.prUrl} target="_blank" rel="noreferrer">
              <GitPullRequest size={14} /> {t("branchGroups.prNumber", "PR #{{number}}", { number: group.prNumber ?? "—" })}
              <ExternalLink size={12} />
            </a>
          )}
          {/* Promote (Open PR / Merge group) stays gated on completion: a group
              can only be promoted once every member has landed. Abandon below is
              reachable whenever the PR is open, even if completion later reverts. */}
          {complete && (group.autoMerge ? (
            <span className="badge">{t("branchGroup.autoMergeEnabled", "Auto-merge enabled")}</span>
          ) : group.prState === "none" ? (
            <button type="button" className="btn" onClick={() => setConfirmPromotion(true)} disabled={promoting}>
              {promoting ? <Loader2 size={14} className="spin" /> : <GitPullRequest size={14} />}
              {t("branchGroup.openPr", "Open PR")}
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirmPromotion(true)} disabled={promoting}>
              {promoting ? <Loader2 size={14} className="spin" /> : <GitPullRequest size={14} />}
              {t("branchGroup.mergeIntoMain", "Merge group into main")}
            </button>
          ))}
          {group.prState === "open" && (
            <button type="button" className="btn btn-danger" onClick={() => void onAbandon()} disabled={abandoning}>
              {abandoning ? <Loader2 size={14} className="spin" /> : null}
              {t("branchGroup.abandonGroup", "Abandon group")}
            </button>
          )}
        </div>
      )}
      {confirmPromotion && (
        <div className="branch-group-card-confirm-backdrop" role="presentation">
          <section className="card branch-group-card-confirm" role="dialog" aria-modal="true" aria-label={t("branchGroup.confirmPromotion", "Confirm group promotion")}>
            <h3>{t("branchGroup.confirmPromotion", "Confirm group promotion")}</h3>
            <p>{group.prState === "none"
              ? t("branchGroup.confirmOpenPr", "Review landed member advisories before opening the group pull request.")
              : t("branchGroup.confirmMerge", "Review landed member advisories before merging this group.")}</p>
            {advisories.length > 0 ? (
              <ul className="branch-group-card-advisories" aria-label={t("branchGroup.advisoryList", "Landed-member review advisories")}>
                {advisories.map((advisory) => (
                  <li key={`${advisory.taskId}:${advisory.workflowStepId}:${advisory.notes ?? ""}`}>
                    <div className="branch-group-card-advisory-heading">
                      <strong>{advisory.taskId} · {advisory.workflowStepName}</strong>
                      {advisory.verdict ? <span className="badge">{advisory.verdict}</span> : null}
                    </div>
                    {advisory.notes ? <p className="branch-group-card-advisory-notes">{advisory.notes}</p> : null}
                    {advisory.findings.length > 0 ? (
                      <ul className="branch-group-card-advisory-findings">
                        {advisory.findings.map((finding) => (
                          <li key={finding.id}>
                            <strong>{finding.title}</strong>
                            <p>{finding.body}</p>
                            {finding.filePath ? <span>{finding.filePath}{finding.line ? `:${finding.line}` : ""}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {onOpenReviewTask ? <button type="button" className="btn branch-group-card-review" onClick={() => onOpenReviewTask(advisory.taskId)}>{t("branchGroup.reviewAdvisory", "Review")}</button> : null}
                  </li>
                ))}
              </ul>
            ) : <p>{t("branchGroup.noAdvisories", "No landed-member review advisories were recorded.")}</p>}
            <div className="branch-group-card-actions">
              <button type="button" className="btn" onClick={() => setConfirmPromotion(false)}>{t("common.cancel", "Cancel")}</button>
              <button type="button" className="btn btn-primary" onClick={() => void onPromote()} disabled={promoting}>
                {promoting ? <Loader2 size={14} className="spin" /> : null}
                {group.prState === "none" ? t("branchGroup.openPr", "Open PR") : t("branchGroup.mergeIntoMain", "Merge group into main")}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
