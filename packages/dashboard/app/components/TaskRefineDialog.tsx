import { ViewHeader } from "./ViewHeader";
import "./TaskRefineDialog.css";
import { UiButton, UiDialogBackdrop, UiTextArea } from "./ui";

import { MAX_TASK_MESSAGE_LENGTH, getErrorMessage } from "@fusion/core";
import type { Task } from "@fusion/core";
import { useCallback, useRef, useState, type HTMLAttributes, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { followUpTask, refineTask } from "../api";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";

import type { ToastType } from "../hooks/useToast";

/*
FNXC:TaskFollowUp 2026-09-17-18:10:
FN-513 reuses this composer for a second question instead of forking a near-identical dialog. The
mode is fixed WHEN THE DIALOG OPENS and never re-derived from live task state: if the source finishes
while the operator is typing, the draft must not silently change what the button does. The SERVER
revalidates at submit and answers 409, which is the honest place for that race.
*/
export type TaskRefineDialogMode = "refine" | "follow-up";

export interface TaskRefineDialogProps {
  taskId: string;
  projectId?: string;
  /** Fixed at open time. Defaults to the historical Refine behavior. */
  mode?: TaskRefineDialogMode;
  addToast: (message: string, type?: ToastType) => void;
  onClose: () => void;
  onRefinementCreated?: (task: Task) => void;
}

/*
FNXC:TaskRefine 2026-09-14-22:23:
FN-400: Refine and Reset must open their own small composer and nothing else. Refine used to be routed through a Task
Detail deep link, so right-clicking a done card mounted the full task record and stacked a painted overlay on top of
it. This standalone dialog is owned directly by the card, the list row, and Task Detail's own Actions menu, so no host
has to open a record to collect feedback.

The overlay layer paints nothing (see TaskRefineDialog.css) and centers the panel exactly in the viewport at every
breakpoint. `UiDialogBackdrop` is the primitive here rather than `UiDialog` because it is the only one accepting
`overlayProps`, which carries the shared default-off backdrop-dismiss contract; `onClose` is handed to the primitive so
Escape closes THIS dialog rather than whatever mounted it.

A single submission ref claims the first valid click synchronously, so two clicks in the same frame cannot issue two
refineTask requests before the disabled pending state renders.
*/
export function TaskRefineDialog({
  taskId,
  projectId,
  mode = "refine",
  addToast,
  onClose,
  onRefinementCreated,
}: TaskRefineDialogProps) {
  const { t } = useTranslation("app");
  const isFollowUp = mode === "follow-up";
  const [feedback, setFeedback] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submissionRef = useRef(false);
  const titleId = `task-refine-title-${taskId}`;
  const dismissProps = useOverlayDismiss(onClose);
  /*
  FNXC:TaskRefine 2026-09-14-22:23:
  `UiDialogBackdrop` needs `onClose` so Escape closes THIS dialog instead of the surface that opened it, but the
  same callback is also fired by its own unconditional backdrop-mousedown branch. That branch would bypass the shared
  default-off dismiss preference, so a press that starts on the overlay marks itself here — `overlayProps.onMouseDown`
  runs first inside the primitive's handler — and the primitive's close is ignored for that event only. Real backdrop
  dismissal stays owned by `useOverlayDismiss`, which requires the press to both start and end on the overlay.
  */
  const backdropPressRef = useRef(false);
  const handlePrimitiveClose = useCallback(() => {
    if (backdropPressRef.current) return;
    onClose();
  }, [onClose]);
  const overlayDismissProps = {
    ...dismissProps,
    onMouseDown: (event: ReactMouseEvent) => {
      backdropPressRef.current = true;
      queueMicrotask(() => {
        backdropPressRef.current = false;
      });
      dismissProps.onMouseDown(event);
    },
  };

  const submit = async () => {
    if (submissionRef.current) return;
    if (!feedback.trim()) {
      addToast(t("taskDetail.refine.feedbackRequired", "Please enter feedback describing what needs refinement"), "error");
      return;
    }
    if (feedback.length > MAX_TASK_MESSAGE_LENGTH) {
      addToast(t("taskDetail.refine.feedbackTooLong", "Feedback must be {{max}} characters or less", { max: MAX_TASK_MESSAGE_LENGTH }), "error");
      return;
    }
    submissionRef.current = true;
    setIsSubmitting(true);
    try {
      /*
      FNXC:TaskFollowUp 2026-09-17-18:10:
      Two endpoints, one composer. Refine keeps its exact historical call; a follow-up posts to its
      own route so the server can apply the narrower admission rule and return a typed refusal.
      */
      const newTask = isFollowUp
        ? await followUpTask(taskId, feedback.trim(), projectId)
        : await refineTask(taskId, feedback.trim(), projectId);
      /*
      FNXC:TaskRefinementBoardVisibility 2026-08-20-20:43:
      The returned child enters shared board state immediately rather than relying on delayed SSE delivery. Its
      server-selected column must remain untouched here.
      */
      onRefinementCreated?.(newTask);
      addToast(
        isFollowUp
          ? t("taskDetail.followUp.taskCreated", "Follow-up task created: {{id}}", { id: newTask.id })
          : t("taskDetail.refine.taskCreated", "Refinement task created: {{id}}", { id: newTask.id }),
        "success",
      );
      onClose();
    } catch (error) {
      /*
      FNXC:TaskFollowUp 2026-09-17-18:10:
      THE DRAFT SURVIVES EVERY FAILURE, including the 409 a source that finished mid-draft produces.
      The operator can correct it, copy it out, or cancel; the composer never retries a creation on
      its own, because a silent retry against a moving source is how a duplicate child appears.
      */
      submissionRef.current = false;
      setIsSubmitting(false);
      addToast(getErrorMessage(error), "error");
    }
  };

  return (
    <UiDialogBackdrop
      overlayClassName="modal-overlay open task-refine-overlay"
      labelledBy={titleId}
      onClose={isSubmitting ? undefined : handlePrimitiveClose}
      overlayProps={overlayDismissProps as unknown as HTMLAttributes<HTMLDivElement>}
    >
      <div className="modal modal-md task-refine-dialog" data-testid="task-refine-dialog">
        {/* FNXC:StandardizedViewLayout 2026-09-13-21:49: Shared dialog chrome; the Close control is the canonical exit. */}
        <ViewHeader
          className="modal-header"
          headingLevel={3}
          titleId={titleId}
          title={isFollowUp ? t("taskDetail.followUp.modalTitle", "Follow-up") : t("taskDetail.refine.modalTitle", "Refine")}
          onClose={onClose}
          closeButtonProps={{ disabled: isSubmitting, "aria-label": t("common.close", "Close") }}
        />
        <div className="task-refine-dialog__body">
          <p className="task-refine-dialog__help">
            {isFollowUp
              ? t("taskDetail.followUp.help", "Describe the follow-up work. A separate task is created and linked to this one, and it is planned from this task's plan and its progress so far.")
              : t("taskDetail.refine.help", "Describe what needs to be refined or improved...")}
          </p>
          <UiTextArea
            className="input task-refine-dialog__textarea"
            data-testid="task-refine-feedback"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder={isFollowUp
              ? t("taskDetail.followUp.placeholder", "Describe the follow-up work here...")
              : t("taskDetail.refine.placeholder", "Enter your feedback here...")}
            rows={6}
            maxLength={MAX_TASK_MESSAGE_LENGTH}
            autoFocus
            disabled={isSubmitting}
          />
          <div className="task-refine-dialog__input-group">
            <div className="task-refine-dialog__char-count">
              {t("taskDetail.refine.charCount", "{{count}}/{{max}} characters", { count: feedback.length, max: MAX_TASK_MESSAGE_LENGTH })}
            </div>
            <UiButton
              type="button"
              className="btn btn-primary btn-sm"
              data-testid="task-refine-submit"
              onClick={() => void submit()}
              disabled={!feedback.trim() || isSubmitting}
            >
              {isSubmitting
                ? t("taskDetail.refine.creating", "Creating...")
                : isFollowUp
                  ? t("taskDetail.followUp.createBtn", "Create Follow-up Task")
                  : t("taskDetail.refine.createBtn", "Create Refinement Task")}
            </UiButton>
          </div>
        </div>
        <div className="modal-actions task-refine-dialog__actions">
          <UiButton
            type="button"
            className="btn btn-sm"
            data-testid="task-refine-cancel"
            onClick={onClose}
            disabled={isSubmitting}
          >
            {t("common.cancel", "Cancel")}
          </UiButton>
        </div>
      </div>
    </UiDialogBackdrop>
  );
}
