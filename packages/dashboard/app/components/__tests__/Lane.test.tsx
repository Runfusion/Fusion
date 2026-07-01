import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Lane } from "../Lane";
import type { Task } from "@fusion/core";
import type { BoardWorkflowDefinition } from "../../api";

// Keep the test focused on Lane + Column (real) — mock the leaf TaskCard and
// the confirm hook, matching the Column test harness.
vi.mock("../TaskCard", () => ({
  TaskCard: ({ task, onPromote, isPromoting }: { task: Task; onPromote?: (taskId: string) => Promise<void>; isPromoting?: boolean }) => (
    <div data-testid={`task-${task.id}`} data-id={task.id}>
      {onPromote && (
        <button type="button" data-testid={`card-promote-${task.id}`} disabled={isPromoting} onClick={() => void onPromote(task.id)}>
          {isPromoting ? "Promoting…" : "Promote"}
        </button>
      )}
    </div>
  ),
}));
vi.mock("../WorktreeGroup", () => ({ WorktreeGroup: () => <div data-testid="worktree-group" /> }));
vi.mock("../QuickEntryBox", () => ({ QuickEntryBox: () => <div data-testid="quick-entry-box" /> }));
vi.mock("../PluginSlot", () => ({ PluginSlot: () => null }));
vi.mock("lucide-react", () => ({
  Link: () => null,
  Clock: () => null,
  ChevronUp: () => null,
  Archive: () => null,
  MoreVertical: () => null,
  AlertTriangle: () => null,
}));
const mockConfirm = vi.fn();
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: mockConfirm }) }));

const WORKFLOW: BoardWorkflowDefinition = {
  id: "builtin:coding",
  name: "Coding",
  columns: [
    { id: "triage", name: "Triage", flags: { intake: true } },
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
    { id: "in-review", name: "In review", flags: { humanReview: true } },
    { id: "done", name: "Done", flags: { complete: true } },
    { id: "archived", name: "Archived", flags: { archived: true } },
  ],
};

function mkTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: overrides.id,
    description: "d",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

const baseProps = () => ({
  workflow: WORKFLOW,
  tasks: [] as Task[],
  collapsed: false,
  onToggleCollapse: vi.fn(),
  maxConcurrent: 2,
  onMoveTask: vi.fn().mockResolvedValue({} as Task),
  onPromote: vi.fn().mockResolvedValue(undefined),
  canDropTask: vi.fn().mockReturnValue(null),
  getDraggingTaskId: vi.fn().mockReturnValue(null),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
});

beforeEach(() => {
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
});

