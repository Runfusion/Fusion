import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { type ComponentProps } from "react";
import type { AgentLogEntry } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";
import { useAgentLogs } from "../../hooks/useAgentLogs";

setupTaskDetailModalHooks();

const mockedUseAgentLogs = vi.mocked(useAgentLogs);

function renderModal(props: Partial<ComponentProps<typeof TaskDetailModal>> = {}) {
  return render(
    <TaskDetailModal
      task={makeTask({
        id: "FN-7315",
        column: "in-progress" as any,
        log: [
          { timestamp: "2026-06-30T20:00:00.000Z", action: "Started work", outcome: "Executor checked out" },
          { timestamp: "2026-06-30T20:01:00.000Z", action: "Posted update" },
        ],
        steeringComments: [
          { id: "steer-existing", text: "Existing steering guidance", author: "user", createdAt: "2026-06-30T20:02:00.000Z" },
        ],
      })}
      onClose={noop}
      onMoveTask={noopMove}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
      {...props}
    />,
  );
}

function topLevelTabLabels(): string[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".detail-tabs .detail-tab"))
    .map((button) => button.textContent?.trim() ?? "");
}

type ActivitySegmentTestValue = "current" | "feed" | "raw-logs";

const ACTIVITY_VIEW_LABELS: Record<ActivitySegmentTestValue, string> = {
  current: "Live",
  feed: "Feed",
  "raw-logs": "Raw",
};

function openActivityViewMenu() {
  const existingMenu = screen.queryByRole("menu", { name: "Activity views" });
  if (!existingMenu) {
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
  }
  return screen.getByRole("menu", { name: "Activity views" });
}

function activityViewLabels(): string[] {
  openActivityViewMenu();
  return screen.getAllByRole("menuitem").map((option) => option.textContent?.trim() ?? "");
}

function expectActivityView(value: ActivitySegmentTestValue) {
  openActivityViewMenu();
  expect(screen.getByRole("menuitem", { name: ACTIVITY_VIEW_LABELS[value] })).toHaveAttribute("aria-current", "true");
}

function selectActivityView(value: ActivitySegmentTestValue) {
  openActivityViewMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: ACTIVITY_VIEW_LABELS[value] }));
}

function mockRawLogs(entries: AgentLogEntry[]) {
  mockedUseAgentLogs.mockReturnValue({
    entries,
    loading: false,
    clear: vi.fn(),
    loadMore: vi.fn(async () => {}),
    hasMore: false,
    total: entries.length,
    loadingMore: false,
  });
}

