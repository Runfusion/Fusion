import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Task, TaskDetail } from "@fusion/core";
import { useModalManager } from "../useModalManager";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchUnreadCount: vi.fn(),
  fetchAgents: vi.fn(),
}));

const mockFetchUnreadCount = vi.mocked(api.fetchUnreadCount);
const mockFetchAgents = vi.mocked(api.fetchAgents);

function createTaskDetail(id: string): TaskDetail {
  return {
    id,
    title: `Task ${id}`,
    description: "desc",
    column: "todo",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    columnMovedAt: new Date().toISOString(),
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    attachments: [],
    size: "M",
    reviewLevel: 1,
    steeringComments: [],
    prompt: "# Task spec",
  } as TaskDetail;
}

function createTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "desc",
    column: "todo",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    columnMovedAt: new Date().toISOString(),
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    attachments: [],
    size: "M",
    reviewLevel: 1,
    steeringComments: [],
  } as Task;
}

describe("useModalManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 3 });
    mockFetchAgents.mockResolvedValue([
      {
        id: "agent-1",
        role: "executor",
        state: "active",
      },
    ] as never);
  });

  it("manages open/close state for basic modals", () => {
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    expect(result.current.newTaskModalOpen).toBe(false);
    expect(result.current.anyModalOpen).toBe(false);

    act(() => {
      result.current.openNewTask();
    });

    expect(result.current.newTaskModalOpen).toBe(true);
    expect(result.current.anyModalOpen).toBe(true);

    act(() => {
      result.current.closeNewTask();
    });

    expect(result.current.newTaskModalOpen).toBe(false);
    expect(result.current.anyModalOpen).toBe(false);
  });

  it("handles planning open, resume, and close lifecycle", () => {
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [{ id: "plan-1" }] }),
    );

    act(() => {
      result.current.openPlanningWithInitialPlan("Build dashboard");
    });

    expect(result.current.isPlanningOpen).toBe(true);
    expect(result.current.planningInitialPlan).toBe("Build dashboard");

    act(() => {
      result.current.closePlanning();
    });

    expect(result.current.isPlanningOpen).toBe(false);
    expect(result.current.planningInitialPlan).toBeNull();
    expect(result.current.planningResumeSessionId).toBeUndefined();

    act(() => {
      result.current.resumePlanning();
    });

    expect(result.current.isPlanningOpen).toBe(true);
    expect(result.current.planningResumeSessionId).toBe("plan-1");
  });

  it("keeps script-to-terminal handoff inside runScript", async () => {
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openScripts();
    });
    expect(result.current.scriptsOpen).toBe(true);

    await act(async () => {
      await result.current.runScript("build", "pnpm build");
    });

    expect(result.current.scriptsOpen).toBe(false);
    expect(result.current.terminalOpen).toBe(true);
    expect(result.current.terminalInitialCommand).toBe("pnpm build");
  });

  it("loads unread count and agents when mailbox opens", async () => {
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openMailbox();
    });

    expect(result.current.mailboxOpen).toBe(true);
    expect(mockFetchUnreadCount).toHaveBeenCalledWith("proj_1");
    expect(mockFetchAgents).toHaveBeenCalledWith(undefined, "proj_1");

    await waitFor(() => {
      expect(result.current.mailboxUnreadCount).toBe(3);
      expect(result.current.mailboxAgents).toHaveLength(1);
    });
  });

  it("tracks detail task state and supports tab-specific opens", () => {
    const task = createTaskDetail("FN-123");
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openDetailTask(task);
    });

    expect(result.current.detailTask?.id).toBe("FN-123");
    expect(result.current.detailTaskInitialTab).toBe("definition");

    act(() => {
      result.current.openDetailWithChangesTab(task);
    });

    expect(result.current.detailTaskInitialTab).toBe("changes");

    act(() => {
      result.current.closeDetailTask();
    });

    expect(result.current.detailTask).toBeNull();
  });

  it("opens settings with an initial section and resets on close", () => {
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openSettings("authentication");
    });

    expect(result.current.settingsOpen).toBe(true);
    expect(result.current.settingsInitialSection).toBe("authentication");

    act(() => {
      result.current.closeSettings();
    });

    expect(result.current.settingsOpen).toBe(false);
    expect(result.current.settingsInitialSection).toBeUndefined();
  });

  it("accepts plain Task object for optimistic modal opening", () => {
    const task = createTask("FN-456");
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openDetailTask(task);
    });

    expect(result.current.detailTask?.id).toBe("FN-456");
    // Should not have prompt field (plain Task)
    expect("prompt" in (result.current.detailTask as Record<string, unknown>)).toBe(false);
    expect(result.current.detailTaskInitialTab).toBe("definition");
  });

  it("accepts plain Task object in openDetailWithChangesTab", () => {
    const task = createTask("FN-789");
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openDetailWithChangesTab(task);
    });

    expect(result.current.detailTask?.id).toBe("FN-789");
    expect(result.current.detailTaskInitialTab).toBe("changes");
  });

  it("holds Task object in detailTask state correctly", () => {
    const task = createTask("FN-100");
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openDetailTask(task);
    });

    // State should hold the Task object with all its fields
    const detailTask = result.current.detailTask;
    expect(detailTask).not.toBeNull();
    expect(detailTask!.id).toBe("FN-100");
    expect(detailTask!.title).toBe("Task FN-100");
    expect(detailTask!.column).toBe("todo");

    // Can be closed and state resets
    act(() => {
      result.current.closeDetailTask();
    });
    expect(result.current.detailTask).toBeNull();
  });
});
