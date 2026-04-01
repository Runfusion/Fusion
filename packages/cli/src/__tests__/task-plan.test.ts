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

// Mock @fusion/dashboard/planning
vi.mock("@fusion/dashboard/planning", () => ({
  createSession: vi.fn(),
  submitResponse: vi.fn(),
  RateLimitError: class RateLimitError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RateLimitError";
    }
  },
  SessionNotFoundError: class SessionNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SessionNotFoundError";
    }
  },
  InvalidSessionStateError: class InvalidSessionStateError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "InvalidSessionStateError";
    }
  },
}));

// Import after mocking
import { createInterface } from "node:readline/promises";
import { TaskStore } from "@fusion/core";
import { createSession, submitResponse, RateLimitError, SessionNotFoundError } from "@fusion/dashboard/planning";
import { runTaskPlan } from "../commands/task.js";

describe("runTaskPlan", () => {
  let mockConsoleLog: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;
  let mockStdoutWrite: ReturnType<typeof vi.spyOn>;
  const mockQuestion = vi.fn();
  const mockClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockStdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockQuestion.mockReset();
    (createInterface as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      question: mockQuestion,
      close: mockClose,
    });
  });

  afterEach(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    mockStdoutWrite.mockRestore();
  });

  function setupTaskStoreMock(overrides: Record<string, unknown> = {}) {
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      createTask: vi.fn().mockResolvedValue({
        id: "FN-042",
        title: "Test Task Title",
        description: "Test description",
        column: "triage",
        dependencies: ["FN-001"],
        ...overrides,
      }),
    }));
  }

  it("prompts for initial plan when not provided", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q1",
        type: "confirm",
        question: "Is this a test?",
        description: "Test description",
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "complete",
      data: {
        title: "Test Task",
        description: "A test task",
        suggestedSize: "S",
        suggestedDependencies: [],
        keyDeliverables: ["Test delivery"],
      },
    });

    mockQuestion
      .mockResolvedValueOnce("Build a test feature")
      .mockResolvedValueOnce("y");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan(undefined, true);
    } catch {
      // expected
    }

    expect(createSession).toHaveBeenCalledWith(
      "127.0.0.1",
      "Build a test feature",
      expect.any(Object),
      expect.any(String)
    );

    exitSpy.mockRestore();
  });

  it("handles text question flow (multi-line input)", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q-text",
        type: "text",
        question: "What are the requirements?",
        description: "Describe your requirements",
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "complete",
      data: {
        title: "Test Task",
        description: "Requirements: Test requirements",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implementation"],
      },
    });

    mockQuestion
      .mockResolvedValueOnce("Line 1")
      .mockResolvedValueOnce("Line 2")
      .mockResolvedValueOnce("DONE");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build something", true);
    } catch {
      // expected
    }

    expect(submitResponse).toHaveBeenCalledWith(
      "test-session-123",
      { "q-text": "Line 1\nLine 2" }
    );

    exitSpy.mockRestore();
  });

  it("handles single_select question flow", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q-scope",
        type: "single_select",
        question: "What is the scope?",
        description: "Select scope",
        options: [
          { id: "small", label: "Small", description: "Quick fix" },
          { id: "large", label: "Large", description: "Big feature" },
        ],
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "complete",
      data: {
        title: "Test Task",
        description: "Scope: small",
        suggestedSize: "S",
        suggestedDependencies: [],
        keyDeliverables: ["Implementation"],
      },
    });

    mockQuestion.mockResolvedValueOnce("1");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build something", true);
    } catch {
      // expected
    }

    expect(submitResponse).toHaveBeenCalledWith(
      "test-session-123",
      { "q-scope": "small" }
    );

    exitSpy.mockRestore();
  });

  it("handles multi_select question flow", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q-features",
        type: "multi_select",
        question: "Select features",
        description: "Choose features to include",
        options: [
          { id: "feat1", label: "Feature 1", description: "First feature" },
          { id: "feat2", label: "Feature 2", description: "Second feature" },
          { id: "feat3", label: "Feature 3", description: "Third feature" },
        ],
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "complete",
      data: {
        title: "Test Task",
        description: "Features: feat1, feat3",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Feature 1", "Feature 3"],
      },
    });

    mockQuestion.mockResolvedValueOnce("1,3");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build something", true);
    } catch {
      // expected
    }

    expect(submitResponse).toHaveBeenCalledWith(
      "test-session-123",
      { "q-features": ["feat1", "feat3"] }
    );

    exitSpy.mockRestore();
  });

  it("handles confirm question flow with yes", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q-confirm",
        type: "confirm",
        question: "Do you need authentication?",
        description: "Security requirement",
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "complete",
      data: {
        title: "Test Task",
        description: "Auth required: yes",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Auth system"],
      },
    });

    mockQuestion.mockResolvedValueOnce("y");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build something", true);
    } catch {
      // expected
    }

    expect(submitResponse).toHaveBeenCalledWith(
      "test-session-123",
      { "q-confirm": true }
    );

    exitSpy.mockRestore();
  });

  it("handles confirm question flow with no", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q-confirm",
        type: "confirm",
        question: "Do you need authentication?",
        description: "Security requirement",
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "complete",
      data: {
        title: "Test Task",
        description: "Auth required: no",
        suggestedSize: "S",
        suggestedDependencies: [],
        keyDeliverables: ["Basic implementation"],
      },
    });

    mockQuestion.mockResolvedValueOnce("n");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build something", true);
    } catch {
      // expected
    }

    expect(submitResponse).toHaveBeenCalledWith(
      "test-session-123",
      { "q-confirm": false }
    );

    exitSpy.mockRestore();
  });

  it("creates task after planning completes with --yes flag", async () => {
    const mockCreateTask = vi.fn().mockResolvedValue({
      id: "FN-042",
      title: "Planned Task",
      description: "A well-planned task",
      column: "triage",
      dependencies: ["FN-001"],
    });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      createTask: mockCreateTask,
    }));

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q1",
        type: "confirm",
        question: "Ready?",
        description: "Confirm to complete",
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "complete",
      data: {
        title: "Planned Task",
        description: "A well-planned task",
        suggestedSize: "M",
        suggestedDependencies: ["FN-001"],
        keyDeliverables: ["Code", "Tests"],
      },
    });

    mockQuestion.mockResolvedValueOnce("y");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build something", true);
    } catch {
      // expected
    }

    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "Planned Task",
      description: "A well-planned task",
      column: "triage",
      dependencies: ["FN-001"],
    });

    exitSpy.mockRestore();
  });

  it("prompts for confirmation without --yes flag", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q1",
        type: "confirm",
        question: "Ready?",
        description: "Confirm to complete",
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "complete",
      data: {
        title: "Planned Task",
        description: "A well-planned task",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Code"],
      },
    });

    mockQuestion
      .mockResolvedValueOnce("y")
      .mockResolvedValueOnce("y");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build something", false);
    } catch {
      // expected
    }

    expect(mockQuestion).toHaveBeenLastCalledWith("  Create this task? [Y/n]: ");

    exitSpy.mockRestore();
  });

  it("handles RateLimitError with proper message", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new RateLimitError("Rate limit exceeded")
    );

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    await expect(runTaskPlan("Build something", true)).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Rate limit exceeded")
    );

    exitSpy.mockRestore();
  });

  it("handles SessionNotFoundError with proper message", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q1",
        type: "text",
        question: "Question?",
        description: "Answer me",
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new SessionNotFoundError("Session not found")
    );

    mockQuestion
      .mockResolvedValueOnce("answer")
      .mockResolvedValueOnce("DONE");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build something", true);
    } catch {
      // expected
    }

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Session expired")
    );

    exitSpy.mockRestore();
  });

  it("cancels planning when user enters empty initial plan", async () => {
    mockQuestion.mockResolvedValueOnce("");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Process.exit called with ${code}`);
    });

    await expect(runTaskPlan(undefined, false)).rejects.toThrow();

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Description is required")
    );

    exitSpy.mockRestore();
  });

  it("skips task creation when user declines confirmation", async () => {
    const mockCreateTask = vi.fn().mockResolvedValue({ id: "FN-042" });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      createTask: mockCreateTask,
    }));

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q1",
        type: "confirm",
        question: "Ready?",
        description: "Confirm to complete",
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "complete",
      data: {
        title: "Planned Task",
        description: "A well-planned task",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Code"],
      },
    });

    mockQuestion
      .mockResolvedValueOnce("y")
      .mockResolvedValueOnce("n");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build something", false);
    } catch {
      // expected
    }

    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Task creation cancelled")
    );

    exitSpy.mockRestore();
  });

  it("validates single_select input and retries on invalid", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q-scope",
        type: "single_select",
        question: "Select scope",
        description: "Choose scope",
        options: [
          { id: "small", label: "Small", description: "Quick" },
          { id: "large", label: "Large", description: "Big" },
        ],
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "complete",
      data: {
        title: "Test",
        description: "Test",
        suggestedSize: "S",
        suggestedDependencies: [],
        keyDeliverables: ["Test"],
      },
    });

    mockQuestion
      .mockResolvedValueOnce("abc")
      .mockResolvedValueOnce("5")
      .mockResolvedValueOnce("1");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build something", true);
    } catch {
      // expected
    }

    expect(mockQuestion).toHaveBeenCalledTimes(3);
    expect(submitResponse).toHaveBeenCalledWith(
      "test-session-123",
      { "q-scope": "small" }
    );

    exitSpy.mockRestore();
  });

  it("validates multi_select input and retries on invalid", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q-features",
        type: "multi_select",
        question: "Select features",
        description: "Choose features",
        options: [
          { id: "f1", label: "Feature 1", description: "First" },
          { id: "f2", label: "Feature 2", description: "Second" },
        ],
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "complete",
      data: {
        title: "Test",
        description: "Test",
        suggestedSize: "S",
        suggestedDependencies: [],
        keyDeliverables: ["Test"],
      },
    });

    mockQuestion
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("1,5")
      .mockResolvedValueOnce("1,2");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build something", true);
    } catch {
      // expected
    }

    expect(mockQuestion).toHaveBeenCalledTimes(3);
    expect(submitResponse).toHaveBeenCalledWith(
      "test-session-123",
      { "q-features": ["f1", "f2"] }
    );

    exitSpy.mockRestore();
  });

  it("continues to next question after answering", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q1",
        type: "confirm",
        question: "First question?",
        description: "Answer this",
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: "question",
        data: {
          id: "q2",
          type: "text",
          question: "Second question?",
          description: "More details",
        },
      })
      .mockResolvedValueOnce({
        type: "complete",
        data: {
          title: "Test",
          description: "Test with multiple questions",
          suggestedSize: "M",
          suggestedDependencies: [],
          keyDeliverables: ["Answer 1", "Answer 2"],
        },
      });

    mockQuestion
      .mockResolvedValueOnce("y")
      .mockResolvedValueOnce("Answer text")
      .mockResolvedValueOnce("DONE");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build something", true);
    } catch {
      // expected
    }

    expect(submitResponse).toHaveBeenCalledTimes(2);
    expect(submitResponse).toHaveBeenNthCalledWith(
      1,
      "test-session-123",
      { q1: true }
    );
    expect(submitResponse).toHaveBeenNthCalledWith(
      2,
      "test-session-123",
      { q2: "Answer text" }
    );

    exitSpy.mockRestore();
  });

  it("uses default yes for confirm when user presses Enter", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q-confirm",
        type: "confirm",
        question: "Continue?",
        description: "Press Enter for yes",
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "complete",
      data: {
        title: "Test",
        description: "Test",
        suggestedSize: "S",
        suggestedDependencies: [],
        keyDeliverables: ["Test"],
      },
    });

    mockQuestion.mockResolvedValueOnce("");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build something", true);
    } catch {
      // expected
    }

    expect(submitResponse).toHaveBeenCalledWith(
      "test-session-123",
      { "q-confirm": true }
    );

    exitSpy.mockRestore();
  });

  it("displays summary with all fields correctly formatted", async () => {
    setupTaskStoreMock();

    (createSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: "test-session-123",
      firstQuestion: {
        id: "q1",
        type: "confirm",
        question: "Ready?",
        description: "Confirm",
      },
    });

    (submitResponse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "complete",
      data: {
        title: "Complete Auth System",
        description: "Build a comprehensive authentication system with login, logout, and password reset functionality. Includes email verification and 2FA support.",
        suggestedSize: "L",
        suggestedDependencies: ["FN-001", "FN-002"],
        keyDeliverables: [
          "User login with email/password",
          "Password reset via email",
          "Two-factor authentication",
          "Session management",
          "API integration tests",
        ],
      },
    });

    mockQuestion.mockResolvedValueOnce("y");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Process.exit called");
    });

    try {
      await runTaskPlan("Build auth system", true);
    } catch {
      // expected
    }

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Planning Summary")
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Complete Auth System")
    );

    exitSpy.mockRestore();
  });
});
