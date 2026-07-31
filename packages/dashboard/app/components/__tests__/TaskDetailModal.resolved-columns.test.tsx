import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";
import { fetchBoardWorkflows } from "../../api";
import type { Column } from "@fusion/core";

/*
FNXC:WorkflowResolvedColumns 2026-07-27-15:20 (U10 / R8):
Task Detail is the surface an operator opens when a card looks wrong, so it must describe the
card in the card's OWN workflow vocabulary. Two decisions were keyed on legacy column ids and
therefore silently wrong for a renamed lane: the header column badge (rendered the raw stored id)
and the title/description edit affordance (`EDITABLE_COLUMNS = {triage, todo}` — a renamed
planning lane could not be edited at all, with no error to explain why).
*/

setupTaskDetailModalHooks();

const RENAMED_WORKFLOW = {
  id: "wf-renamed",
  name: "Renamed Flow",
  columns: [
    { id: "backlog", name: "Backlog", flags: { intake: true } },
    { id: "staging", name: "Ready to build", flags: { hold: true } },
    { id: "building", name: "Building", flags: { countsTowardWip: true } },
    { id: "shipped", name: "Shipped", flags: { complete: true } },
  ],
};

function mockRenamedWorkflow(taskId: string) {
  vi.mocked(fetchBoardWorkflows).mockResolvedValue({
    flagEnabled: true,
    defaultWorkflowId: RENAMED_WORKFLOW.id,
    workflows: [RENAMED_WORKFLOW],
    taskWorkflowIds: { [taskId]: RENAMED_WORKFLOW.id },
  } as never);
}

function renderDetail(column: string) {
  return render(
    <TaskDetailModal
      task={makeTask({ id: "FN-099", column: column as Column, title: "Renamed lane card" })}
      onClose={noop}
      onMoveTask={noopMove}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
    />,
  );
}

describe("TaskDetailModal — workflow-resolved columns", () => {
  it("labels the header badge with the workflow's column name, not the stored id", async () => {
    mockRenamedWorkflow("FN-099");
    renderDetail("staging");

    // TaskDetailModal renders through a floating-window portal, so query the document.
    await waitFor(() => {
      expect(document.querySelector(".detail-column-badge")?.textContent).toBe("Ready to build");
    });
  });

  it("still labels the badge for a column the workflow does not declare", async () => {
    mockRenamedWorkflow("FN-099");
    renderDetail("todo");

    await waitFor(() => expect(fetchBoardWorkflows).toHaveBeenCalled());
    // No workflow column to name it: fall back to the shared lifecycle label rather than blank.
    expect(document.querySelector(".detail-column-badge")?.textContent?.trim()).toBe("Todo");
  });

  it("allows editing a card resting in a renamed intake column", async () => {
    mockRenamedWorkflow("FN-099");
    renderDetail("backlog");

    expect(await screen.findByRole("button", { name: "Edit task" })).toBeTruthy();
  });

  it("allows editing a card resting in a renamed hold column", async () => {
    mockRenamedWorkflow("FN-099");
    renderDetail("staging");

    expect(await screen.findByRole("button", { name: "Edit task" })).toBeTruthy();
  });

  it("does not offer editing in a renamed implementation column", async () => {
    mockRenamedWorkflow("FN-099");
    renderDetail("building");

    await waitFor(() => expect(fetchBoardWorkflows).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Edit task" })).toBeNull();
  });

  it("does not offer editing in a renamed complete column", async () => {
    mockRenamedWorkflow("FN-099");
    renderDetail("shipped");

    await waitFor(() => expect(fetchBoardWorkflows).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Edit task" })).toBeNull();
  });

  it("keeps the legacy editable columns editable when no workflow metadata resolves", async () => {
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "",
      workflows: [],
      taskWorkflowIds: {},
    } as never);
    renderDetail("todo");

    expect(await screen.findByRole("button", { name: "Edit task" })).toBeTruthy();
  });
});
