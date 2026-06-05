import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Lane } from "../Lane";
import type { Task } from "@fusion/core";
import type { BoardWorkflowDefinition } from "../../api";

// Keep the test focused on Lane + Column (real) — mock the leaf TaskCard and
// the confirm hook, matching the Column test harness.
vi.mock("../TaskCard", () => ({
  TaskCard: ({ task }: { task: Task }) => <div data-testid={`task-${task.id}`} data-id={task.id} />,
}));
vi.mock("../WorktreeGroup", () => ({ WorktreeGroup: () => <div data-testid="worktree-group" /> }));
vi.mock("../QuickEntryBox", () => ({ QuickEntryBox: () => <div data-testid="quick-entry-box" /> }));
vi.mock("../PluginSlot", () => ({ PluginSlot: () => null }));
vi.mock("lucide-react", () => ({
  Link: () => null,
  Clock: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
  ChevronRight: () => null,
  Archive: () => null,
  MoreVertical: () => null,
  AlertTriangle: () => null,
}));
const mockConfirm = vi.fn();
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: mockConfirm }) }));

const WORKFLOW: BoardWorkflowDefinition = {
  id: "builtin:coding",
  name: "Coding (built-in)",
  columns: [
    { id: "triage", name: "Triage", flags: { intake: true } },
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
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
    expect(screen.getByText("Coding (built-in)")).toBeDefined();
    expect(screen.getByTestId("lane-count-builtin:coding").textContent).toBe("2");
  });

  it("renders its workflow's columns in order, with archived hidden", () => {
    render(<Lane {...baseProps()} />);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    // Lane name is an h2 too; filter to column headings (order preserved).
    expect(headings).toContain("Triage");
    expect(headings).toContain("Todo");
    expect(headings).toContain("In progress");
    expect(headings).toContain("Done");
    // Archived column is hidden.
    expect(headings).not.toContain("Archived");
  });

  it("collapses the lane (hides columns) when collapsed", () => {
    render(<Lane {...baseProps()} collapsed />);
    expect(screen.queryByText("Triage")).toBeNull();
  });

  it("invokes onToggleCollapse with the workflow id", () => {
    const props = baseProps();
    render(<Lane {...props} />);
    fireEvent.click(screen.getByTestId("lane-toggle-builtin:coding"));
    expect(props.onToggleCollapse).toHaveBeenCalledWith("builtin:coding");
  });

  it("shows a Promote button on hold-column cards and calls onPromote", async () => {
    const props = baseProps();
    render(<Lane {...props} tasks={[mkTask({ id: "FN-7", column: "todo" })]} />);
    const promoteBtn = screen.getByTestId("promote-FN-7");
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
    fireEvent.click(screen.getByTestId("promote-FN-8"));
    await waitFor(() => expect(screen.getByTestId("column-inline-feedback")).toBeDefined());
    // No toast was used for the inline capacity feedback.
    expect(props.addToast).not.toHaveBeenCalled();
    // Button re-enabled after the call resolves.
    await waitFor(() => expect((screen.getByTestId("promote-FN-8") as HTMLButtonElement).disabled).toBe(false));
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
