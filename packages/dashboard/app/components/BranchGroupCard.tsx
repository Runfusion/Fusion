import "./BranchGroupCard.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ChevronDown, ChevronRight, CircleDashed, ExternalLink, GitBranch, GitPullRequest, Loader2 } from "lucide-react";
import type { BranchGroupSummary } from "../api";
import { apiAbandonBranchGroup, apiGetBranchGroup, apiPromoteBranchGroup } from "../api";
import { subscribeSse } from "../sse-bus";
import { BRANCH_GROUP_REFRESH_TASK_EVENTS, shouldRefreshBranchGroupForTaskEvent } from "../utils/branchGroupSse";

interface BranchGroupCardProps {
  groupId: string;
  projectId?: string;
}

export function BranchGroupCard({ groupId, projectId }: BranchGroupCardProps) {
  const { t } = useTranslation("app");
  const [group, setGroup] = useState<BranchGroupSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
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
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : t("branchGroup.loadError", "Failed to load branch group");
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

  if (loading) {
    return <div className="card branch-group-card"><Loader2 className="spin" size={14} /> {t("branchGroup.loading", "Loading branch group…")}</div>;
  }

  if (error || !group) {
    return <div className="card branch-group-card branch-group-card-error">{error ?? t("branchGroup.unavailable", "Branch group unavailable")}</div>;
  }

  const completionPercent = group.completion.total > 0
    ? (group.completion.landed / group.completion.total) * 100
    : 0;
  const complete = group.completion.complete;

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
            <button type="button" className="btn" onClick={() => void onPromote()} disabled={promoting}>
              {promoting ? <Loader2 size={14} className="spin" /> : <GitPullRequest size={14} />}
              {t("branchGroup.openPr", "Open PR")}
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => void onPromote()} disabled={promoting}>
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
    </section>
  );
}
