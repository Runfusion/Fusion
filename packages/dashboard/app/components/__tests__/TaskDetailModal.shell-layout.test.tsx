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

  it("conserve le titre dans l’en-tête partagé et le compositeur au footer direct de Chat", () => {
    const view = render(<TaskDetailContent {...sharedProps} embedded onRequestClose={noop} initialTab="planner-chat" />);
    const surface = view.container.querySelector<HTMLElement>(".task-detail-content")!;
    const content = screen.getByTestId("task-detail-tab-content");
    const chatFooter = screen.getByTestId("task-detail-chat-footer");

    expect(surface.querySelector(":scope > .task-detail-chat-footer")).toBe(chatFooter);
    expect(chatFooter.querySelector(".task-planner-chat-composer")).toBeInTheDocument();
    expect(content.querySelector(".task-planner-chat-composer")).toBeNull();
    expect(content.querySelector(".detail-heading-row")).toBeNull();
    expect(content.querySelector(".detail-body-content")).toBeNull();
    expect(surface.querySelector(".modal-header .detail-heading-row h2")).toBeInTheDocument();
    expect(surface.querySelectorAll(".detail-heading-row h2")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(screen.queryByTestId("task-detail-chat-footer")).toBeNull();
    expect(content.querySelector(".detail-heading-row")).toBeNull();
    expect(surface.querySelectorAll(".modal-header .detail-heading-row h2")).toHaveLength(1);
  });

  it("laisse Chat direct même lorsque Définition possède des données globales", () => {
    const task = makeTask({
      id: "FN-355-populated",
      column: "in-progress",
      customFields: { owner: "alice" },
    });
    render(
      <TaskDetailContent
        {...sharedProps}
        task={task}
        embedded
        onRequestClose={noop}
        initialTab="planner-chat"
        workflowFieldDefs={[{ id: "owner", name: "Owner", type: "string", render: { placement: "detail" } }]}
      />,
    );

    const content = screen.getByTestId("task-detail-tab-content");
    const plannerSurface = screen.getByTestId("planner-chat-keep-alive");
    expect(plannerSurface.parentElement).toBe(content);
    expect(content.querySelector(".detail-content, .detail-body-content")).toBeNull();
    expect(screen.queryByTestId("task-fields-section")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(screen.getByTestId("task-fields-section")).toBeInTheDocument();
  });

  it("monte le footer uniquement pour Activity Live, jamais pour Feed", () => {
    render(<TaskDetailContent {...sharedProps} embedded onRequestClose={noop} initialTab="chat" />);
    const content = screen.getByTestId("task-detail-tab-content");
    const liveFooter = screen.getByTestId("task-detail-chat-footer");
    expect(liveFooter.querySelector(".task-chat-composer")).toBeInTheDocument();
    expect(content.querySelector(".task-chat-composer")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Feed" }));
    expect(screen.queryByTestId("task-detail-chat-footer")).toBeNull();
    expect(content.querySelector(".task-chat-composer")).toBeNull();
  });

  it("ouvre le plan intégral puis revient à Définition dans chaque hôte partagé", () => {
    const task = makeTask({ title: "Titre partagé", description: "Description opérateur", prompt: "# Plan intégral\n\nContenu du plan." });
    const hosts = [
      <TaskDetailContent key="content" {...sharedProps} task={task} embedded onRequestClose={noop} />,
      <MainPanelTaskDetailHost key="main" {...sharedProps} task={task} onNavigateToBoard={noop} />,
      <ListSplitTaskDetailHost key="list" {...sharedProps} task={task} onClearSelection={noop} />,
      <RightDockTaskDetailHost key="dock" {...sharedProps} task={task} onCloseDock={noop} />,
      <AppTaskPopoutContent key="popout" {...sharedProps} task={task} onRemoveWindow={noop} />,
    ];

    for (const host of hosts) {
      const view = render(host);
      expect(screen.getByText("Description opérateur")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Read plan" }));
      expectCanonicalShell(view.container, false, false);
      expect(screen.getByTestId("task-detail-plan-full")).toHaveTextContent("Plan intégral");
      expect(screen.queryByText("Description opérateur")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Back to definition" }));
      expectCanonicalShell(view.container);
      expect(screen.getByText("Description opérateur")).toBeInTheDocument();
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
