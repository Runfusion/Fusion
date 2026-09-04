import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { fetchBoardWorkflows } from "../../api";
import { TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

function workflowPayload(currentColumn: "todo" | "in-progress") {
  return {
    flagEnabled: true,
    defaultWorkflowId: "builtin:coding",
    workflows: [{
      id: "builtin:coding",
      name: "Coding",
      columns: [
        { id: "ideas", name: "Ideas", flags: { intake: true } },
        { id: "todo", name: "Planning", flags: { hold: true } },
        { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
      ],
    }],
    taskWorkflowIds: { "FN-228": "builtin:coding" },
    currentColumn,
  };
}

function renderDetail(column: "todo" | "in-progress") {
  vi.mocked(fetchBoardWorkflows).mockResolvedValue(workflowPayload(column) as never);
  render(
    <TaskDetailModal
      task={makeTask({
        id: "FN-228",
        column,
        status: "awaiting-approval",
        awaitingApprovalReason: null,
        prompt: "# Reviewed plan",
      })}
      projectId="project-1"
      initialTab="definition"
      onClose={noop}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
    />,
  );
}

describe("TaskDetailModal plan approval planning lane", () => {
  it("renders every plan decision in a resolved hold column", async () => {
    renderDetail("todo");

    await waitFor(() => expect(fetchBoardWorkflows).toHaveBeenCalled());
    expect(screen.getByTestId("detail-plan-approval-banner")).toBeInTheDocument();
    expect(screen.getByTestId("detail-plan-approval-banner-approve")).toBeEnabled();
    expect(screen.getByTestId("detail-plan-approval-banner-reject")).toBeEnabled();
    expect(within(screen.getByTestId("detail-plan-approval-banner-actions")).getAllByRole("button")).toHaveLength(2);
  });

  it("does not render plan decisions in a resolved WIP column", async () => {
    renderDetail("in-progress");

    await waitFor(() => expect(fetchBoardWorkflows).toHaveBeenCalled());
    expect(screen.queryByTestId("detail-plan-approval-banner")).toBeNull();
  });
});
