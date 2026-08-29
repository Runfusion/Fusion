import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useModalManager } from "../../hooks/useModalManager";
import {
  ALL_WORKFLOWS_BOARD_VIEW_ID,
  BOARD_WORKFLOW_SELECTION_STORAGE_KEY,
} from "../../utils/boardWorkflowSelection";
import { scopedKey } from "../../utils/projectStorage";

const projectId = "new-task-workflow-project";
const selectedWorkflowId = "workflow-ideas";
const selectionKey = scopedKey(BOARD_WORKFLOW_SELECTION_STORAGE_KEY, projectId);

describe("New Task dialog selected-workflow inheritance", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("preserves the selected workflow across board, list, sidebar, shortcut, and description opens", () => {
    localStorage.setItem(selectionKey, selectedWorkflowId);
    const { result } = renderHook(() => useModalManager({ projectId, planningSessions: [] }));

    const surfaces: Array<[string, () => void]> = [
      ["board lane", () => result.current.openNewTask(selectedWorkflowId)],
      ["list", () => result.current.openNewTask(selectedWorkflowId)],
      ["sidebar CTA", () => result.current.openNewTask()],
      ["keyboard shortcut", () => result.current.openNewTask()],
      ["description-seeded", () => result.current.openNewTaskWithDescription("Create from selection")],
    ];

    for (const [, open] of surfaces) {
      act(open);
      expect(result.current.newTaskInitialWorkflowId).toBe(selectedWorkflowId);
      act(() => result.current.closeNewTask());
    }
  });

  it("does not forward the aggregate board sentinel into the dialog", () => {
    localStorage.setItem(selectionKey, ALL_WORKFLOWS_BOARD_VIEW_ID);
    const { result } = renderHook(() => useModalManager({ projectId, planningSessions: [] }));

    act(() => result.current.openNewTask());

    expect(result.current.newTaskInitialWorkflowId).toBeUndefined();
  });
});
