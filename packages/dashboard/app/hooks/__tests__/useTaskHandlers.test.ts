import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskHandlers } from "../useTaskHandlers";
import type { Task, TaskCreateInput } from "@fusion/core";

const CREATED_TASK: Task = {
  id: "FN-123",
  title: "Test",
  description: "Created task",
  status: "pending",
  column: "triage",
  steps: [],
  dependencies: [],
  log: [],
  attachments: [],
  createdAt: "",
  updatedAt: "",
  size: "M",
  reviewLevel: 0,
};

function createOptions(overrides: Partial<Parameters<typeof useTaskHandlers>[0]> = {}): Parameters<typeof useTaskHandlers>[0] {
  return {
    createTask: vi.fn().mockResolvedValue(CREATED_TASK),
    onPlanningTaskCreated: vi.fn(),
    onPlanningTasksCreated: vi.fn(),
    onSubtaskTasksCreated: vi.fn(),
    addToast: vi.fn(),
    ...overrides,
  };
}

describe("useTaskHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handleBoardQuickCreate calls createTask with triage column and returns task", async () => {
    const options = createOptions();
    const { result } = renderHook(() => useTaskHandlers(options));
    const input: TaskCreateInput = { description: "Do work" };

    let created: Task | null = null;
    await act(async () => {
      created = await result.current.handleBoardQuickCreate(input);
    });

    expect(options.createTask).toHaveBeenCalledWith({ description: "Do work", column: "triage" });
    expect(created).toEqual(CREATED_TASK);
  });

  it("handleModalCreate calls createTask with triage column and returns task", async () => {
    const options = createOptions();
    const { result } = renderHook(() => useTaskHandlers(options));

    let created: Task | null = null;
    await act(async () => {
      created = await result.current.handleModalCreate({ description: "From modal" });
    });

    expect(options.createTask).toHaveBeenCalledWith({ description: "From modal", column: "triage" });
    expect(created).toEqual(CREATED_TASK);
  });

  it("handlePlanningTaskCreated delegates with addToast", () => {
    const options = createOptions();
    const { result } = renderHook(() => useTaskHandlers(options));

    act(() => {
      result.current.handlePlanningTaskCreated(CREATED_TASK);
    });

    expect(options.onPlanningTaskCreated).toHaveBeenCalledWith(CREATED_TASK, options.addToast);
  });

  it("handlePlanningTasksCreated delegates with addToast", () => {
    const options = createOptions();
    const { result } = renderHook(() => useTaskHandlers(options));

    act(() => {
      result.current.handlePlanningTasksCreated([CREATED_TASK]);
    });

    expect(options.onPlanningTasksCreated).toHaveBeenCalledWith([CREATED_TASK], options.addToast);
  });

  it("handleSubtaskTasksCreated delegates with addToast", () => {
    const options = createOptions();
    const { result } = renderHook(() => useTaskHandlers(options));

    act(() => {
      result.current.handleSubtaskTasksCreated([CREATED_TASK]);
    });

    expect(options.onSubtaskTasksCreated).toHaveBeenCalledWith([CREATED_TASK], options.addToast);
  });

  it("handleGitHubImport shows success toast with task ID", () => {
    const options = createOptions();
    const { result } = renderHook(() => useTaskHandlers(options));

    act(() => {
      result.current.handleGitHubImport(CREATED_TASK);
    });

    expect(options.addToast).toHaveBeenCalledWith("Imported FN-123 from GitHub", "success");
  });
});
