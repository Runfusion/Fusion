/*
FNXC:HumanPlanApproval 2026-09-15-06:24:
FN-408 — the operator's decision surface for a card that requires human plan validation.

Original requirement (French): "Dans la modale de la tache, cela se présentera sous la forme d'un
input avec 2 boutons : Refuser, Valider." The message field is shared by both decisions: on Reject it
becomes planner feedback ("there is a real problem with this plan"), on Approve it becomes an
implementation note ("just be careful about X"). Both are optional.

Module scope, never declared inside a host render: a component defined in another component's render
is a new element type every render, which would unmount the textarea mid-typing and silently discard
the operator's message (AGENTS.md — "Never Declare a Component Inside Another Component").

The draft lives in the HOST, which also owns the decision handlers.

FNXC:HumanPlanApproval 2026-09-16-05:01:
FN-448 — there is exactly ONE decision surface per card: the Task Detail banner. The former sticky
footer placement rendered this same component a second time, so a card awaiting a human plan decision
showed two "Message (optional)" fields and two Reject/Approve pairs, which operators read as two
different decisions. The `variant` prop is kept (it namespaces the field/error ids and testids) but
admits only `banner`; re-adding a second placement would reintroduce the duplicate.
*/
import { useTranslation } from "react-i18next";
import { UserCheck } from "lucide-react";
import { UiButton } from "./ui";
import "./HumanPlanApprovalControls.css";

export interface HumanPlanApprovalControlsProps {
  taskId: string;
  /** Shared draft, owned by the host so every placement edits one value. */
  message: string;
  onMessageChange: (value: string) => void;
  onApprove: () => void;
  onReject: () => void;
  /** True while a decision request is in flight; both actions are disabled together. */
  pending?: boolean;
  /** Error from the last failed decision. The draft is preserved so nothing is retyped. */
  error?: string | null;
  /** Only the Task Detail banner renders this surface; the value namespaces ids and testids. */
  variant: "banner";
  /** Maximum accepted message length, mirrored from the server contract. */
  maxLength: number;
}

export function HumanPlanApprovalControls({
  taskId,
  message,
  onMessageChange,
  onApprove,
  onReject,
  pending = false,
  error,
  variant,
  maxLength,
}: HumanPlanApprovalControlsProps) {
  const { t } = useTranslation("app");
  const fieldId = `human-plan-approval-message-${variant}-${taskId}`;
  const errorId = `human-plan-approval-error-${variant}-${taskId}`;

  return (
    <div
      className={`human-plan-approval-controls human-plan-approval-controls--${variant}`}
      data-testid={`human-plan-approval-controls-${variant}`}
    >
      <label className="human-plan-approval-controls__label" htmlFor={fieldId}>
        <UserCheck size={14} aria-hidden="true" />
        {t("tasks.humanPlanApproval.messageLabel", "Message (optional)")}
      </label>
      <textarea
        id={fieldId}
        className="input human-plan-approval-controls__input"
        data-testid={`human-plan-approval-message-${variant}`}
        value={message}
        maxLength={maxLength}
        rows={2}
        disabled={pending}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        placeholder={t(
          "tasks.humanPlanApproval.messagePlaceholder",
          "Rejecting? Say what is wrong with the plan. Approving? Add anything to watch out for.",
        )}
        onChange={(event) => onMessageChange(event.target.value)}
      />
      {error && (
        <p className="human-plan-approval-controls__error" id={errorId} role="alert">
          {error}
        </p>
      )}
      <div className="human-plan-approval-controls__actions">
        <UiButton
          type="button"
          className="btn btn-danger btn-sm"
          data-testid={`human-plan-approval-reject-${variant}`}
          disabled={pending}
          onClick={onReject}
        >
          {t("tasks.humanPlanApproval.reject", "Reject")}
        </UiButton>
        <UiButton
          type="button"
          className="btn btn-primary btn-sm"
          data-testid={`human-plan-approval-approve-${variant}`}
          disabled={pending}
          onClick={onApprove}
        >
          {t("tasks.humanPlanApproval.approve", "Approve")}
        </UiButton>
      </div>
      <p className="human-plan-approval-controls__hint">
        {t(
          "tasks.humanPlanApproval.hint",
          "Reject sends your message back for a new plan. Approve starts the work and passes your note to the implementer.",
        )}
      </p>
    </div>
  );
}
