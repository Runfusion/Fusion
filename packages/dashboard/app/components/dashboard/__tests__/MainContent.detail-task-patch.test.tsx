import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import { MainContent } from "../MainContent";
import type { MainContentProps } from "../types";

vi.mock("../../TaskDetailModal", () => ({
  TaskDetailContent: ({ task, onTaskUpdated }: {
    task: TaskDetail;
    onTaskUpdated?: (patch: Partial<TaskDetail>) => void;
  }) => (
    <section>
      <output data-testid="main-detail-title">{task.title}</output>
      <output data-testid="main-detail-pr">{task.prInfo?.number ?? "none"}</output>
      <button type="button" onClick={() => onTaskUpdated?.({ title: "renamed" })}>Patch without id</button>
      <button type="button" onClick={() => onTaskUpdated?.({ id: "FN-FOREIGN", title: "foreign" })}>Patch foreign id</button>
      <button type="button" onClick={() => onTaskUpdated?.({ ...task, prInfo: { number: 42 } } as Partial<TaskDetail>)}>Patch equal clock</button>
    </section>
  ),
}));

const detailTask = {
  id: "FN-MAIN",
  title: "Original title",
  description: "detail",
  column: "todo",
  status: "pending",
  dependencies: [],
  steps: [],
  log: [],
  createdAt: "2026-08-09T10:00:00.000Z",
  updatedAt: "2026-08-09T10:00:00.000Z",
  columnMovedAt: "2026-08-09T10:00:00.000Z",
} as TaskDetail;

function DetailHost(): JSX.Element {
  const [task, setTask] = useState<TaskDetail>(detailTask);
  const props = {
    taskView: "task-detail",
    mainPanelDetailTask: task,
    setMainPanelDetailTask: setTask,
    tasks: [],
    filteredBoardTasks: [],
    currentProject: { id: "project-1" },
    modalManager: {},
    globalPaused: false,
    t: (key: string, fallback?: string) => fallback ?? key,
    closeTaskDetailMainPanel: vi.fn(),
    popOutTaskDetail: vi.fn(),
    openTaskDetailInMainPanel: vi.fn(),
    moveTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    retryTask: vi.fn(),
    pauseTask: vi.fn(),
    unpauseTask: vi.fn(),
    resetTask: vi.fn(),
    duplicateTask: vi.fn(),
  } as unknown as MainContentProps;
  return <MainContent {...props} />;
}

describe("MainContent local detail task patches", () => {
  it("applies id-less and equal-clock patches but ignores a foreign id", () => {
    render(<DetailHost />);

    fireEvent.click(screen.getByRole("button", { name: "Patch without id" }));
    expect(screen.getByTestId("main-detail-title")).toHaveTextContent("renamed");

    fireEvent.click(screen.getByRole("button", { name: "Patch foreign id" }));
    expect(screen.getByTestId("main-detail-title")).toHaveTextContent("renamed");

    fireEvent.click(screen.getByRole("button", { name: "Patch equal clock" }));
    expect(screen.getByTestId("main-detail-pr")).toHaveTextContent("42");
  });
});
