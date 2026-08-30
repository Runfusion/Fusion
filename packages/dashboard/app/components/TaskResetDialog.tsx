import "./TaskResetDialog.css";

import { getErrorMessage } from "@fusion/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ToastType } from "../hooks/useToast";

export interface TaskResetDialogProps {
  taskId: string;
  initialDescription?: string;
  onReset: (id: string, options?: { description?: string }) => Promise<unknown>;
  addToast: (message: string, type?: ToastType) => void;
  onClose: () => void;
  onResetCompleted?: () => void;
}

/*
FNXC:TaskReset 2026-08-28-16:31:
Reset uses a dedicated dialog because it collects corrected task intent rather than simple agreement. `ConfirmOptions` cannot carry free text, and skip-confirmations would otherwise auto-resolve the destructive action without showing the description. Edited text travels in the options object at argument two to preserve the client transport contract.
*/
export function TaskResetDialog({
  taskId,
  initialDescription,
  onReset,
  addToast,
  onClose,
  onResetCompleted,
}: TaskResetDialogProps) {
  const { t } = useTranslation("app");
  const [description, setDescription] = useState(initialDescription ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const trimmedDescription = description.trim();
  const trimmedInitialDescription = (initialDescription ?? "").trim();
  const titleId = `task-reset-title-${taskId}`;
  const helpId = `task-reset-help-${taskId}`;

  const submit = async () => {
    if (!trimmedDescription || isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (trimmedDescription === trimmedInitialDescription) {
        await onReset(taskId);
      } else {
        await onReset(taskId, { description: trimmedDescription });
      }
      addToast(
        t("taskDetail.reset.resetSuccess", "Reset {{id}} — fresh run will be allocated", { id: taskId }),
        "success",
      );
      onResetCompleted?.();
      onClose();
    } catch (error) {
      setIsSubmitting(false);
      addToast(getErrorMessage(error), "error");
    }
  };

  return (
    <div
      className="modal-overlay open task-reset-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="task-reset-dialog"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div className="modal modal-md task-reset-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h3 id={titleId}>{t("taskDetail.reset.confirmTitle", "Reset this task?")}</h3>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label={t("common.close", "Close")}
          >
            &times;
          </button>
        </div>
        <div className="task-reset-dialog__body">
          <p className="task-reset-dialog__warning">
            {t(
              "taskDetail.reset.confirmMessage",
              "Restart this task from nothing but the original request. Its plan, worktree, branch and commits, and reviews are permanently deleted and cannot be recovered.",
            )}
          </p>
          <label className="task-reset-dialog__label" htmlFor={`task-reset-description-${taskId}`}>
            {t("taskDetail.reset.descriptionLabel", "Original description")}
          </label>
          <textarea
            id={`task-reset-description-${taskId}`}
            className="input task-reset-dialog__textarea"
            data-testid="task-reset-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-describedby={helpId}
            rows={8}
            autoFocus
            disabled={isSubmitting}
          />
          <p
            id={helpId}
            className={trimmedDescription ? "task-reset-dialog__help" : "task-reset-dialog__help task-reset-dialog__help--required"}
          >
            {trimmedDescription
              ? t("taskDetail.reset.descriptionHelp", "Edit the request Fusion will re-plan from, then confirm.")
              : t("taskDetail.reset.descriptionRequired", "A description is required.")}
          </p>
        </div>
        <div className="modal-actions task-reset-dialog__actions">
          <button
            type="button"
            className="btn btn-sm"
            data-testid="task-reset-cancel"
            onClick={onClose}
            disabled={isSubmitting}
          >
            {t("common.cancel", "Cancel")}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            data-testid="task-reset-submit"
            onClick={() => void submit()}
            disabled={!trimmedDescription || isSubmitting}
          >
            {isSubmitting
              ? t("taskDetail.reset.submitting", "Resetting…")
              : t("taskDetail.reset.btn", "Reset")}
          </button>
        </div>
      </div>
    </div>
  );
}
