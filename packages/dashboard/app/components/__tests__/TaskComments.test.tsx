import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskComments } from "../TaskComments";

vi.mock("../../api", () => ({
  addTaskComment: vi.fn(),
  updateTaskComment: vi.fn(),
  deleteTaskComment: vi.fn(),
}));

import { addTaskComment, updateTaskComment, deleteTaskComment } from "../../api";

const makeTask = (overrides: any = {}) => ({
  id: "FN-001",
  description: "Task",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("TaskComments", () => {
  it("renders empty state", () => {
    render(<TaskComments task={makeTask()} addToast={vi.fn()} />);
    expect(screen.getByText("No comments yet.")).toBeTruthy();
  });

  it("adds a comment", async () => {
    const onTaskUpdated = vi.fn();
    vi.mocked(addTaskComment).mockResolvedValue(makeTask({ comments: [{ id: "c1", text: "Hello", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }] }));

    render(<TaskComments task={makeTask()} addToast={vi.fn()} onTaskUpdated={onTaskUpdated} />);
    fireEvent.change(screen.getByPlaceholderText("Add a comment"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByText("Add Comment"));

    await waitFor(() => expect(addTaskComment).toHaveBeenCalledWith("FN-001", "Hello", "user"));
    expect(onTaskUpdated).toHaveBeenCalled();
  });

  it("edits own comment", async () => {
    const onTaskUpdated = vi.fn();
    vi.mocked(updateTaskComment).mockResolvedValue(makeTask({ comments: [{ id: "c1", text: "Updated", author: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z" }] }));

    render(<TaskComments task={makeTask({ comments: [{ id: "c1", text: "Original", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }] })} addToast={vi.fn()} onTaskUpdated={onTaskUpdated} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByDisplayValue("Original"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(updateTaskComment).toHaveBeenCalledWith("FN-001", "c1", "Updated"));
    expect(onTaskUpdated).toHaveBeenCalled();
  });

  it("deletes own comment", async () => {
    const onTaskUpdated = vi.fn();
    vi.mocked(deleteTaskComment).mockResolvedValue(makeTask({ comments: [] }));

    render(<TaskComments task={makeTask({ comments: [{ id: "c1", text: "Original", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }] })} addToast={vi.fn()} onTaskUpdated={onTaskUpdated} />);
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(deleteTaskComment).toHaveBeenCalledWith("FN-001", "c1"));
    expect(onTaskUpdated).toHaveBeenCalled();
  });
});
