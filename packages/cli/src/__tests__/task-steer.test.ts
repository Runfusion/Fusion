import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:readline/promises before importing
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(),
}));

// Mock @kb/core before importing
vi.mock("@kb/core", () => ({
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
import { TaskStore } from "@kb/core";
import { runTaskSteer } from "../commands/task.js";

describe("runTaskSteer", () => {
  let mockConsoleLog: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;
  const mockQuestion = vi.fn();
  const mockClose = vi.fn();
  const mockAddSteeringComment = vi.fn();

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
      addSteeringComment: mockAddSteeringComment,
      ...overrides,
    }));
  }

  it("adds steering comment with message argument", async () => {
    setupTaskStoreMock();
    mockAddSteeringComment.mockResolvedValueOnce({
      id: "KB-001",
      title: "Test Task",
    });

    await runTaskSteer("KB-001", "Focus on error handling");

    expect(mockAddSteeringComment).toHaveBeenCalledWith("KB-001", "Focus on error handling", "user");
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Steering comment added to KB-001")
    );
  });

  it("reads message from stdin when not provided as argument", async () => {
    setupTaskStoreMock();
    mockAddSteeringComment.mockResolvedValueOnce({
      id: "KB-002",
      title: "Another Task",
    });

    mockQuestion.mockResolvedValueOnce("This is a steering comment from stdin");

    await runTaskSteer("KB-002", undefined);

    expect(mockQuestion).toHaveBeenCalledWith("Message: ");
    expect(mockAddSteeringComment).toHaveBeenCalledWith("KB-002", "This is a steering comment from stdin", "user");
    expect(mockClose).toHaveBeenCalled();
  });

  it("rejects messages longer than 2000 characters", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    const longMessage = "a".repeat(2001);

    await expect(runTaskSteer("KB-003", longMessage)).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Message must be between 1 and 2000 characters")
    );
    expect(mockAddSteeringComment).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("rejects empty messages", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    await expect(runTaskSteer("KB-004", "")).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Message is required")
    );
    expect(mockAddSteeringComment).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("rejects whitespace-only messages", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    await expect(runTaskSteer("KB-005", "   ")).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Message is required")
    );
    expect(mockAddSteeringComment).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("handles task not found error (ENOENT)", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    const error = new Error("Task not found") as Error & { code: string };
    error.code = "ENOENT";
    mockAddSteeringComment.mockRejectedValueOnce(error);

    await expect(runTaskSteer("KB-999", "Some message")).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Task not found: KB-999")
    );

    exitSpy.mockRestore();
  });

  it("shows success output with preview for short messages", async () => {
    setupTaskStoreMock();
    mockAddSteeringComment.mockResolvedValueOnce({
      id: "KB-006",
      title: "Short Message Task",
    });

    await runTaskSteer("KB-006", "Short comment");

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Short comment")
    );
  });

  it("truncates long messages in success preview", async () => {
    setupTaskStoreMock();
    mockAddSteeringComment.mockResolvedValueOnce({
      id: "KB-007",
      title: "Long Message Task",
    });

    const longMessage = "a".repeat(100);
    await runTaskSteer("KB-007", longMessage);

    // Should show first 60 chars + ellipsis
    const expectedPreview = "a".repeat(60) + "…";
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining(expectedPreview)
    );
  });

  it("trims whitespace from messages", async () => {
    setupTaskStoreMock();
    mockAddSteeringComment.mockResolvedValueOnce({
      id: "KB-008",
      title: "Trim Test Task",
    });

    await runTaskSteer("KB-008", "  Some message with whitespace  ");

    expect(mockAddSteeringComment).toHaveBeenCalledWith("KB-008", "Some message with whitespace", "user");
  });

  it("accepts messages at boundary lengths (1 and 2000 chars)", async () => {
    setupTaskStoreMock();
    mockAddSteeringComment.mockResolvedValueOnce({
      id: "KB-009",
      title: "Boundary Test",
    });

    // Test 1 character
    await runTaskSteer("KB-009", "x");
    expect(mockAddSteeringComment).toHaveBeenCalledWith("KB-009", "x", "user");

    // Reset mock for next test
    vi.clearAllMocks();
    setupTaskStoreMock();
    mockAddSteeringComment.mockResolvedValueOnce({
      id: "KB-010",
      title: "Boundary Test 2",
    });

    // Test exactly 2000 characters
    const exact2000 = "b".repeat(2000);
    await runTaskSteer("KB-010", exact2000);
    expect(mockAddSteeringComment).toHaveBeenCalledWith("KB-010", exact2000, "user");
  });

  it("rethrows non-ENOENT errors", async () => {
    setupTaskStoreMock();

    const error = new Error("Database error");
    mockAddSteeringComment.mockRejectedValueOnce(error);

    await expect(runTaskSteer("KB-011", "Message")).rejects.toThrow("Database error");
  });

  it("treats empty string as validation error, not prompt trigger", async () => {
    setupTaskStoreMock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    // Empty string as argument is a validation error, not a prompt trigger
    await expect(runTaskSteer("KB-012", "")).rejects.toThrow();

    // Should NOT prompt, should error instead
    expect(mockQuestion).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Message is required")
    );
    expect(mockAddSteeringComment).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});