describe("Lane", () => {
  it("renders the workflow name and total card count in the header", () => {
    render(<Lane {...baseProps()} tasks={[mkTask({ id: "FN-1" }), mkTask({ id: "FN-2", column: "triage" })]} />);
    expect(screen.getByText("Coding")).toBeDefined();
    expect(screen.getByTestId("lane-count-builtin:coding").textContent).toBe("2");
  });

  it("renders its workflow's columns in order, with archived hidden", () => {
    render(<Lane {...baseProps()} />);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    // Lane name is an h2 too; filter to column headings (order preserved).
    expect(headings).toContain("Triage");
    expect(headings).toContain("Todo");
    expect(headings).toContain("In progress");
    expect(headings).toContain("In review");
    expect(headings).toContain("Done");
    // Archived column is hidden.
    expect(headings).not.toContain("Archived");
  });

  it("renders creation controls only in the first visible column", () => {
    render(<Lane {...baseProps()} onQuickCreate={vi.fn()} onNewTask={vi.fn()} />);

    expect(screen.getAllByTestId("quick-entry-box")).toHaveLength(1);
    expect(screen.getAllByText("+ New Task")).toHaveLength(1);
    expect(screen.getByTestId("quick-entry-box").closest("[data-column]")?.getAttribute("data-column")).toBe("triage");
    expect(screen.getByText("+ New Task").closest("[data-column]")?.getAttribute("data-column")).toBe("triage");
  });

  it("collapses the lane (hides columns) when collapsed", () => {
    render(<Lane {...baseProps()} collapsed />);
    expect(screen.queryByText("Triage")).toBeNull();
  });

  it("invokes onToggleCollapse with the workflow id from the lane header", () => {
    const props = baseProps();
    render(<Lane {...props} />);
    fireEvent.click(screen.getByTestId("lane-header-builtin:coding"));
    expect(props.onToggleCollapse).toHaveBeenCalledWith("builtin:coding");
  });

  it("exposes the lane header as the accessible collapse toggle", () => {
    render(<Lane {...baseProps()} />);
    const header = screen.getByRole("button", { name: "Collapse Coding lane" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.getAttribute("tabindex")).toBe("0");
  });

  it("toggles the lane header with Enter and Space", () => {
    const props = baseProps();
    render(<Lane {...props} />);
    const header = screen.getByTestId("lane-header-builtin:coding");

    fireEvent.keyDown(header, { key: "Enter" });
    fireEvent.keyDown(header, { key: " " });

    expect(props.onToggleCollapse).toHaveBeenCalledTimes(2);
    expect(props.onToggleCollapse).toHaveBeenNthCalledWith(1, "builtin:coding");
    expect(props.onToggleCollapse).toHaveBeenNthCalledWith(2, "builtin:coding");
  });

  it("does not render a chevron icon in the lane header", () => {
    render(<Lane {...baseProps()} />);
    expect(screen.getByTestId("lane-header-builtin:coding").querySelector("svg")).toBeNull();
  });

  it("does not render an empty btn-icon toggle in the lane header", () => {
    render(<Lane {...baseProps()} />);
    const header = screen.getByTestId("lane-header-builtin:coding");
    expect(header.querySelector(".btn-icon")).toBeNull();
    expect(screen.queryByTestId("lane-toggle-builtin:coding")).toBeNull();
  });

  it("shows the auto-merge toggle for human-review workflow columns", () => {
    render(<Lane {...baseProps()} autoMerge={false} onToggleAutoMerge={vi.fn()} />);
    expect(screen.getByText("Auto-merge")).toBeDefined();
  });

  it("shows a Promote button on hold-column cards and calls onPromote", async () => {
    const props = baseProps();
    render(<Lane {...props} tasks={[mkTask({ id: "FN-7", column: "todo" })]} />);
    const promoteBtn = screen.getByTestId("card-promote-FN-7");
    expect(promoteBtn).toBeDefined();
    fireEvent.click(promoteBtn);
    await waitFor(() => expect(props.onPromote).toHaveBeenCalledWith("FN-7"));
  });

  it("shows inline capacity-exhausted feedback (not a toast) when promote rejects, then re-enables", async () => {
    const props = baseProps();
    props.onPromote = vi.fn().mockRejectedValue({
      details: { code: "capacity-exhausted", messageKey: "board.rejection.capacityExhausted", retryable: true },
    });
    render(<Lane {...props} tasks={[mkTask({ id: "FN-8", column: "todo" })]} />);
    fireEvent.click(screen.getByTestId("card-promote-FN-8"));
    await waitFor(() => expect(screen.getByTestId("column-inline-feedback")).toBeDefined());
    // No toast was used for the inline capacity feedback.
    expect(props.addToast).not.toHaveBeenCalled();
    // Button re-enabled after the call resolves.
    await waitFor(() => expect((screen.getByTestId("card-promote-FN-8") as HTMLButtonElement).disabled).toBe(false));
  });

  it("prevents the drop (no-move) when canDropTask returns a rejection key", () => {
    const props = baseProps();
    props.getDraggingTaskId = vi.fn().mockReturnValue("FN-DRAG");
    props.canDropTask = vi.fn().mockReturnValue("board.rejection.workflowMismatch");
    render(<Lane {...props} tasks={[mkTask({ id: "FN-1", column: "in-progress" })]} />);
    const ipColumn = document.querySelector('[data-column="in-progress"]') as HTMLElement;
    const preventDefault = vi.fn();
    fireEvent.dragOver(ipColumn, { dataTransfer: { dropEffect: "" }, preventDefault });
    // Rejection → preventDefault NOT called → the browser refuses the drop.
    expect(props.canDropTask).toHaveBeenCalledWith("FN-DRAG", "in-progress", "builtin:coding");
    // Inline feedback surfaces the translated rejection.
    expect(screen.getByTestId("column-inline-feedback")).toBeDefined();
  });

  it("allows the drop (preventDefault) when canDropTask returns null", () => {
    const props = baseProps();
    props.getDraggingTaskId = vi.fn().mockReturnValue("FN-DRAG");
    props.canDropTask = vi.fn().mockReturnValue(null);
    render(<Lane {...props} tasks={[mkTask({ id: "FN-1", column: "in-progress" })]} />);
    const ipColumn = document.querySelector('[data-column="in-progress"]') as HTMLElement;
    // fireEvent.dragOver returns false when a handler called preventDefault.
    const notPrevented = fireEvent.dragOver(ipColumn, { dataTransfer: { dropEffect: "" } });
    expect(notPrevented).toBe(false);
    expect(screen.queryByTestId("column-inline-feedback")).toBeNull();
  });
});
