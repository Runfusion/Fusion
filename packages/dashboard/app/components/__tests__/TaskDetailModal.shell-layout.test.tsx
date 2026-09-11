import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  resetTaskDetailFetchMock,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";
import {
  AppTaskPopoutContent,
  ListSplitTaskDetailHost,
  MainPanelTaskDetailHost,
  RightDockTaskDetailHost,
} from "../TaskDetailHostBoundaries";

setupTaskDetailModalHooks();

const sharedProps = {
  task: makeTask({ column: "in-progress" }),
  initialTab: "definition" as const,
  onDeleteTask: noopDelete,
  onMergeTask: noopMerge,
  onOpenDetail: noopOpenDetail,
  addToast: noop,
};

function expectCanonicalShell(container: HTMLElement, footerExpected = false, tabsExpected = true) {
  const surface = container.querySelector<HTMLElement>(".task-detail-content")!;
  const zones = Array.from(surface.children).filter((child) =>
    child.matches(".modal-header, .detail-tabs, .detail-body, .modal-actions"),
  );
  expect(zones.map((zone) => zone.classList.contains("modal-header")
    ? "header"
    : zone.classList.contains("detail-tabs")
      ? "tabs"
      : zone.classList.contains("detail-body")
        ? "content"
        : "footer")).toEqual([
          "header",
          ...(tabsExpected ? ["tabs"] : []),
          "content",
          ...(footerExpected ? ["footer"] : []),
        ]);
  expect(surface.querySelectorAll(":scope > .modal-header")).toHaveLength(1);
  expect(surface.querySelectorAll(":scope > .detail-tabs")).toHaveLength(tabsExpected ? 1 : 0);
  expect(surface.querySelectorAll(":scope > .detail-body")).toHaveLength(1);
}

describe("Task Detail canonical shell", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetTaskDetailFetchMock();
  });

  it("keeps Header → Tabs → Content without an empty footer in every embedded host", () => {
    const hosts = [
      <TaskDetailContent key="content" {...sharedProps} embedded onRequestClose={noop} />,
      <MainPanelTaskDetailHost key="main" {...sharedProps} onNavigateToBoard={noop} />,
      <ListSplitTaskDetailHost key="list" {...sharedProps} onClearSelection={noop} />,
      <RightDockTaskDetailHost key="dock" {...sharedProps} onCloseDock={noop} />,
      <AppTaskPopoutContent key="popout" {...sharedProps} onRemoveWindow={noop} />,
    ];

    for (const host of hosts) {
      const view = render(host);
      expectCanonicalShell(view.container);
      view.unmount();
    }
  });

  it("keeps the edit footer fixed as the final shell zone", () => {
    const view = render(<TaskDetailModal {...sharedProps} task={makeTask({ column: "todo" })} onClose={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit task" }));
    expectCanonicalShell(view.baseElement, true, false);
    expect(screen.getByTestId("task-detail-contextual-footer")).toContainElement(screen.getByRole("button", { name: "Save" }));
  });

  it("keeps the plan-approval footer as the final shell zone", () => {
    const task = makeTask({ column: "todo", status: "awaiting-approval", prompt: "# Plan" });
    const view = render(<TaskDetailContent {...sharedProps} task={task} embedded onRequestClose={noop} />);
    expectCanonicalShell(view.container, true);
    expect(screen.getByTestId("detail-plan-approval-footer-approve")).toBeInTheDocument();
  });
});
