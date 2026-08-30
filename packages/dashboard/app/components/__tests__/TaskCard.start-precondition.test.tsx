import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));

vi.mock("../../api", () => ({
  addressPrFeedback: vi.fn(),
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn(),
  rebuildTaskSpec: vi.fn(),
  refreshPrStatus: vi.fn(),
  fetchBoardWorkflows: vi.fn().mockResolvedValue({ flagEnabled: true, defaultWorkflowId: "wf-test", workflows: [], taskWorkflowIds: {} }),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));

import { TaskCard } from "../TaskCard";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-262",
    title: "Protected Start",
    description: "A manual-intake task",
    column: "ideas",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-08-30T01:00:00.000Z",
    updatedAt: "2026-08-30T01:00:00.000Z",
    ...overrides,
  } as Task;
}

const moveColumns = [
  { id: "ideas", label: "Ideas", flags: { intake: true, manualIntake: true } },
  { id: "todo", label: "Todo", flags: { hold: true } },
];

const initialInnerWidth = window.innerWidth;
const initialMatchMedia = window.matchMedia;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: initialInnerWidth });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: initialMatchMedia });
});

describe("TaskCard Start expected-column precondition", () => {
  it("sends the observed column once and remains disabled until the moved row arrives on mobile", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes("max-width: 768px"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    let resolveMove!: (value: Task) => void;
    const onMoveTask = vi.fn(() => new Promise<Task>((resolve) => { resolveMove = resolve; }));
    const addToast = vi.fn();
    const { rerender } = render(
      <TaskCard
        task={task()}
        onMoveTask={onMoveTask}
        onOpenDetail={vi.fn()}
        addToast={addToast}
        taskColumnFlags={{ intake: true, manualIntake: true }}
        taskMoveColumns={moveColumns}
      />,
    );

    const start = screen.getByTestId("card-start-FN-262");
    fireEvent.click(start);
    fireEvent.click(start);

    expect(onMoveTask).toHaveBeenCalledOnce();
    expect(onMoveTask).toHaveBeenCalledWith("FN-262", "todo", { expectedColumn: "ideas" });
    expect(start).toBeDisabled();

    await act(async () => {
      resolveMove(task({ column: "todo" }));
    });
    expect(start).toBeDisabled();

    rerender(
      <TaskCard
        task={task({ column: "todo" })}
        onMoveTask={onMoveTask}
        onOpenDetail={vi.fn()}
        addToast={addToast}
        taskColumnFlags={{ hold: true }}
        taskMoveColumns={moveColumns}
      />,
    );
    expect(screen.queryByTestId("card-start-FN-262")).toBeNull();
  });

  it("restores Start after a rejected move and surfaces the error", async () => {
    const onMoveTask = vi.fn().mockRejectedValue(new Error("This card already moved on."));
    const addToast = vi.fn();
    render(
      <TaskCard
        task={task()}
        onMoveTask={onMoveTask}
        onOpenDetail={vi.fn()}
        addToast={addToast}
        taskColumnFlags={{ intake: true, manualIntake: true }}
        taskMoveColumns={moveColumns}
      />,
    );

    const start = screen.getByTestId("card-start-FN-262");
    fireEvent.click(start);

    await waitFor(() => expect(addToast).toHaveBeenCalledWith("This card already moved on.", "error"));
    expect(start).not.toBeDisabled();
  });
});
