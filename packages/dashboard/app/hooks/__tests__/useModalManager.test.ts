import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Task, TaskDetail } from "@fusion/core";
import { useModalManager } from "../useModalManager";

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
  });

  it("manages open/close state for basic modals", () => {
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    expect(result.current.newTaskModalOpen).toBe(false);
    expect(result.current.newTaskInitialDescription).toBeNull();
    expect(result.current.anyModalOpen).toBe(false);

    act(() => {
      result.current.openNewTask();
    });

    expect(result.current.newTaskModalOpen).toBe(true);
    expect(result.current.newTaskInitialDescription).toBeNull();
    expect(result.current.anyModalOpen).toBe(true);

    act(() => {
      result.current.closeNewTask();
    });

    expect(result.current.newTaskModalOpen).toBe(false);
    expect(result.current.newTaskInitialDescription).toBeNull();
    expect(result.current.anyModalOpen).toBe(false);
  });

  it("opens the new task modal with a seeded description and resets it on close", () => {
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openNewTaskWithDescription("File: README.md\n\nComment:\nCreate a task");
    });

    expect(result.current.newTaskModalOpen).toBe(true);
    expect(result.current.newTaskInitialDescription).toContain("README.md");

    act(() => {
      result.current.closeNewTask();
    });

    expect(result.current.newTaskModalOpen).toBe(false);
    expect(result.current.newTaskInitialDescription).toBeNull();

    act(() => {
      result.current.openNewTask();
    });

    expect(result.current.newTaskInitialDescription).toBeNull();
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

  it("runScript sets terminalInitialCommand and opens the terminal modal", async () => {
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openScripts();
    });
    expect(result.current.scriptsOpen).toBe(true);
    expect(result.current.terminalOpen).toBe(false);
    expect(result.current.terminalInitialCommand).toBeUndefined();
    expect(result.current.terminalInitialCommandGeneration).toBe(0);

    await act(async () => {
      await result.current.runScript("build", "pnpm build");
    });

    expect(result.current.scriptsOpen).toBe(false);
    expect(result.current.terminalOpen).toBe(true);
    expect(result.current.terminalInitialCommand).toBe("pnpm build");
    expect(result.current.terminalInitialCommandGeneration).toBe(1);

    await act(async () => {
      await result.current.runScript("build", "pnpm build");
    });

    expect(result.current.terminalInitialCommand).toBe("pnpm build");
    expect(result.current.terminalInitialCommandGeneration).toBe(2);
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
    expect(result.current.detailTaskInitialTab).toBe("chat");

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
    expect("prompt" in (result.current.detailTask as unknown as Record<string, unknown>)).toBe(false);
    expect(result.current.detailTaskInitialTab).toBe("chat");
  });

  it.each([
    [undefined, undefined, null],
    ["worktree-FN-X", undefined, null],
    [undefined, "packages/foo/bar.ts", "packages/foo/bar.ts"],
  ])("opens files modal with workspace %s and initial file %s", (workspace, initialFile, expectedInitialFile) => {
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openFiles(workspace, initialFile);
    });

    expect(result.current.filesOpen).toBe(true);
    expect(result.current.fileBrowserInitialFile).toBe(expectedInitialFile);
    expect(result.current.fileBrowserWorkspace).toBe(workspace ?? "project");

    act(() => {
      result.current.closeFiles();
    });

    expect(result.current.filesOpen).toBe(false);
    expect(result.current.fileBrowserInitialFile).toBeNull();
  });

  it("ignores non-string workspace values in openFiles and keeps existing workspace", () => {
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openFiles("FN-123", "packages/dashboard/app/App.tsx");
    });

    act(() => {
      result.current.openFiles({ type: "click" } as unknown as string, { path: "bad" } as unknown as string);
    });

    expect(result.current.fileBrowserWorkspace).toBe("FN-123");
    expect(result.current.fileBrowserInitialFile).toBeNull();
    expect(result.current.filesOpen).toBe(true);
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

  it("does not merge updates targeted at a different task id (FN-5148)", () => {
    const taskA = createTaskDetail("FN-A");
    const taskB = createTaskDetail("FN-B");
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openDetailTask(taskA);
    });

    act(() => {
      result.current.updateDetailTask({
        id: "FN-A",
        githubTracking: {
          enabled: true,
          issue: {
            owner: "o",
            repo: "r",
            number: 1,
            url: "u",
            title: "t",
            state: "open",
          },
        },
      });
    });

    expect(result.current.detailTask?.githubTracking?.enabled).toBe(true);

    act(() => {
      result.current.openDetailTask(taskB);
    });

    act(() => {
      result.current.updateDetailTask({ id: "FN-A", title: "A (late)", githubTracking: { enabled: true } });
    });

    expect(result.current.detailTask?.id).toBe("FN-B");
    expect(result.current.detailTask?.title).toBe("Task FN-B");
  });

  it("still merges detail task patches when no id is provided (FN-5148)", () => {
    const taskB = createTaskDetail("FN-B");
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openDetailTask(taskB);
    });

    act(() => {
      result.current.updateDetailTask({ title: "renamed" });
    });

    expect(result.current.detailTask?.id).toBe("FN-B");
    expect(result.current.detailTask?.title).toBe("renamed");
  });

  it("tracks a target workflow id for normal workflow editor opens and resets it on close", () => {
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openWorkflowEditor(undefined, "WF-selected");
    });

    expect(result.current.workflowEditorOpen).toBe(true);
    expect(result.current.workflowEditorInitialPanel).toBeUndefined();
    expect(result.current.workflowEditorInitialAction).toBeUndefined();
    expect(result.current.workflowEditorInitialWorkflowId).toBe("WF-selected");

    act(() => {
      result.current.closeWorkflowEditor();
    });

    expect(result.current.workflowEditorOpen).toBe(false);
    expect(result.current.workflowEditorInitialWorkflowId).toBeUndefined();
  });

  it("keeps workflow editor settings and create modes distinct from target workflow opens", () => {
    const { result } = renderHook(() =>
      useModalManager({ projectId: "proj_1", planningSessions: [] }),
    );

    act(() => {
      result.current.openWorkflowEditor("settings", "WF-ignored");
    });
    expect(result.current.workflowEditorInitialPanel).toBe("settings");
    expect(result.current.workflowEditorInitialAction).toBeUndefined();
    expect(result.current.workflowEditorInitialWorkflowId).toBeUndefined();

    act(() => {
      result.current.openWorkflowEditor("create", "WF-ignored");
    });
    expect(result.current.workflowEditorInitialPanel).toBeUndefined();
    expect(result.current.workflowEditorInitialAction).toBe("create");
    expect(result.current.workflowEditorInitialWorkflowId).toBeUndefined();
  });
});