describe("TaskDetailModal Activity and planner Chat tab integration", () => {
  it("defaults to Activity first while selecting Live, Feed, and Raw without duplicate panels on desktop", async () => {
    const user = userEvent.setup();
    mockRawLogs([
      { timestamp: "2026-06-30T20:03:00.000Z", taskId: "FN-7315", type: "text", agent: "executor", text: "raw executor line" },
    ] as AgentLogEntry[]);

    renderModal();

    expect(topLevelTabLabels().slice(0, 2)).toEqual(["Activity", "Chat"]);
    expect(screen.getAllByRole("button", { name: "Chat" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");
    expect(screen.queryByTestId("task-planner-chat-panel")).not.toBeInTheDocument();
    expect(activityViewLabels()).toEqual(["Live", "Feed", "Raw"]);
    expectActivityView("current");
    expect(document.querySelector(".activity-view-select")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Activity view" })).not.toBeInTheDocument();
    expect(document.querySelector(".activity-segmented-control")).toBeNull();
    expect(document.querySelector(".activity-segment")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Activity views" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("form", { name: "Task activity composer" })).toHaveLength(1);
    expect(screen.queryByText(/^Steering comment$/)).not.toBeInTheDocument();
    expect(screen.queryByText("Send operational guidance to the active task through steering comments.")).not.toBeInTheDocument();
    expect(screen.getByText("Existing steering guidance")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Feed" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-log-viewer")).not.toBeInTheDocument();

    selectActivityView("feed");

    expectActivityView("feed");
    expect(screen.queryByRole("form", { name: "Task activity composer" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Feed" })).toBeInTheDocument();
    expect(screen.getByText("Posted update")).toBeInTheDocument();
    expect(screen.queryByText("Existing steering guidance")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-log-viewer")).not.toBeInTheDocument();

    selectActivityView("raw-logs");

    expectActivityView("raw-logs");
    expect(screen.queryByRole("form", { name: "Task activity composer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Feed" })).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-log-viewer")).toBeInTheDocument();
    expect(screen.getByText("raw executor line")).toBeInTheDocument();
  });

  it("restores Chat-first ordering and omitted non-done default when the project setting is enabled", () => {
    mockRawLogs([]);

    renderModal({ taskDetailChatFirst: true });

    expect(topLevelTabLabels().slice(0, 2)).toEqual(["Chat", "Activity"]);
    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass("detail-tab-active");
    expect(screen.getByTestId("task-planner-chat-panel")).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Activity views" })).not.toBeInTheDocument();
  });

  it("keeps explicit Activity, planner Chat, and Logs deep links stable across the ordering setting", () => {
    mockRawLogs([]);

    const { rerender } = renderModal({ initialTab: "chat", taskDetailChatFirst: true });

    expect(topLevelTabLabels().slice(0, 2)).toEqual(["Chat", "Activity"]);
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");
    expectActivityView("current");
    expect(screen.queryByTestId("task-planner-chat-panel")).not.toBeInTheDocument();

    rerender(
      <TaskDetailModal
        task={makeTask({ id: "FN-7315", column: "in-progress" as any, log: [], steeringComments: [] })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
        initialTab="planner-chat"
        taskDetailChatFirst={false}
      />,
    );

    expect(topLevelTabLabels().slice(0, 2)).toEqual(["Activity", "Chat"]);
    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass("detail-tab-active");
    expect(screen.getByTestId("task-planner-chat-panel")).toBeInTheDocument();

    rerender(
      <TaskDetailModal
        task={makeTask({ id: "FN-7315", column: "in-progress" as any, log: [{ timestamp: "2026-06-30T20:01:00.000Z", action: "Posted update" }], steeringComments: [] })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
        initialTab="logs"
        taskDetailChatFirst={true}
      />,
    );

    expect(topLevelTabLabels().slice(0, 2)).toEqual(["Chat", "Activity"]);
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");
    expectActivityView("feed");
    expect(screen.getByRole("heading", { name: "Feed" })).toBeInTheDocument();
  });

  it("preserves Summary as the done-task mobile default while Activity and Chat remain first", async () => {
    const user = userEvent.setup();
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    try {
      mockRawLogs([]);
      render(
        <TaskDetailContent
          task={makeTask({ id: "FN-7315-DONE", column: "done" as any, log: [], steeringComments: [] })}
          embedded
          onRequestClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(topLevelTabLabels().slice(0, 3)).toEqual(["Activity", "Chat", "Summary"]);
      expect(screen.getByRole("button", { name: "Summary" })).toHaveClass("detail-tab-active");
      expect(screen.queryByRole("combobox", { name: "Activity view" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Activity" }));
      expect(activityViewLabels()).toEqual(["Live", "Feed", "Raw"]);
      expect(screen.queryByRole("tablist", { name: "Activity views" })).not.toBeInTheDocument();
      expect(screen.getByText("No agent output yet. Live messages from Planner, Executor, Reviewer, and Merger agents will appear here.")).toBeInTheDocument();
      expect(screen.getAllByRole("form", { name: "Task refinement composer" })).toHaveLength(1);
      expect(screen.queryByRole("form", { name: "Refinement request" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Chat" }));
      expect(screen.getByRole("button", { name: "Chat" })).toHaveClass("detail-tab-active");
      expect(screen.getByTestId("task-planner-chat-panel")).toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Task activity composer" })).not.toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Task refinement composer" })).not.toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Steering comment" })).not.toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Refinement request" })).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
      window.dispatchEvent(new Event("resize"));
    }
  });
});
