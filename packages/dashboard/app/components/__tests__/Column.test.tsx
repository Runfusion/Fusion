import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Column } from "../Column";
import type { Task, Column as ColumnType } from "@kb/core";

// Mock child components to keep tests focused on the Column badge behavior
vi.mock("../TaskCard", () => ({
  TaskCard: ({ task }: { task: Task }) => <div data-testid={`task-${task.id}`} />,
}));
vi.mock("../WorktreeGroup", () => ({
  WorktreeGroup: () => <div />,
}));
vi.mock("../InlineCreateCard", () => ({
  InlineCreateCard: () => <div />,
}));
vi.mock("lucide-react", () => ({
  Link: () => null,
  Clock: () => null,
}));

function makeTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    column: "triage" as ColumnType,
    status: undefined as any,
    steps: [],
    currentStep: 0,
    dependencies: [],
    description: "",
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const defaultProps = {
  column: "triage" as ColumnType,
  allTasks: [] as Task[],
  maxConcurrent: 2,
  onMoveTask: vi.fn().mockResolvedValue({} as Task),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
};

describe("Column count-flash", () => {
  it("does not apply count-flash class on initial render", () => {
    const tasks = [makeTask("KB-001")];
    render(<Column {...defaultProps} tasks={tasks} />);

    const badge = screen.getByText("1");
    expect(badge.className).toContain("column-count");
    expect(badge.className).not.toContain("count-flash");
  });

  it("applies count-flash class when task count increases", () => {
    const tasks = [makeTask("KB-001")];
    const { rerender } = render(<Column {...defaultProps} tasks={tasks} />);

    const moreTasks = [makeTask("KB-001"), makeTask("KB-002")];
    rerender(<Column {...defaultProps} tasks={moreTasks} />);

    const badge = screen.getByText("2");
    expect(badge.className).toContain("count-flash");
  });

  it("does not apply count-flash class when task count decreases", () => {
    const tasks = [makeTask("KB-001"), makeTask("KB-002")];
    const { rerender } = render(<Column {...defaultProps} tasks={tasks} />);

    const fewerTasks = [makeTask("KB-001")];
    rerender(<Column {...defaultProps} tasks={fewerTasks} />);

    const badge = screen.getByText("1");
    expect(badge.className).not.toContain("count-flash");
  });
});
