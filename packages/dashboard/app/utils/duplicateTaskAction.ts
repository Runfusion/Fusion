import type { TFunction } from "i18next";
import { getErrorMessage, type Task } from "@fusion/core";
import type { BoardWorkflowsPayload } from "../api";
import type { ConfirmChoice, ConfirmOptions, ConfirmResult } from "../hooks/useConfirm";
import type { ToastType } from "../hooks/useToast";
import { resolveDuplicateWorkflowChoices } from "./duplicateWorkflowChoices";

export interface RunDuplicateTaskActionInput {
  taskId: string;
  t: TFunction<"app">;
  addToast: (message: string, type?: ToastType) => void;
  confirmWithSelect: (options: ConfirmOptions) => Promise<ConfirmResult>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  duplicateTask: (id: string, options?: { workflowId?: string }) => Promise<Task>;
  loadBoardWorkflows?: (() => BoardWorkflowsPayload | null | undefined | Promise<BoardWorkflowsPayload | null | undefined>) | null;
}

export async function runDuplicateTaskAction({
  taskId,
  t,
  addToast,
  confirmWithSelect,
  confirm,
  duplicateTask,
  loadBoardWorkflows,
}: RunDuplicateTaskActionInput): Promise<Task | undefined> {
  let payload: BoardWorkflowsPayload | null | undefined;
  try {
    payload = await loadBoardWorkflows?.();
  } catch {
    payload = null;
  }
  const choices = resolveDuplicateWorkflowChoices(payload, taskId);
  const confirmOptions: ConfirmOptions = {
    title: t("taskDetail.duplicate.title", "Duplicate Task"),
    message: t(
      "taskDetail.duplicate.message",
      "Duplicate {{id}}? This will create a new task with the same description and prompt.",
      { id: taskId },
    ),
  };

  let choice: ConfirmChoice = "cancel";
  let workflowId: string | undefined;
  if (choices) {
    const result = await confirmWithSelect({
      ...confirmOptions,
      select: {
        label: t("taskDetail.duplicate.workflowLabel", "Workflow for the copy"),
        options: choices.options.map((option) => ({ value: option.id, label: option.name })),
        defaultValue: choices.currentWorkflowId,
      },
    });
    choice = result.choice;
    workflowId = result.selectValue;
  } else {
    choice = await confirm(confirmOptions) ? "primary" : "cancel";
  }

  if (choice !== "primary") return undefined;

  try {
    const task = await duplicateTask(taskId, workflowId ? { workflowId } : undefined);
    addToast(
      t("taskDetail.duplicate.success", "Duplicated {{id}} → {{newId}}", { id: taskId, newId: task.id }),
      "success",
    );
    return task;
  } catch (error) {
    addToast(getErrorMessage(error), "error");
    return undefined;
  }
}
