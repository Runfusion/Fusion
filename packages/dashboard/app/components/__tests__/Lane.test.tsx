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
vi.mock("../WorktreeGroup", () => ({
  WorktreeGroup: ({ label, kind, activeTasks }: { label: string; kind: string; activeTasks: Task[] }) => (
    <div data-testid="worktree-group" data-label={label} data-kind={kind}>
      {activeTasks.map((task) => <div key={task.id} data-testid={`group-active-${task.id}`}>{task.id}</div>)}
    </div>
  ),
}));
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

  it("forwards workspace tasks through Column's worktree-grouping path", () => {
    const workspaceTask = mkTask({
      id: "FN-9044",
      column: "in-progress",
      workspaceWorktrees: {
        "repo-a": { worktreePath: "/ws/repo-a/.worktrees/FN-9044", branch: "fusion/FN-9044" },
        "repo-b": { worktreePath: "/ws/repo-b/.worktrees/FN-9044", branch: "fusion/FN-9044" },
      },
    });
    render(<Lane {...baseProps()} showWorktreeGrouping tasks={[workspaceTask]} />);

    expect(screen.getByTestId("worktree-group")).toHaveAttribute("data-kind", "workspace");
    expect(screen.getByTestId("worktree-group")).toHaveAttribute("data-label", "FN-9044");
    expect(screen.getByTestId("group-active-FN-9044")).toBeInTheDocument();
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


});

/*
FNXC:TaskDisplaySorting 2026-08-03-22:53:
Lane supplies resolved workflow flags to core's canonical `sortTasksForDisplayColumn`. A renamed hold
lane must retain priority-then-FIFO ordering; otherwise an operator's next task is silently wrong.

The board below is the built-in vocabulary renamed and nothing else, which is why every case above
still passes: `todo` satisfies the legacy default.
*/
const RENAMED_WORKFLOW: BoardWorkflowDefinition = {
  id: "custom:renamed",
  name: "Renamed",
  columns: [
    { id: "drafting", name: "Drafting", flags: { hold: true } },
    { id: "building", name: "Building", flags: { countsTowardWip: true } },
    { id: "checking", name: "Checking", flags: { humanReview: true } },
    { id: "shipped", name: "Shipped", flags: { complete: true } },
  ],
};

describe("Lane on a RENAMED board", () => {
  /* Each case picks inputs where the ROLE order and the generic fallback order DISAGREE. My first
     draft asserted urgent-first, which the generic sort also produces — it passed with the fix
     reverted and proved nothing. */
  function renderedIds() {
    return screen.getAllByTestId(/^task-FN-/).map((node) => node.getAttribute("data-id"));
  }

  it("orders the hold lane by created-at, not task id", () => {
    /* Equal priority: hold order is FIFO by createdAt, the generic fallback is task-id ascending. */
    const tasks = [
      mkTask({ id: "FN-1", column: "drafting", priority: "normal", createdAt: "2024-03-01T00:00:00.000Z" }),
      mkTask({ id: "FN-9", column: "drafting", priority: "normal", createdAt: "2024-01-01T00:00:00.000Z" }),
    ];

    render(<Lane {...baseProps()} workflow={RENAMED_WORKFLOW} tasks={tasks} />);

    expect(renderedIds()).toEqual(["FN-9", "FN-1"]);
  });

  it("orders the complete lane newest-first by completion time", () => {
    /* Complete sorts by columnMovedAt DESC; the generic fallback would put FN-1 first on id. */
    const tasks = [
      mkTask({ id: "FN-1", column: "shipped", priority: "normal", columnMovedAt: "2024-01-01T00:00:00.000Z" }),
      mkTask({ id: "FN-9", column: "shipped", priority: "normal", columnMovedAt: "2024-03-01T00:00:00.000Z" }),
    ];

    render(<Lane {...baseProps()} workflow={RENAMED_WORKFLOW} tasks={tasks} />);

    expect(renderedIds()).toEqual(["FN-9", "FN-1"]);
  });

  it("floats a merging card to the top of the review lane", () => {
    /* The "what is merging right now" ordering; the generic fallback ignores status entirely. */
    const tasks = [
      mkTask({ id: "FN-1", column: "checking", priority: "normal" }),
      mkTask({ id: "FN-9", column: "checking", priority: "normal", status: "merging" }),
    ];

    render(<Lane {...baseProps()} workflow={RENAMED_WORKFLOW} tasks={tasks} />);

    expect(renderedIds()).toEqual(["FN-9", "FN-1"]);
  });
});
