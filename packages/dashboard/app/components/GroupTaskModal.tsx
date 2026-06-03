import "./GroupTaskModal.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleDashed, ExternalLink, Loader2, X } from "lucide-react";
import { apiAbandonBranchGroup, apiGetBranchGroup, apiPromoteBranchGroup, type BranchGroupSummary } from "../api";
import { subscribeSse } from "../sse-bus";

interface GroupTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  groupId: string | null;
  projectId?: string;
  onOpenMemberTask: (taskId: string) => void;
}

export function GroupTaskModal({ isOpen, onClose, groupId, projectId, onOpenMemberTask }: GroupTaskModalProps) {
  const [group, setGroup] = useState<BranchGroupSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadGroup = useCallback(async () => {
    if (!groupId) return;
    setLoading(true);
    try {
      const response = await apiGetBranchGroup(groupId, projectId);
      setGroup(response.group);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load branch group");
    } finally {
      setLoading(false);
    }
  }, [groupId, projectId]);

  useEffect(() => {
    if (!isOpen || !groupId) return;
    void loadGroup();
  }, [groupId, isOpen, loadGroup]);

  useEffect(() => {
    if (!isOpen || !groupId) return;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return subscribeSse(`/api/events${query}`, {
      events: {
        "task:updated": (event) => {
          try {
            const payload = JSON.parse(event.data) as { projectId?: string };
            if (projectId && payload.projectId && payload.projectId !== projectId) {
              return;
            }
          } catch {
            // no-op
          }
          void loadGroup();
        },
      },
      onReconnect: () => {
        void loadGroup();
      },
    });
  }, [groupId, isOpen, loadGroup, projectId]);

  const completionText = useMemo(() => {
    if (!group) return "";
    return `${group.completion.landed} of ${group.completion.total} members finished`;
  }, [group]);

  const completionPercent = useMemo(() => {
    if (!group || group.completion.total <= 0) return 0;
    return (group.completion.landed / group.completion.total) * 100;
  }, [group]);

  const onPromote = useCallback(async () => {
    if (!groupId) return;
    setPromoting(true);
    try {
      await apiPromoteBranchGroup(groupId, projectId);
      await loadGroup();
    } finally {
      setPromoting(false);
    }
  }, [groupId, loadGroup, projectId]);

  const onAbandon = useCallback(async () => {
    if (!groupId) return;
    setAbandoning(true);
    try {
      await apiAbandonBranchGroup(groupId, projectId);
      await loadGroup();
    } finally {
      setAbandoning(false);
    }
  }, [groupId, loadGroup, projectId]);

  if (!isOpen || !groupId) return null;

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div className="modal modal-lg group-task-modal" role="dialog" aria-modal="true" aria-label="Branch group details" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>Branch Group {groupId}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close group modal">
            <X />
          </button>
        </div>
        <div className="modal-body group-task-modal-body">
          {loading && (
            <div className="card group-task-modal-state"><Loader2 className="spin" /> Loading branch group…</div>
          )}
          {!loading && error && <div className="card group-task-modal-state group-task-modal-error">{error}</div>}
          {!loading && !error && !group && <div className="card group-task-modal-state">Branch group unavailable</div>}
          {!loading && !error && group && (
            <>
              <section className="card group-task-modal-summary">
                <div className="group-task-modal-summary-row">
                  <span className="group-task-modal-label">Shared branch</span>
                  <strong>{group.branchName}</strong>
                </div>
                <div className="group-task-modal-summary-row">
                  <span className="group-task-modal-label">Status</span>
                  <span className="badge">{group.status}</span>
                </div>
                <div className="group-task-modal-progress-text">{completionText}</div>
                <div className="branch-group-card-progress" role="progressbar" aria-valuenow={group.completion.landed} aria-valuemin={0} aria-valuemax={group.completion.total}>
                  <span className="branch-group-card-progress-fill" style={{ width: `${completionPercent}%` }} />
                </div>
              </section>

              <section className="card group-task-modal-members-card">
                <h3>Members</h3>
                <ul className="group-task-modal-members">
                  {group.members.map((member) => (
                    <li key={member.taskId} className="group-task-modal-member">
                      <span className={`status-dot ${member.landed ? "status-dot--online" : "status-dot--pending"}`} />
                      <span className="group-task-modal-member-main">{member.taskId} · {member.title}</span>
                      <span className="badge">{member.column}</span>
                      <span className="group-task-modal-member-status">{member.landed ? <CheckCircle2 /> : <CircleDashed />}</span>
                      <button type="button" className="btn btn-sm" onClick={() => onOpenMemberTask(member.taskId)}>Open task</button>
                    </li>
                  ))}
                </ul>
              </section>

              {group.prUrl && (
                <section className="card group-task-modal-pr">
                  <a className="btn" href={group.prUrl} target="_blank" rel="noreferrer">
                    PR #{group.prNumber ?? "—"} ({group.prState}) <ExternalLink />
                  </a>
                </section>
              )}

              {(group.prState === "merged" || group.prState === "closed") && (
                <section className="card group-task-modal-actions">
                  <span className="badge">{group.prState === "merged" ? "Group PR merged" : "Group PR closed"}</span>
                </section>
              )}

              {(group.completion.complete || group.prState === "open") && group.prState !== "merged" && group.prState !== "closed" && (
                <section className="card group-task-modal-actions">
                  {/* Promote stays gated on completion; Abandon below is reachable
                      whenever the PR is open, even if completion later reverts. */}
                  {group.completion.complete && (group.autoMerge ? (
                    <span className="badge">Auto-merge enabled</span>
                  ) : (
                    <button type="button" className="btn" onClick={() => void onPromote()} disabled={promoting}>
                      {promoting ? <Loader2 className="spin" /> : null}
                      {group.prState === "none" ? "Open PR" : "Merge group into main"}
                    </button>
                  ))}
                  {group.prState === "open" && (
                    <button type="button" className="btn btn-danger" onClick={() => void onAbandon()} disabled={abandoning}>
                      {abandoning ? <Loader2 className="spin" /> : null}
                      Abandon group
                    </button>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
