import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApprovalRequestStatus, MessageMetadata } from "@fusion/core";
import type { ApprovalRequestDetail } from "../api/chat/messaging";
import { decideApproval, fetchApprovalDetail } from "../api";
import { MailboxMessageContent } from "./MailboxMessageContent";
import "./MailboxStructuralItem.css";

export function isStructuralMail(metadata?: MessageMetadata): boolean {
  return metadata?.mailKind === "report" || metadata?.mailKind === "approval";
}

export function MailboxKindBadge({ metadata }: { metadata?: MessageMetadata }) {
  const { t } = useTranslation("app");
  if (!isStructuralMail(metadata)) return null;
  const kind = metadata!.mailKind;
  return <span className={`mailbox-kind-badge mailbox-kind-badge--${kind}`} data-testid="mailbox-kind-badge">{kind === "report" ? t("mailbox.report", "Report") : t("mailbox.approval", "Approval")}</span>;
}

function MailboxApprovalDecision({ approvalRequestId, projectId, addToast, onDecided }: { approvalRequestId?: string; projectId?: string; addToast?: (message: string, type?: "success" | "error") => void; onDecided?: () => void }) {
  const [detail, setDetail] = useState<ApprovalRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [unresolvable, setUnresolvable] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [comment, setComment] = useState("");
  /* FNXC:StructuralMail 2026-08-09-11:33: A decision response may finish after selection or project changes; never overwrite the current approval reference with an old-project response. */
  const currentApprovalTargetRef = useRef({ approvalRequestId, projectId });
  currentApprovalTargetRef.current = { approvalRequestId, projectId };

  useEffect(() => {
    let active = true;
    setDetail(null);
    setComment("");
    if (!approvalRequestId?.trim()) {
      setLoading(false);
      setUnresolvable(true);
      return () => { active = false; };
    }
    setLoading(true);
    setUnresolvable(false);
    void fetchApprovalDetail(approvalRequestId, projectId).then((response) => {
      if (!active) return;
      setDetail(response);
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setUnresolvable(true);
      setLoading(false);
    });
    return () => { active = false; };
  }, [approvalRequestId, projectId]);

  const decide = async (decision: "approve" | "deny") => {
    if (!approvalRequestId || deciding) return;
    setDeciding(true);
    try {
      const response = await decideApproval(approvalRequestId, { decision, comment: comment || undefined }, projectId);
      const currentTarget = currentApprovalTargetRef.current;
      if (currentTarget.approvalRequestId !== approvalRequestId || currentTarget.projectId !== projectId) return;
      setDetail(response);
      setComment("");
      onDecided?.();
    } catch (error) {
      addToast?.(error instanceof Error ? error.message : "Failed to submit decision", "error");
    } finally {
      setDeciding(false);
    }
  };

  if (loading) return <span className="mailbox-approval-loading">Loading approval…</span>;
  if (unresolvable || !detail) return <span className="mailbox-approval-unresolvable" data-testid="mailbox-approval-unresolvable">This approval request is no longer available.</span>;
  const status: ApprovalRequestStatus = detail.status;
  if (status !== "pending") return <span className="mailbox-inline-approval-status" data-testid="mailbox-inline-approval-status">Approval {status}</span>;
  return <div className="mailbox-inline-approval">
    <textarea className="input" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Optional comment" data-testid="mailbox-inline-approval-comment" />
    <div className="mailbox-inline-approval-actions">
      <button type="button" className="btn btn-sm btn-primary" disabled={deciding} onClick={() => void decide("approve")} data-testid="mailbox-inline-approval-approve">Approve</button>
      <button type="button" className="btn btn-sm btn-secondary" disabled={deciding} onClick={() => void decide("deny")} data-testid="mailbox-inline-approval-deny">Deny</button>
    </div>
  </div>;
}

/**
 * FNXC:StructuralMail 2026-08-09-09:09:
 * Mail carries structural reports and ApprovalRequest references, never copied approval snapshots.
 * The approval lifecycle is pending, approved, denied, or completed; an unresolved reference is the
 * terminal-unknown case because there is no expired status. Ordinary mail returns no shell.
 */
export const MailboxStructuralItem = memo(function MailboxStructuralItem({ metadata, projectId, onOpenTask, addToast, onDecided }: { metadata?: MessageMetadata; projectId?: string; onOpenTask?: (taskId: string) => void; addToast?: (message: string, type?: "success" | "error") => void; onDecided?: () => void }) {
  if (!isStructuralMail(metadata)) return null;
  if (metadata!.mailKind === "approval") return <section className="mailbox-structural-approval" data-testid="mailbox-structural-approval"><MailboxApprovalDecision approvalRequestId={metadata!.approvalRequestId} projectId={projectId} addToast={addToast} onDecided={onDecided} /></section>;
  const report = metadata!.report;
  return <section className="mailbox-structural-report" data-testid="mailbox-structural-report">
    {report?.title?.trim() ? <h3>{report.title}</h3> : null}
    {report?.sections.map((section, index) => <div className="mailbox-report-section" data-testid="mailbox-report-section" key={`${section.heading}-${index}`}>
      <h4>{section.heading}</h4>
      <MailboxMessageContent content={section.body} onOpenTask={onOpenTask} testId="mailbox-report-section-body" />
    </div>)}
  </section>;
});
