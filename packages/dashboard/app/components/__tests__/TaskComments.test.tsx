import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { loadAllAppCssBaseOnly } from "../../test/cssFixture";
import { TaskComments } from "../TaskComments";

vi.mock("../../api", () => ({
  addSteeringComment: vi.fn(),
  updateTaskComment: vi.fn(),
  deleteTaskComment: vi.fn(),
}));

import { addSteeringComment, updateTaskComment, deleteTaskComment } from "../../api";

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

  it("adds a comment via addSteeringComment API", async () => {
    const onTaskUpdated = vi.fn();
    vi.mocked(addSteeringComment).mockResolvedValue(makeTask({ comments: [{ id: "c1", text: "Hello", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }] }));

    render(<TaskComments task={makeTask()} addToast={vi.fn()} onTaskUpdated={onTaskUpdated} />);
    fireEvent.change(screen.getByPlaceholderText(/Add a comment/), { target: { value: "Hello" } });
    fireEvent.click(screen.getByText("Add Comment"));

    await waitFor(() => expect(addSteeringComment).toHaveBeenCalledWith("FN-001", "Hello", undefined));
    expect(onTaskUpdated).toHaveBeenCalled();
  });

  it("edits own comment", async () => {
    const onTaskUpdated = vi.fn();
    vi.mocked(updateTaskComment).mockResolvedValue(makeTask({ comments: [{ id: "c1", text: "Updated", author: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z" }] }));

    render(<TaskComments task={makeTask({ comments: [{ id: "c1", text: "Original", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }] })} addToast={vi.fn()} onTaskUpdated={onTaskUpdated} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByDisplayValue("Original"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(updateTaskComment).toHaveBeenCalledWith("FN-001", "c1", "Updated", undefined));
    expect(onTaskUpdated).toHaveBeenCalled();
  });

  it("deletes own comment", async () => {
    const onTaskUpdated = vi.fn();
    vi.mocked(deleteTaskComment).mockResolvedValue(makeTask({ comments: [] }));

    render(<TaskComments task={makeTask({ comments: [{ id: "c1", text: "Original", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }] })} addToast={vi.fn()} onTaskUpdated={onTaskUpdated} />);
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(deleteTaskComment).toHaveBeenCalledWith("FN-001", "c1", undefined));
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
      vi.mocked(addSteeringComment).mockResolvedValue(makeTask({
        comments: [{ id: "c1", text: "Keyboard", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
      }));

      render(<TaskComments task={makeTask()} addToast={vi.fn()} />);

      const textarea = screen.getByPlaceholderText(/Add a comment/);
      fireEvent.change(textarea, { target: { value: "Keyboard" } });
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

      await waitFor(() => {
        expect(addSteeringComment).toHaveBeenCalledWith("FN-001", "Keyboard", undefined);
      });
    });

    it("submits comment on Cmd+Enter", async () => {
      vi.mocked(addSteeringComment).mockResolvedValue(makeTask({
        comments: [{ id: "c1", text: "Mac", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
      }));

      render(<TaskComments task={makeTask()} addToast={vi.fn()} />);

      const textarea = screen.getByPlaceholderText(/Add a comment/);
      fireEvent.change(textarea, { target: { value: "Mac" } });
      fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

      await waitFor(() => {
        expect(addSteeringComment).toHaveBeenCalledWith("FN-001", "Mac", undefined);
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

  describe("CSS styling", () => {
    const css = loadAllAppCssBaseOnly();

    it.each([
      {
        selector: "comments-textarea",
        assertions: [/\.comments-textarea\s*\{[^}]*background:\s*var\(--surface\);/, /\.comments-textarea\s*\{[^}]*border:\s*var\(--btn-border-width\)\s+solid\s+var\(--border\);/],
      },
      {
        selector: "ai-guidance-badge",
        assertions: [/\.ai-guidance-badge\s*\{[^}]*color:\s*var\(--color-info\);/],
      },
    ])("uses tokenized styles for $selector", ({ assertions }) => {
      for (const assertion of assertions) {
        expect(css).toMatch(assertion);
      }
    });

    it("does not rely on spec-editor-feedback for comment textareas", () => {
      expect(css).toMatch(/\.comments-textarea\s*\{/);
      expect(css).not.toContain(".comments-compose-form .spec-editor-feedback");
      expect(css).not.toContain(".comments-edit-form .spec-editor-feedback");
    });
  });
});
