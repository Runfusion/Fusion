import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Column as ColumnType, Task } from "@fusion/core";
import { loadComponentCss } from "../../test/cssFixture";
import { Column } from "../Column";

vi.mock("../TaskCard", () => ({
  TaskCard: React.memo(({ task }: { task: Task }) => (
    <div className={task.status === "editing" ? "card card-editing" : "card"} data-testid={`task-${task.id}`}>
      <span data-testid={`task-text-${task.id}`}>{task.title}</span>
    </div>
  )),
}));

vi.mock("../WorktreeGroup", () => ({
  WorktreeGroup: ({ label, kind, activeTasks, queuedTasks }: { label: string; kind: string; activeTasks: Task[]; queuedTasks: Task[] }) => (
    <div data-testid="worktree-group" data-label={label} data-kind={kind} data-active-count={activeTasks.length} data-queued-count={queuedTasks.length}>
      <span>{label}</span>
    </div>
  ),
}));

vi.mock("../QuickEntryBox", () => ({
  QuickEntryBox: () => <textarea aria-label="Quick create task" />,
}));

vi.mock("../../hooks/usePluginUiSlots", () => ({
  usePluginUiSlots: () => ({ slots: [], getSlotsForId: () => [], loading: false, error: null }),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn() }),
}));

vi.mock("lucide-react", () => ({
  ChevronDown: () => null,
  ChevronUp: () => null,
  MoreVertical: () => null,
}));

function selectorFor(selectorFragment: string): string {
  const pattern = /([^{}]+)\{[\s\S]*?\}/g;
  const rule = [...loadComponentCss("Board.css").matchAll(pattern)].find((match) => match[1].includes(selectorFragment));

  expect(rule).toBeDefined();
  return rule![1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
}

const suppressionSelector = selectorFor(".board *");
const editableOptInSelector = selectorFor(".board :is(");

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "Board selection test task",
    column: "todo" as ColumnType,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  } as Task;
}

const defaultProps = {
  column: "todo" as ColumnType,
  tasks: [] as Task[],
  maxConcurrent: 2,
  showWorktreeGrouping: false,
  workflowMode: true,
  workflowId: "builtin:coding",
  columnDisplayName: "Todo",
  columnDescription: "Tasks ready to start",
  onMoveTask: vi.fn().mockResolvedValue({} as Task),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
};

function renderBoardColumn(overrides: Partial<React.ComponentProps<typeof Column>> = {}) {
  const board = document.createElement("main");
  board.className = "board board-workflow-columns";
  document.body.append(board);

  return render(<Column {...defaultProps} {...overrides} />, { container: board });
}

function expectSuppressed(element: Element): void {
  expect(element.matches(suppressionSelector)).toBe(true);
  expect(element.matches(editableOptInSelector)).toBe(false);
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("Board text-selection selector bindings (FN-194)", () => {
  it("binds the shipped suppression selector to the plain empty-column label", () => {
    renderBoardColumn();

    expectSuppressed(screen.getByText("No tasks"));
  });

  it("binds the shipped suppression selector to the worktree-grouped empty-column label", () => {
    renderBoardColumn({ showWorktreeGrouping: true });

    expectSuppressed(screen.getByText("No tasks"));
  });

  it("binds the shipped suppression selector to every visible column-chrome surface", () => {
    renderBoardColumn();

    expectSuppressed(screen.getByRole("heading", { name: "Todo", level: 2 }));
    expectSuppressed(document.querySelector(".column-count")!);
    expectSuppressed(document.querySelector(".column-desc")!);
  });

  it("preserves selectable quick-create and inline-card editing descendants", () => {
    renderBoardColumn({
      onQuickCreate: vi.fn().mockResolvedValue(undefined),
      tasks: [makeTask("FN-editing", { status: "editing" as never })],
    });

    const textarea = screen.getByLabelText("Quick create task");
    const editingText = screen.getByTestId("task-text-FN-editing");

    expect(textarea.matches(editableOptInSelector)).toBe(true);
    expect(editingText.matches(editableOptInSelector)).toBe(true);
  });

  it("does not leak suppression to matching elements outside the board", () => {
    renderBoardColumn();
    const outsideBoard = document.createElement("div");
    outsideBoard.className = "empty-column";
    outsideBoard.textContent = "No tasks outside board";
    document.body.append(outsideBoard);

    expect(outsideBoard.matches(suppressionSelector)).toBe(false);
  });
});
