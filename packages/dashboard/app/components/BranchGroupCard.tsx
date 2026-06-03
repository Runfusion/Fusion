import "./BranchGroupCard.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, CircleDashed, ExternalLink, GitBranch, GitPullRequest, Loader2 } from "lucide-react";
import type { BranchGroupSummary } from "../api";
import { apiAbandonBranchGroup, apiGetBranchGroup, apiPromoteBranchGroup } from "../api";
import { subscribeSse } from "../sse-bus";

interface BranchGroupCardProps {
  groupId: string;
  projectId?: string;
}

export function BranchGroupCard({ groupId, projectId }: BranchGroupCardProps) {
  const [group, setGroup] = useState<BranchGroupSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const loadGroup = useCallback(async () => {
    try {
      const response = await apiGetBranchGroup(groupId, projectId);
      setGroup(response.group);
      setError(null);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Failed to load branch group";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [groupId, projectId]);

  useEffect(() => {
    setLoading(true);
    void loadGroup();
  }, [loadGroup]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mediaQuery = window.matchMedia("(max-width: 768px)");
    const syncCollapsed = (matches: boolean) => {
      setCollapsed(matches);
    };

    syncCollapsed(mediaQuery.matches);
    const onMediaChange = (event: MediaQueryListEvent) => {
      syncCollapsed(event.matches);
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", onMediaChange);
      return () => mediaQuery.removeEventListener("change", onMediaChange);
    }

    mediaQuery.addListener(onMediaChange);
    return () => mediaQuery.removeListener(onMediaChange);
  }, []);

  useEffect(() => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return subscribeSse(`/api/events${query}`, {
      events: {
        "task:updated": () => {
          void loadGroup();
        },
      },
      onReconnect: () => {
        void loadGroup();
      },
    });
  }, [loadGroup, projectId]);

  const completionText = useMemo(() => {
    if (!group) return "";
    return `${group.completion.landed} of ${group.completion.total} members finished`;
  }, [group]);

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
    return <div className="card branch-group-card"><Loader2 className="spin" size={14} /> Loading branch group…</div>;
  }

  if (error || !group) {
    return <div className="card branch-group-card branch-group-card-error">{error ?? "Branch group unavailable"}</div>;
  }

  const completionPercent = group.completion.total > 0
    ? (group.completion.landed / group.completion.total) * 100
    : 0;
  const complete = group.completion.complete;

  return (
    <section className="card branch-group-card">
      <header className="branch-group-card-header">
        <div className="branch-group-card-title">
          <GitBranch size={14} />
          <strong>{group.branchName}</strong>
        </div>
        <div className="branch-group-card-header-meta">
          <span className="badge branch-group-card-badge">Group {group.id}</span>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand branch group" : "Collapse branch group"}
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
              <GitPullRequest size={14} /> PR #{group.prNumber ?? "—"}
              <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}

      {!collapsed && (complete || group.prState === "open") && group.prState !== "merged" && group.prState !== "closed" && (
        <div className="branch-group-card-actions">
          {group.prUrl && (
            <a className="btn" href={group.prUrl} target="_blank" rel="noreferrer">
              <GitPullRequest size={14} /> PR #{group.prNumber ?? "—"}
              <ExternalLink size={12} />
            </a>
          )}
          {/* Promote (Open PR / Merge group) stays gated on completion: a group
              can only be promoted once every member has landed. Abandon below is
              reachable whenever the PR is open, even if completion later reverts. */}
          {complete && (group.autoMerge ? (
            <span className="badge">Auto-merge enabled</span>
          ) : group.prState === "none" ? (
            <button type="button" className="btn" onClick={() => void onPromote()} disabled={promoting}>
              {promoting ? <Loader2 size={14} className="spin" /> : <GitPullRequest size={14} />}
              Open PR
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => void onPromote()} disabled={promoting}>
              {promoting ? <Loader2 size={14} className="spin" /> : <GitPullRequest size={14} />}
              Merge group into main
            </button>
          ))}
          {group.prState === "open" && (
            <button type="button" className="btn btn-danger" onClick={() => void onAbandon()} disabled={abandoning}>
              {abandoning ? <Loader2 size={14} className="spin" /> : null}
              Abandon group
            </button>
          )}
        </div>
      )}
    </section>
  );
}
