import "./GroupTaskModal.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, CircleDashed, ExternalLink, Loader2, X } from "lucide-react";
import { apiAbandonBranchGroup, apiGetBranchGroup, apiPromoteBranchGroup, type BranchGroupSummary } from "../api";
import { subscribeSse } from "../sse-bus";
import { BRANCH_GROUP_REFRESH_TASK_EVENTS, shouldRefreshBranchGroupForTaskEvent } from "../utils/branchGroupSse";

interface GroupTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  groupId: string | null;
  projectId?: string;
  onOpenMemberTask: (taskId: string) => void;
}

export function GroupTaskModal({ isOpen, onClose, groupId, projectId, onOpenMemberTask }: GroupTaskModalProps) {
  const { t } = useTranslation("app");
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
      setError(loadError instanceof Error ? loadError.message : t("groupTask.errorLoading", "Failed to load branch group"));
    } finally {
      setLoading(false);
    }
  }, [groupId, projectId]);

  const loadGroupRef = useRef(loadGroup);

  useEffect(() => {
    loadGroupRef.current = loadGroup;
  }, [loadGroup]);

  useEffect(() => {
    if (!isOpen || !groupId) return;
    void loadGroup();
  }, [groupId, isOpen, loadGroup]);

  useEffect(() => {
    if (!isOpen || !groupId) return;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const refreshFromCurrentGroup = (event?: MessageEvent) => {
      if (event && !shouldRefreshBranchGroupForTaskEvent(event, projectId)) {
        return;
      }
      void loadGroupRef.current();
    };
    /*
    FNXC:BranchGroupDetails 2026-06-30-18:04:
    The full branch group modal shares task-derived completion state with task details, so it listens to the same lifecycle SSE set while preserving its open/closed guard.
    */
    const events = Object.fromEntries(BRANCH_GROUP_REFRESH_TASK_EVENTS.map((eventName) => [eventName, refreshFromCurrentGroup]));
    return subscribeSse(`/api/events${query}`, {
      events,
      onReconnect: () => refreshFromCurrentGroup(),
    });
  }, [groupId, isOpen, projectId]);

  const completionText = useMemo(() => {
    if (!group) return "";
    return t("groupTask.completionText", "{{landed}} of {{total}} members finished", { landed: group.completion.landed, total: group.completion.total });
  }, [group, t]);

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
      <div className="modal modal-lg group-task-modal" role="dialog" aria-modal="true" aria-label={t("groupTask.ariaLabel", "Branch group details")} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>{t("groupTask.title", "Branch Group {{id}}", { id: groupId })}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("actions.closeModal", "Close modal")}>
            <X />
          </button>
        </div>
        <div className="modal-body group-task-modal-body">
          {loading && (
            <div className="card group-task-modal-state"><Loader2 className="spin" /> {t("groupTask.loading", "Loading branch group…")}</div>
          )}
          {!loading && error && <div className="card group-task-modal-state group-task-modal-error">{error}</div>}
          {!loading && !error && !group && <div className="card group-task-modal-state">{t("groupTask.unavailable", "Branch group unavailable")}</div>}
          {!loading && !error && group && (
            <>
              <section className="card group-task-modal-summary">
                <div className="group-task-modal-summary-row">
                  <span className="group-task-modal-label">{t("groupTask.sharedBranch", "Shared branch")}</span>
                  <strong>{group.branchName}</strong>
                </div>
                <div className="group-task-modal-summary-row">
                  <span className="group-task-modal-label">{t("groupTask.status", "Status")}</span>
                  <span className="badge">{group.status}</span>
                </div>
                <div className="group-task-modal-progress-text">{completionText}</div>
                <div className="branch-group-card-progress" role="progressbar" aria-valuenow={group.completion.landed} aria-valuemin={0} aria-valuemax={group.completion.total}>
                  <span className="branch-group-card-progress-fill" style={{ width: `${completionPercent}%` }} />
                </div>
              </section>

              <section className="card group-task-modal-members-card">
                <h3>{t("groupTask.members", "Members")}</h3>
                <ul className="group-task-modal-members">
                  {group.members.map((member) => (
                    <li key={member.taskId} className="group-task-modal-member">
                      <span className={`status-dot ${member.landed ? "status-dot--online" : "status-dot--pending"}`} />
                      <span className="group-task-modal-member-main">{member.taskId} · {member.title}</span>
                      <span className="badge">{member.column}</span>
                      <span className="group-task-modal-member-status">{member.landed ? <CheckCircle2 /> : <CircleDashed />}</span>
                      <button type="button" className="btn btn-sm" onClick={() => onOpenMemberTask(member.taskId)}>{t("groupTask.openTask", "Open task")}</button>
                    </li>
                  ))}
                </ul>
              </section>

              {group.prUrl && (
                <section className="card group-task-modal-pr">
                  <a className="btn" href={group.prUrl} target="_blank" rel="noreferrer">
                    {t("groups.prLinkLabel", "PR #{{number}} ({{state}})", { number: group.prNumber ?? "—", state: group.prState })} <ExternalLink />
                  </a>
                </section>
              )}

              {(group.prState === "merged" || group.prState === "closed") && (
                <section className="card group-task-modal-actions">
                  <span className="badge">{group.prState === "merged" ? t("groupTask.prMerged", "Group PR merged") : t("groupTask.prClosed", "Group PR closed")}</span>
                </section>
              )}

              {(group.completion.complete || group.prState === "open") && group.prState !== "merged" && group.prState !== "closed" && (
                <section className="card group-task-modal-actions">
                  {/* Promote stays gated on completion; Abandon below is reachable
                      whenever the PR is open, even if completion later reverts. */}
                  {group.completion.complete && (group.autoMerge ? (
                    <span className="badge">{t("groupTask.autoMergeEnabled", "Auto-merge enabled")}</span>
                  ) : (
                    <button type="button" className="btn" onClick={() => void onPromote()} disabled={promoting}>
                      {promoting ? <Loader2 className="spin" /> : null}
                      {group.prState === "none" ? t("groupTask.openPR", "Open PR") : t("groupTask.mergeIntoMain", "Merge group into main")}
                    </button>
                  ))}
                  {group.prState === "open" && (
                    <button type="button" className="btn btn-danger" onClick={() => void onAbandon()} disabled={abandoning}>
                      {abandoning ? <Loader2 className="spin" /> : null}
                      {t("groupTask.abandonGroup", "Abandon group")}
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
