import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PlanningModeModal } from "./PlanningModeModal";
import { TaskDetailModal } from "./TaskDetailModal";
import type { Task, TaskDetail, PlanningQuestion, PlanningSummary, MergeResult } from "@fusion/core";

// Mock the API functions
const mockStartPlanning = vi.fn();
const mockStartPlanningStreaming = vi.fn();
const mockConnectPlanningStream = vi.fn();
const mockRespondToPlanning = vi.fn();
const mockCancelPlanning = vi.fn();
const mockCreateTaskFromPlanning = vi.fn();
const mockUploadAttachment = vi.fn();
const mockDeleteAttachment = vi.fn();
const mockUpdateTask = vi.fn();
const mockPauseTask = vi.fn();
const mockUnpauseTask = vi.fn();
const mockFetchTaskDetail = vi.fn();
const mockRequestSpecRevision = vi.fn();
const mockApprovePlan = vi.fn();
const mockRejectPlan = vi.fn();
const mockRefineTask = vi.fn();

vi.mock("../api", () => ({
  startPlanning: (...args: any[]) => mockStartPlanning(...args),
  startPlanningStreaming: (...args: any[]) => mockStartPlanningStreaming(...args),
  connectPlanningStream: (...args: any[]) => mockConnectPlanningStream(...args),
  respondToPlanning: (...args: any[]) => mockRespondToPlanning(...args),
  cancelPlanning: (...args: any[]) => mockCancelPlanning(...args),
  createTaskFromPlanning: (...args: any[]) => mockCreateTaskFromPlanning(...args),
  uploadAttachment: (...args: any[]) => mockUploadAttachment(...args),
  deleteAttachment: (...args: any[]) => mockDeleteAttachment(...args),
  updateTask: (...args: any[]) => mockUpdateTask(...args),
  pauseTask: (...args: any[]) => mockPauseTask(...args),
  unpauseTask: (...args: any[]) => mockUnpauseTask(...args),
  fetchTaskDetail: (...args: any[]) => mockFetchTaskDetail(...args),
  requestSpecRevision: (...args: any[]) => mockRequestSpecRevision(...args),
  approvePlan: (...args: any[]) => mockApprovePlan(...args),
  rejectPlan: (...args: any[]) => mockRejectPlan(...args),
  refineTask: (...args: any[]) => mockRefineTask(...args),
}));

