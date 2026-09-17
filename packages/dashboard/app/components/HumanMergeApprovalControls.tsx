/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — the operator's DELIVERY decision surface.

Operator requirement, revised 2026-09-17T15:31 ("Au lieu de Approuver Refuser, tu fais Créer Pr,
Merger, Refuser"): ONE shared field and exactly THREE direct buttons, in this order — «Créer PR»,
«Merger», «Refuser». There is deliberately no destination selector, no «Approuver» button, and no
intermediate approval confirmation: each button IS its command.

The field is shared. For the two positive commands it is an optional note kept in the task history;
for a rejection it is a MANDATORY instruction. A change request must go through Reject — a note never
asks for changes.

Keyboard: the field is a textarea and is NOT wrapped in a form, so Enter inserts a newline and can
never implicitly submit «Merger». Keyboard activation therefore only ever reaches the focused button.

Module scope, never declared inside a host render: a component defined in another component's render
is a new element type every render, which would unmount the textarea mid-typing and silently discard
the operator's instruction (AGENTS.md — "Never Declare a Component Inside Another Component").
*/
import { useTranslation } from "react-i18next";
import { GitPullRequest, Lock, XCircle } from "lucide-react";

import { UiButton } from "./ui";
import type { HumanMergeActionCapabilityView, HumanMergeDecisionActionId } from "../api/tasks/task-merge-approval.js";
import "./HumanMergeApprovalControls.css";

export interface HumanMergeApprovalControlsProps {
  taskId: string;
  /** Shared draft, owned by the host so every button reads one value. */
  message: string;
  onMessageChange: (value: string) => void;
  onSubmit: (action: HumanMergeDecisionActionId) => void;
  capabilities: HumanMergeActionCapabilityView[];
  /** The command currently in flight; all three buttons are disabled together while it runs. */
  pendingAction?: HumanMergeDecisionActionId | null;
  /** Error from the last failed command. The draft is preserved so nothing is retyped. */
  error?: string | null;
  /** Link published by a completed create-PR handoff, shown with its manual-handoff state. */
  pullRequestUrl?: string | null;
  /** Correction analysis state after a rejection, so the card is never silent about what it is doing. */
  correctionState?: "analyzing" | "pending" | "failed" | null;
  correctionError?: string | null;
  maxLength: number;
}

/** Stable, translatable explanation of why a specific action cannot be carried out. */
function capabilityReasonKey(reason: string | undefined): { key: string; fallback: string } | null {
  switch (reason) {
    case "github-auth-unavailable":
      return { key: "tasks.humanMergeApproval.reason.githubAuth", fallback: "GitHub is not connected, so a pull request cannot be opened." };
    case "no-remote":
      return { key: "tasks.humanMergeApproval.reason.noRemote", fallback: "This repository has no remote, so a pull request cannot be opened." };
    case "workspace-multi-repository":
      return { key: "tasks.humanMergeApproval.reason.workspace", fallback: "This task spans several repositories, which a single pull request cannot cover." };
    case "content-unavailable":
      return { key: "tasks.humanMergeApproval.reason.content", fallback: "The delivered changes could not be read." };
    case "already-decided":
      return { key: "tasks.humanMergeApproval.reason.decided", fallback: "This delivery was already decided." };
    default:
      return null;
  }
}

export function HumanMergeApprovalControls({
  taskId,
  message,
  onMessageChange,
  onSubmit,
  capabilities,
  pendingAction = null,
  error,
  pullRequestUrl,
  correctionState,
  correctionError,
  maxLength,
}: HumanMergeApprovalControlsProps) {
  const { t } = useTranslation("app");
  const fieldId = `human-merge-approval-message-${taskId}`;
  const errorId = `human-merge-approval-error-${taskId}`;
  const busy = pendingAction !== null;

  /* A rejection requires an instruction; the two positive notes are optional. */
  const rejectBlocked = message.trim().length === 0;

  const capabilityFor = (action: HumanMergeDecisionActionId): HumanMergeActionCapabilityView =>
    capabilities.find((entry) => entry.action === action) ?? { action, enabled: true };

  const renderAction = (
    action: HumanMergeDecisionActionId,
    label: string,
    className: string,
    icon: React.ReactNode,
    extraBlocked = false,
  ) => {
    const capability = capabilityFor(action);
    const reason = capabilityReasonKey(capability.reason);
    const reasonText = reason ? t(reason.key, reason.fallback) : undefined;
    const describedBy = reasonText ? `${fieldId}-${action}-reason` : undefined;
    return (
      <div className="human-merge-approval-controls__action">
        <UiButton
          type="button"
          className={className}
          data-testid={`human-merge-approval-${action}`}
          /* An unavailable action stays VISIBLE and disabled with an accessible reason. */
          disabled={busy || !capability.enabled || extraBlocked}
          aria-describedby={describedBy}
          onClick={() => onSubmit(action)}
        >
          {icon}
          {label}
        </UiButton>
        {reasonText && (
          <p className="human-merge-approval-controls__reason" id={describedBy}>
            {reasonText}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="human-merge-approval-controls" data-testid="human-merge-approval-controls">
      <label className="human-merge-approval-controls__label" htmlFor={fieldId}>
        <Lock size={14} aria-hidden="true" />
        {t("tasks.humanMergeApproval.messageLabel", "Note or rejection instructions")}
      </label>
      <textarea
        id={fieldId}
        className="input human-merge-approval-controls__input"
        data-testid="human-merge-approval-message"
        value={message}
        maxLength={maxLength}
        rows={3}
        disabled={busy}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        placeholder={t(
          "tasks.humanMergeApproval.messagePlaceholder",
          "Optional when creating a pull request or merging. Required when rejecting: say what must change.",
        )}
        onChange={(event) => onMessageChange(event.target.value)}
      />
      {error && (
        <p className="human-merge-approval-controls__error" id={errorId} role="alert">
          {error}
        </p>
      )}

      <div className="human-merge-approval-controls__actions">
        {renderAction(
          "create-pr",
          t("tasks.humanMergeApproval.createPr", "Create PR"),
          "btn btn-sm",
          <GitPullRequest size={14} aria-hidden="true" />,
        )}
        {renderAction(
          "merge",
          t("tasks.humanMergeApproval.merge", "Merge"),
          "btn btn-primary btn-sm",
          <Lock size={14} aria-hidden="true" />,
        )}
        {renderAction(
          "reject",
          t("tasks.humanMergeApproval.reject", "Reject"),
          "btn btn-danger btn-sm",
          <XCircle size={14} aria-hidden="true" />,
          rejectBlocked,
        )}
      </div>

      {rejectBlocked && (
        <p className="human-merge-approval-controls__hint" data-testid="human-merge-approval-reject-hint">
          {t("tasks.humanMergeApproval.rejectRequiresMessage", "Rejecting requires instructions describing what must change.")}
        </p>
      )}

      {pullRequestUrl && (
        <p className="human-merge-approval-controls__pr" data-testid="human-merge-approval-pr-link">
          {t("tasks.humanMergeApproval.prOpened", "A pull request is open and waiting for you:")}{" "}
          <a href={pullRequestUrl} target="_blank" rel="noreferrer">{pullRequestUrl}</a>
        </p>
      )}

      {correctionState && (
        <p
          className={`human-merge-approval-controls__correction${correctionState === "failed" ? " human-merge-approval-controls__correction--failed" : ""}`}
          data-testid="human-merge-approval-correction-state"
          role="status"
        >
          {correctionState === "analyzing"
            ? t("tasks.humanMergeApproval.correctionAnalyzing", "Working out how to correct the rejected delivery…")
            : correctionState === "failed"
              ? correctionError ?? t("tasks.humanMergeApproval.correctionFailed", "The correction could not be prepared. It will be retried.")
              : t("tasks.humanMergeApproval.correctionPending", "Corrections are being prepared for your rejection.")}
        </p>
      )}

      <p className="human-merge-approval-controls__hint">
        {t(
          "tasks.humanMergeApproval.hint",
          "Create PR opens a pull request without merging. Merge delivers the reviewed work now. Reject sends your instructions back for corrections.",
        )}
      </p>
    </div>
  );
}
