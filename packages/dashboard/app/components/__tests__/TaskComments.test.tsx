import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskComments } from "../TaskComments";

vi.mock("../../api", () => ({
  addComment: vi.fn(),
  addTaskComment: vi.fn(),
  updateTaskComment: vi.fn(),
  deleteTaskComment: vi.fn(),
}));

import { addComment, addTaskComment, updateTaskComment, deleteTaskComment } from "../../api";

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state", () => {
    render(<TaskComments task={makeTask()} addToast={vi.fn()} />);
    expect(screen.getByText("No comments yet.")).toBeTruthy();
  });

  it("adds a user comment via addTaskComment API", async () => {
    const onTaskUpdated = vi.fn();
    vi.mocked(addTaskComment).mockResolvedValue(makeTask({ comments: [{ id: "c1", text: "Hello", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }] }));

    render(<TaskComments task={makeTask()} addToast={vi.fn()} onTaskUpdated={onTaskUpdated} />);
    fireEvent.change(screen.getByPlaceholderText(/Add a comment/), { target: { value: "Hello" } });
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

  // --- New tests for merged steering + user comments ---

  describe("AI Guidance comments", () => {
    it("renders AI Guidance badge for agent-authored comments", () => {
      const task = makeTask({
        comments: [
          { id: "c1", text: "User note", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "c2", text: "Agent guidance", author: "agent", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
      });

      render(<TaskComments task={task} addToast={vi.fn()} />);

      const badges = screen.getAllByTestId("ai-guidance-badge");
      expect(badges.length).toBe(1);
      expect(badges[0].textContent).toBe("AI Guidance");
      // User comment should show author name, not badge
      expect(screen.getByText("user")).toBeTruthy();
    });

    it("renders AI Guidance badge for system-authored comments", () => {
      const task = makeTask({
        comments: [
          { id: "c1", text: "System message", author: "system", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      });

      render(<TaskComments task={task} addToast={vi.fn()} />);

      expect(screen.getByTestId("ai-guidance-badge")).toBeTruthy();
    });

    it("does not show edit/delete buttons for AI Guidance comments", () => {
      const task = makeTask({
        comments: [
          { id: "c1", text: "Agent guidance", author: "agent", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      });

      render(<TaskComments task={task} addToast={vi.fn()} />);

      expect(screen.queryByText("Edit")).toBeNull();
      expect(screen.queryByText("Delete")).toBeNull();
    });

    it("shows edit/delete buttons only for user-authored comments", () => {
      const task = makeTask({
        comments: [
          { id: "c1", text: "User note", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "c2", text: "Agent guidance", author: "agent", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
      });

      render(<TaskComments task={task} addToast={vi.fn()} />);

      // Only one set of edit/delete buttons (for user comment)
      expect(screen.getAllByText("Edit").length).toBe(1);
      expect(screen.getAllByText("Delete").length).toBe(1);
    });
  });

  describe("comment type selector", () => {
    it("shows Comment and AI Guidance type selector buttons", () => {
      render(<TaskComments task={makeTask()} addToast={vi.fn()} />);

      expect(screen.getByText("Comment")).toBeTruthy();
      expect(screen.getByText("AI Guidance")).toBeTruthy();
    });

    it("defaults to Comment type", () => {
      render(<TaskComments task={makeTask()} addToast={vi.fn()} />);

      const commentBtn = screen.getByText("Comment");
      expect(commentBtn.className).toContain("btn-primary");
    });

    it("shows helper text when AI Guidance type is selected", () => {
      render(<TaskComments task={makeTask()} addToast={vi.fn()} />);

      // Click AI Guidance button
      fireEvent.click(screen.getByText("AI Guidance"));

      expect(screen.getByText(/AI Guidance comments are injected into the task execution context/)).toBeTruthy();
    });

    it("uses addComment API when AI Guidance type is selected", async () => {
      vi.mocked(addComment).mockResolvedValue(makeTask({
        comments: [{ id: "c1", text: "Guidance text", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
      }));

      render(<TaskComments task={makeTask()} addToast={vi.fn()} />);

      // Select AI Guidance type
      fireEvent.click(screen.getByText("AI Guidance"));

      // Enter text and submit
      fireEvent.change(screen.getByPlaceholderText(/Add guidance/), { target: { value: "Guidance text" } });
      fireEvent.click(screen.getByText("Add Guidance"));

      await waitFor(() => {
        expect(addComment).toHaveBeenCalledWith("FN-001", "Guidance text");
        expect(addTaskComment).not.toHaveBeenCalled();
      });
    });

    it("uses addTaskComment API when Comment type is selected", async () => {
      vi.mocked(addTaskComment).mockResolvedValue(makeTask({
        comments: [{ id: "c1", text: "User text", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
      }));

      render(<TaskComments task={makeTask()} addToast={vi.fn()} />);

      // Comment type is default
      fireEvent.change(screen.getByPlaceholderText(/Add a comment/), { target: { value: "User text" } });
      fireEvent.click(screen.getByText("Add Comment"));

      await waitFor(() => {
        expect(addTaskComment).toHaveBeenCalledWith("FN-001", "User text", "user");
        expect(addComment).not.toHaveBeenCalled();
      });
    });

    it("changes placeholder text based on selected type", () => {
      render(<TaskComments task={makeTask()} addToast={vi.fn()} />);

      // Default: Comment type
      expect(screen.getByPlaceholderText(/Add a comment/)).toBeTruthy();

      // Switch to AI Guidance
      fireEvent.click(screen.getByText("AI Guidance"));
      expect(screen.getByPlaceholderText(/Add guidance for the AI agent/)).toBeTruthy();
    });

    it("changes submit button label based on selected type", () => {
      render(<TaskComments task={makeTask()} addToast={vi.fn()} />);

      // Default: "Add Comment" button
      expect(screen.getByText("Add Comment")).toBeTruthy();

      // Enable submit
      fireEvent.change(screen.getByPlaceholderText(/Add a comment/), { target: { value: "text" } });

      // Switch to AI Guidance
      fireEvent.click(screen.getByText("AI Guidance"));
      expect(screen.getByText("Add Guidance")).toBeTruthy();
    });
  });

  describe("character count", () => {
    it("shows character count", () => {
      render(<TaskComments task={makeTask()} addToast={vi.fn()} />);

      const textarea = screen.getByPlaceholderText(/Add a comment/);
      fireEvent.change(textarea, { target: { value: "Hello" } });

      expect(screen.getByText("5 / 2000")).toBeTruthy();
    });

    it("disables submit button when text exceeds max length", () => {
      render(<TaskComments task={makeTask()} addToast={vi.fn()} />);

      const textarea = screen.getByPlaceholderText(/Add a comment/);
      fireEvent.change(textarea, { target: { value: "a".repeat(2001) } });

      const button = screen.getByText("Add Comment");
      expect(button.hasAttribute("disabled")).toBe(true);
    });
  });

  describe("keyboard shortcuts", () => {
    it("submits comment on Ctrl+Enter", async () => {
      vi.mocked(addTaskComment).mockResolvedValue(makeTask({
        comments: [{ id: "c1", text: "Keyboard", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
      }));

      render(<TaskComments task={makeTask()} addToast={vi.fn()} />);

      const textarea = screen.getByPlaceholderText(/Add a comment/);
      fireEvent.change(textarea, { target: { value: "Keyboard" } });
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

      await waitFor(() => {
        expect(addTaskComment).toHaveBeenCalledWith("FN-001", "Keyboard", "user");
      });
    });

    it("submits comment on Cmd+Enter", async () => {
      vi.mocked(addTaskComment).mockResolvedValue(makeTask({
        comments: [{ id: "c1", text: "Mac", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
      }));

      render(<TaskComments task={makeTask()} addToast={vi.fn()} />);

      const textarea = screen.getByPlaceholderText(/Add a comment/);
      fireEvent.change(textarea, { target: { value: "Mac" } });
      fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

      await waitFor(() => {
        expect(addTaskComment).toHaveBeenCalledWith("FN-001", "Mac", "user");
      });
    });
  });

  describe("comments display order", () => {
    it("sorts comments newest first", () => {
      const task = makeTask({
        comments: [
          { id: "c1", text: "First comment", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "c2", text: "Second comment", author: "user", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
      });

      render(<TaskComments task={task} addToast={vi.fn()} />);

      const commentTexts = screen.getAllByText(/comment$/);
      expect(commentTexts[0].textContent).toBe("Second comment");
      expect(commentTexts[1].textContent).toBe("First comment");
    });

    it("displays both user and AI guidance comments together", () => {
      const task = makeTask({
        comments: [
          { id: "c1", text: "User comment", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "c2", text: "Agent guidance", author: "agent", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
      });

      render(<TaskComments task={task} addToast={vi.fn()} />);

      expect(screen.getByText("User comment")).toBeTruthy();
      expect(screen.getByText("Agent guidance")).toBeTruthy();
    });
  });
});