const mockTasks: Task[] = [
  {
    id: "FN-001",
    description: "Existing task 1",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

const mockQuestion: PlanningQuestion = {
  id: "q-scope",
  type: "single_select",
  question: "What is the scope?",
  description: "Choose the scope of this task",
  options: [
    { id: "small", label: "Small" },
    { id: "medium", label: "Medium" },
    { id: "large", label: "Large" },
  ],
};

const mockSummary: PlanningSummary = {
  title: "Build authentication system",
  description: "Implement user auth with login and signup",
  suggestedSize: "M",
  suggestedDependencies: [],
  keyDeliverables: ["Login page", "Signup page", "Auth API"],
};

const mockTaskDetail = {
  id: "KB-999",
  title: "Example task",
  description: "Example description",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  attachments: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# Task\n\nExample prompt",
  paused: false,
} as TaskDetail;

describe("PlanningModeModal", () => {
  const mockOnClose = vi.fn();
  const mockOnTaskCreated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    
    // Default mock for streaming
    mockStartPlanningStreaming.mockResolvedValue({ sessionId: "session-123" });
    
    // Default: simulate receiving a question after a brief delay
    mockConnectPlanningStream.mockImplementation((sessionId: string, handlers: any) => {
      setTimeout(() => {
        handlers.onQuestion?.(mockQuestion);
      }, 10);
      
      return {
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      };
    });
  });

  describe("Initial view", () => {
    it("renders the initial input view when open", () => {
      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      expect(screen.getByText("Planning Mode")).toBeDefined();
      expect(screen.getByPlaceholderText(/e.g., Build a user authentication/)).toBeDefined();
      expect(container.querySelector(".planning-modal-body")).not.toBeNull();
      expect(container.querySelector(".planning-modal-body")?.classList.contains("modal-body")).toBe(false);
      expect(container.querySelector(".planning-examples-label")?.textContent).toBe("Try an example:");
    });

    it("does not render when closed", () => {
      render(
        <PlanningModeModal
          isOpen={false}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      expect(screen.queryByText("Planning Mode")).toBeNull();
    });

    it("enables start button when text is entered", () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const startButton = screen.getByText("Start Planning");
      expect(startButton.closest("button")?.hasAttribute("disabled")).toBe(true);

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Test plan" } });

      expect(startButton.closest("button")?.hasAttribute("disabled")).toBe(false);
    });

    it("shows example chips", () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      expect(screen.getByText(/Build a user authentication/)).toBeDefined();
    });

    it("auto-starts planning when initialPlan prop is provided", async () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
          initialPlan="Build a login system from new task dialog"
        />
      );

      // Wait for startPlanningStreaming to be called (allow time for setTimeout in useEffect)
      await waitFor(() => {
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build a login system from new task dialog");
      }, { timeout: 2000 });

      // Should transition to question view
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });
    });

    it("sets initial plan text in textarea when initialPlan prop is provided", async () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
          initialPlan="Pre-filled plan from new task"
        />
      );

      // The auto-start should happen with the initial plan (allow time for setTimeout in useEffect)
      await waitFor(() => {
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Pre-filled plan from new task");
      }, { timeout: 2000 });
    });
  });

  describe("Planning flow", () => {
    it("starts planning and shows question view", async () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });

      fireEvent.click(screen.getByText("Start Planning"));

      // Wait for streaming to be called
      await waitFor(() => {
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build auth system");
      });

      // Should transition to question view via streaming
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });
    });

    it("shows error message when planning fails", async () => {
      // Override the default mock to simulate an error
      mockConnectPlanningStream.mockImplementationOnce((sessionId: string, handlers: any) => {
        setTimeout(() => {
          handlers.onError?.("Rate limit exceeded");
        }, 10);
        
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });

      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Rate limit exceeded")).toBeDefined();
      });
    });
  });

  describe("Question view", () => {
    it("renders single_select question with options", async () => {
      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Small")).toBeDefined();
        expect(screen.getByText("Medium")).toBeDefined();
        expect(screen.getByText("Large")).toBeDefined();
      });

      expect(container.querySelector(".planning-question-form > .planning-view-scroll")).not.toBeNull();
      expect(container.querySelector(".planning-question-form > .planning-actions")).not.toBeNull();
    });

    it("receives second question after answering first without hanging (race condition fix)", async () => {
      const secondQuestion: PlanningQuestion = {
        id: "q-requirements",
        type: "text",
        question: "What are the key requirements?",
        description: "Describe the requirements",
      };

      // Track how many times connectPlanningStream is called
      let streamConnectionCount = 0;
      let streamHandlers: any = null;

      mockConnectPlanningStream.mockImplementation((sessionId: string, handlers: any) => {
        streamConnectionCount++;
        streamHandlers = handlers;
        
        // Only send first question on initial connection
        if (streamConnectionCount === 1) {
          setTimeout(() => {
            handlers.onQuestion?.(mockQuestion);
          }, 10);
        }
        
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      mockRespondToPlanning.mockImplementation(async () => {
        // Simulate server broadcasting second question via the existing SSE connection
        // This should use the same handlers from the initial connection
        setTimeout(() => {
          if (streamHandlers) {
            streamHandlers.onQuestion?.(secondQuestion);
          }
        }, 5);
        return { sessionId: "session-123", currentQuestion: null, summary: null };
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      // Wait for first question
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      // Answer the first question
      fireEvent.click(screen.getByText("Medium"));
      fireEvent.click(screen.getByText("Continue"));

      // Wait for second question to appear (should NOT hang)
      await waitFor(() => {
        expect(screen.getByText("What are the key requirements?")).toBeDefined();
      }, { timeout: 3000 });

      // Verify SSE connection was established only ONCE (not reconnected)
      // This confirms the race condition fix - the same connection is reused
      expect(streamConnectionCount).toBe(1);
    });
  });

  describe("Summary view", () => {
    it("shows summary when planning is complete", async () => {
      // Override mock to return summary instead of question
      mockConnectPlanningStream.mockImplementationOnce((sessionId: string, handlers: any) => {
        setTimeout(() => {
          handlers.onSummary?.(mockSummary);
        }, 10);
        
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      expect(container.querySelector(".planning-summary > .planning-view-scroll")).not.toBeNull();
      expect(container.querySelector(".planning-summary > .planning-actions")).not.toBeNull();
      expect(container.querySelector(".planning-summary .planning-deps-list")).not.toBeNull();
    });

    it("creates task from summary", async () => {
      const createdTask: Task = {
        id: "FN-042",
        title: "Build authentication system",
        description: "Implement user auth with login and signup",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      // Override mock to return summary
      mockConnectPlanningStream.mockImplementationOnce((sessionId: string, handlers: any) => {
        setTimeout(() => {
          handlers.onSummary?.(mockSummary);
        }, 10);
        
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      mockCreateTaskFromPlanning.mockResolvedValue(createdTask);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Create Task")).toBeDefined();
      });

      fireEvent.click(screen.getByText("Create Task"));

      await waitFor(() => {
        expect(mockCreateTaskFromPlanning).toHaveBeenCalledWith("session-123");
        expect(mockOnTaskCreated).toHaveBeenCalledWith(createdTask);
      });
    });
  });

  describe("Modal smoke checks", () => {
    it("renders TaskDetailModal with the standard detail body structure", () => {
      const onMoveTask = vi.fn<(_: string, __: any) => Promise<Task>>().mockResolvedValue(mockTasks[0]);
      const onDeleteTask = vi.fn<(_: string) => Promise<Task>>().mockResolvedValue(mockTasks[0]);
      const onMergeTask = vi
        .fn<(_: string) => Promise<MergeResult>>()
        .mockResolvedValue({ merged: true, branch: "fusion/fn-999", task: mockTasks[0], worktreeRemoved: true, branchDeleted: true });

      const { container } = render(
        <TaskDetailModal
          task={mockTaskDetail}
          tasks={mockTasks}
          onClose={mockOnClose}
          onOpenDetail={vi.fn()}
          onMoveTask={onMoveTask}
          onDeleteTask={onDeleteTask}
          onMergeTask={onMergeTask}
          addToast={vi.fn()}
        />
      );

      expect(screen.getByText("Definition")).toBeDefined();
      expect(container.querySelector(".detail-body")).not.toBeNull();
    });
  });

  describe("Loading state", () => {
    it("shows 'Generating next question...' text when loading without streaming content", async () => {
      // Mock to delay the question response so we stay in loading state
      mockConnectPlanningStream.mockImplementationOnce((sessionId: string, handlers: any) => {
        // Don't call any handlers - stay in loading state
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      // Wait for loading state to appear
      await waitFor(() => {
        expect(container.querySelector(".planning-loading")).not.toBeNull();
      });

      // Should show "Generating next question..." not "Connecting..."
      expect(screen.getByText("Generating next question...")).toBeDefined();
      expect(screen.queryByText("Connecting...")).toBeNull();
    });

    it("shows thinking container even when streaming output is initially empty", async () => {
      // Mock to delay the question response so we stay in loading state
      mockConnectPlanningStream.mockImplementationOnce((sessionId: string, handlers: any) => {
        // Don't call any handlers - stay in loading state
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      // Wait for loading state to appear
      await waitFor(() => {
        expect(container.querySelector(".planning-loading")).not.toBeNull();
      });

      // Thinking container should be visible even without streaming content
      expect(container.querySelector(".planning-thinking-container")).not.toBeNull();
      // showThinking defaults to true, so button shows "Hide thinking"
      expect(screen.getByText("Hide thinking")).toBeDefined();
    });

    it("shows 'AI is thinking...' text and renders streaming content when it arrives", async () => {
      let streamHandlers: any = null;

      mockConnectPlanningStream.mockImplementationOnce((sessionId: string, handlers: any) => {
        streamHandlers = handlers;
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      // Wait for loading state to appear
      await waitFor(() => {
        expect(container.querySelector(".planning-loading")).not.toBeNull();
      });

      // Initially shows "Generating next question..."
      expect(screen.getByText("Generating next question...")).toBeDefined();

      // Simulate streaming content arriving
      await waitFor(() => {
        streamHandlers.onThinking?.("Analyzing requirements...");
      });

      // Now should show "AI is thinking..."
      await waitFor(() => {
        expect(screen.getByText("AI is thinking...")).toBeDefined();
      });

      // The streaming content should be visible (showThinking defaults to true)
      await waitFor(() => {
        expect(screen.getByText("Analyzing requirements...")).toBeDefined();
      });

      // Click "Hide thinking" to hide the output
      fireEvent.click(screen.getByText("Hide thinking"));

      // The output should now be hidden
      expect(screen.queryByText("Analyzing requirements...")).toBeNull();
    });

    it("shows loading state with appropriate text after submitting a response", async () => {
      const secondQuestion: PlanningQuestion = {
        id: "q-requirements",
        type: "text",
        question: "What are the key requirements?",
        description: "Describe the requirements",
      };

      let streamHandlers: any = null;

      mockConnectPlanningStream.mockImplementation((sessionId: string, handlers: any) => {
        streamHandlers = handlers;
        
        setTimeout(() => {
          handlers.onQuestion?.(mockQuestion);
        }, 10);
        
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      mockRespondToPlanning.mockImplementation(async () => {
        // Simulate server broadcasting second question via the existing SSE connection
        setTimeout(() => {
          if (streamHandlers) {
            streamHandlers.onQuestion?.(secondQuestion);
          }
        }, 50);
        return { sessionId: "session-123", currentQuestion: null, summary: null };
      });

      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      // Wait for first question
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      // Answer the first question
      fireEvent.click(screen.getByText("Medium"));
      fireEvent.click(screen.getByText("Continue"));

      // Verify loading state appears with correct message
      await waitFor(() => {
        expect(container.querySelector(".planning-loading")).not.toBeNull();
        expect(screen.getByText("Generating next question...")).toBeDefined();
      });

      // Verify thinking container is visible during loading
      expect(container.querySelector(".planning-thinking-container")).not.toBeNull();

      // Wait for second question to appear
      await waitFor(() => {
        expect(screen.getByText("What are the key requirements?")).toBeDefined();
      }, { timeout: 3000 });
    });
  });

  describe("Dismiss warning", () => {
    it("shows confirmation when clicking X button with progress", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      // Wait for question view (progress made)
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      // Click X button
      const closeButton = screen.getByLabelText("Close");
      fireEvent.click(closeButton);

      // Should show confirmation dialog
      expect(confirmSpy).toHaveBeenCalledWith("Are you sure you want to close? Your planning progress will be lost.");
      // onClose should NOT be called since confirm returned false
      expect(mockOnClose).not.toHaveBeenCalled();

      confirmSpy.mockRestore();
    });

    it("shows confirmation when clicking overlay with progress", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      // Wait for question view (progress made)
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      // Click overlay (modal-overlay)
      const overlay = container.querySelector(".modal-overlay");
      expect(overlay).not.toBeNull();
      fireEvent.click(overlay!);

      // Should show confirmation dialog
      expect(confirmSpy).toHaveBeenCalledWith("Are you sure you want to close? Your planning progress will be lost.");
      // onClose should NOT be called since confirm returned false
      expect(mockOnClose).not.toHaveBeenCalled();

      confirmSpy.mockRestore();
    });

    it("no confirmation shown when no progress made (initial state)", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      // Click X button while still in initial state (no planning started)
      const closeButton = screen.getByLabelText("Close");
      fireEvent.click(closeButton);

      // Should NOT show confirmation dialog
      expect(confirmSpy).not.toHaveBeenCalled();
      // onClose should be called immediately
      expect(mockOnClose).toHaveBeenCalled();

      confirmSpy.mockRestore();
    });

    it("closes without confirmation after confirming dismiss", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      // Wait for question view (progress made)
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      // Click X button
      const closeButton = screen.getByLabelText("Close");
      fireEvent.click(closeButton);

      // Should show confirmation dialog
      expect(confirmSpy).toHaveBeenCalledWith("Are you sure you want to close? Your planning progress will be lost.");
      
      // Wait for async handleCancel to complete
      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });

      confirmSpy.mockRestore();
    });

    it("shows confirmation in summary view", async () => {
      // Override mock to return summary
      mockConnectPlanningStream.mockImplementationOnce((sessionId: string, handlers: any) => {
        setTimeout(() => {
          handlers.onSummary?.(mockSummary);
        }, 10);
        
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      // Wait for summary view (progress made)
      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      // Click X button
      const closeButton = screen.getByLabelText("Close");
      fireEvent.click(closeButton);

      // Should show confirmation dialog
      expect(confirmSpy).toHaveBeenCalledWith("Are you sure you want to close? Your planning progress will be lost.");
      expect(mockOnClose).not.toHaveBeenCalled();

      confirmSpy.mockRestore();
    });
  });
});
