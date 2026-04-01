import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:readline/promises before importing
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(),
}));

// Mock @fusion/core before importing
vi.mock("@fusion/core", () => ({
  TaskStore: vi.fn(),
  COLUMNS: ["triage", "todo", "in-progress", "in-review", "done", "archived"],
  COLUMN_LABELS: {
    triage: "Triage",
    todo: "Todo",
    "in-progress": "In Progress",
    "in-review": "In Review",
    done: "Done",
    archived: "Archived",
  },
}));

// Import after mocking
import { createInterface } from "node:readline/promises";
import { TaskStore } from "@fusion/core";
import { runTaskSteer } from "../commands/task.js";

describe("runTaskSteer", () => {
  let mockConsoleLog: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;
  const mockQuestion = vi.fn();
  const mockClose = vi.fn();
  const mockAddComment = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockQuestion.mockReset();
    (createInterface as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      question: mockQuestion,
      close: mockClose,
    });
  });

  afterEach(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
  });

  function setupTaskStoreMock(overrides: Record<string, unknown> = {}) {
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      addComment: mockAddComment,
      ...overrides,
    }));
  }

  it("adds steering comment with message argument", async () => {
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-001",
      title: "Test Task",
    });

    await runTaskSteer("FN-001", "Focus on error handling");

    expect(mockAddComment).toHaveBeenCalledWith("FN-001", "Focus on error handling", "user");
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Steering comment added to FN-001")
    );
  });

  it("reads message from stdin when not provided as argument", async () => {
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-002",
      title: "Another Task",
    });

    mockQuestion.mockResolvedValueOnce("This is a steering comment from stdin");

    await runTaskSteer("FN-002", undefined);

    expect(mockQuestion).toHaveBeenCalledWith("Message: ");
    expect(mockAddComment).toHaveBeenCalledWith("FN-002", "This is a steering comment from stdin", "user");
    expect(mockClose).toHaveBeenCalled();
  });

  it("rejects messages longer than 2000 characters", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    const longMessage = "a".repeat(2001);

    await expect(runTaskSteer("FN-003", longMessage)).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Message must be between 1 and 2000 characters")
    );
    expect(mockAddComment).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("rejects empty messages", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    await expect(runTaskSteer("FN-004", "")).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Message is required")
    );
    expect(mockAddComment).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("rejects whitespace-only messages", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    await expect(runTaskSteer("FN-005", "   ")).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Message is required")
    );
    expect(mockAddComment).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("handles task not found error (ENOENT)", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    const error = new Error("Task not found") as Error & { code: string };
    error.code = "ENOENT";
    mockAddComment.mockRejectedValueOnce(error);

    await expect(runTaskSteer("KB-999", "Some message")).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Task not found: KB-999")
    );

    exitSpy.mockRestore();
  });

  it("shows success output with preview for short messages", async () => {
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-006",
      title: "Short Message Task",
    });

    await runTaskSteer("FN-006", "Short comment");

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Short comment")
    );
  });

  it("truncates long messages in success preview", async () => {
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-007",
      title: "Long Message Task",
    });

    const longMessage = "a".repeat(100);
    await runTaskSteer("FN-007", longMessage);

    // Should show first 60 chars + ellipsis
    const expectedPreview = "a".repeat(60) + "…";
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining(expectedPreview)
    );
  });

  it("trims whitespace from messages", async () => {
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-008",
      title: "Trim Test Task",
    });

    await runTaskSteer("FN-008", "  Some message with whitespace  ");

    expect(mockAddComment).toHaveBeenCalledWith("FN-008", "Some message with whitespace", "user");
  });

  it("accepts messages at boundary lengths (1 and 2000 chars)", async () => {
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-009",
      title: "Boundary Test",
    });

    // Test 1 character
    await runTaskSteer("FN-009", "x");
    expect(mockAddComment).toHaveBeenCalledWith("FN-009", "x", "user");

    // Reset mock for next test
    vi.clearAllMocks();
    setupTaskStoreMock();
    mockAddComment.mockResolvedValueOnce({
      id: "FN-010",
      title: "Boundary Test 2",
    });

    // Test exactly 2000 characters
    const exact2000 = "b".repeat(2000);
    await runTaskSteer("FN-010", exact2000);
    expect(mockAddComment).toHaveBeenCalledWith("FN-010", exact2000, "user");
  });

  it("rethrows non-ENOENT errors", async () => {
    setupTaskStoreMock();

    const error = new Error("Database error");
    mockAddComment.mockRejectedValueOnce(error);

    await expect(runTaskSteer("FN-011", "Message")).rejects.toThrow("Database error");
  });

  it("treats empty string as validation error, not prompt trigger", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    // Empty string as argument is a validation error, not a prompt trigger
    await expect(runTaskSteer("FN-012", "")).rejects.toThrow();

    // Should NOT prompt, should error instead
    expect(mockQuestion).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Message is required")
    );
    expect(mockAddComment).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});
