import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));

vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({
    badgeUpdates: new Map(),
    isConnected: true,
    subscribeToBadge: vi.fn(),
    unsubscribeFromBadge: vi.fn(),
  }),
}));

vi.mock("../../hooks/useBatchBadgeFetch", () => ({
  getFreshBatchData: vi.fn(() => null),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn(), confirmWithSelect: vi.fn() }),
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
  refineTask: vi.fn(),
  fetchBoardWorkflows: vi.fn().mockResolvedValue({ flagEnabled: true, defaultWorkflowId: "wf-a", workflows: [], taskWorkflowIds: {} }),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));

import { TaskCard } from "../TaskCard";
import { refineTask } from "../../api";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Test task",
    column: "done",
    status: "done" as any,
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

const noop = () => {};

/*
FNXC:TaskRefine 2026-09-14-22:23:
FN-400 symptom: right-clicking a done card and choosing Refine opened the whole Task Detail record and stacked the
composer on top of it behind a painted veil. Refine must now open the standalone composer and nothing else, from every
card entry path, on both complete lanes.
*/
describe("TaskCard refine dialog", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(refineTask).mockReset();
  });

  it.each([
    ["done", { column: "done", status: "done" as any }],
    ["in-review", { column: "in-review", status: "review" as any }],
  ])("opens the composer from the %s card context menu without opening the task record", (_name, overrides) => {
    const onOpenDetail = vi.fn();
    render(
      <TaskCard
        task={makeTask(overrides as Partial<Task>)}
        taskColumnFlags={{ complete: true }}
        onOpenDetail={onOpenDetail}
        addToast={noop}
        onDeleteTask={vi.fn()}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

    expect(screen.getByTestId("task-refine-dialog")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter your feedback here...")).toBeInTheDocument();
    expect(onOpenDetail).not.toHaveBeenCalled();

    const overlay = screen.getByTestId("task-refine-dialog").closest("[data-dashboard-window-surface]") as HTMLElement;
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.className).toContain("task-refine-overlay");
    expect(overlay.className).not.toContain("detail-refine-overlay");
    expect(overlay.style.background).toBe("");
  });

  it("reports a created refinement upward and closes without touching the task record", async () => {
    const created = { id: "FN-002", column: "todo" };
    vi.mocked(refineTask).mockResolvedValue(created as never);
    const onOpenDetail = vi.fn();
    const onRefinementCreated = vi.fn();
    render(
      <TaskCard
        task={makeTask()}
        projectId="p1"
        onOpenDetail={onOpenDetail}
        onRefinementCreated={onRefinementCreated}
        addToast={noop}
        onDeleteTask={vi.fn()}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));
    fireEvent.change(screen.getByPlaceholderText("Enter your feedback here..."), { target: { value: "tighten the copy" } });
    fireEvent.click(screen.getByTestId("task-refine-submit"));

    await waitFor(() => expect(refineTask).toHaveBeenCalledWith("FN-001", "tighten the copy", "p1"));
    expect(onRefinementCreated).toHaveBeenCalledWith(created);
    await waitFor(() => expect(screen.queryByTestId("task-refine-dialog")).not.toBeInTheDocument());
    expect(onOpenDetail).not.toHaveBeenCalled();
  });
});
