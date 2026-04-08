import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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
const mockStartPlanningBreakdown = vi.fn();
const mockCreateTasksFromPlanning = vi.fn();
const mockFetchAiSession = vi.fn();
const mockFetchModels = vi.fn();
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
  startPlanningBreakdown: (...args: any[]) => mockStartPlanningBreakdown(...args),
  createTasksFromPlanning: (...args: any[]) => mockCreateTasksFromPlanning(...args),
  fetchAiSession: (...args: any[]) => mockFetchAiSession(...args),
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
  fetchSettings: vi.fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
  fetchModels: (...args: any[]) => mockFetchModels(...args),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  refineText: vi.fn(),
  getRefineErrorMessage: vi.fn((err: any) => err?.message || "Failed to refine"),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
  duplicateTask: vi.fn().mockResolvedValue({}),
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

const mockModels = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    contextWindow: 200000,
  },
  {
    provider: "google",
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: true,
    contextWindow: 1048576,
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
    mockStartPlanningBreakdown.mockResolvedValue({ sessionId: "session-123", subtasks: [] });
    mockFetchAiSession.mockResolvedValue(null);
    mockFetchModels.mockResolvedValue({
      models: mockModels,
      favoriteProviders: [],
      favoriteModels: [],
    });

    // Default: simulate receiving a question after a brief delay
    mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
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

    it("renders planning model dropdown in initial view", async () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      const modelTrigger = screen.getByRole("button", { name: "Planning Model" });
      expect(modelTrigger).toBeDefined();
      expect(screen.getByText("Using default")).toBeDefined();

      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalledTimes(1);
      });
    });

    it("updates planning model selection and badge", async () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalledTimes(1);
      });

      fireEvent.click(screen.getByRole("button", { name: "Planning Model" }));
      fireEvent.click(screen.getByRole("option", { name: /Claude Sonnet 4.5/ }));

      expect(screen.getByText("anthropic/claude-sonnet-4-5")).toBeDefined();
    });

    it("passes selected planning model to startPlanningStreaming", async () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalledTimes(1);
      });

      fireEvent.click(screen.getByRole("button", { name: "Planning Model" }));
      fireEvent.click(screen.getByRole("option", { name: /Claude Sonnet 4.5/ }));

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build auth system", undefined, {
          planningModelProvider: "anthropic",
          planningModelId: "claude-sonnet-4-5",
        });
      });
    });

    it("calls startPlanningStreaming without model override when none selected", async () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build auth system", undefined, undefined);
      });
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
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build a login system from new task dialog", undefined, undefined);
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
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Pre-filled plan from new task", undefined, undefined);
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
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build auth system", undefined, undefined);
      });

      // Should transition to question view via streaming
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });
    });

    it("shows error message when planning fails", async () => {
      // Override the default mock to simulate an error
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
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

  describe("Resuming complete sessions", () => {
    it("shows summary view when resuming a complete persisted session", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-ready planning output",
        description: "Recovered summary description from persisted session",
        suggestedSize: "L",
        suggestedDependencies: ["FN-001"],
        keyDeliverables: ["Deliverable A", "Deliverable B"],
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-complete-1",
        type: "planning",
        status: "complete",
        title: "Resume-ready planning output",
        inputPayload: JSON.stringify({ initialPlan: "Build resilient planning resume" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(resumedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-complete-1"
        />
      );

      await waitFor(() => {
        expect(mockFetchAiSession).toHaveBeenCalledWith("session-complete-1");
      });

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      expect(screen.getByDisplayValue("Recovered summary description from persisted session")).toBeDefined();
      expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("L");
      expect(screen.getByText("Deliverable A")).toBeDefined();
      expect(screen.getByText("Deliverable B")).toBeDefined();
    });

    it("creates a task from a resumed complete session", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-to-task",
        description: "Recovered summary for task creation",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-complete-2",
        type: "planning",
        status: "complete",
        title: "Resume-to-task",
        inputPayload: JSON.stringify({ initialPlan: "Recover and create" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(resumedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      mockCreateTaskFromPlanning.mockResolvedValueOnce({
        id: "FN-100",
        title: "Resume-to-task",
        description: "Recovered summary for task creation",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-complete-2"
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Create Task")).toBeDefined();
      });

      fireEvent.click(screen.getByText("Create Task"));

      await waitFor(() => {
        expect(mockCreateTaskFromPlanning).toHaveBeenCalledWith("session-complete-2", undefined);
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

    it("shows reconnecting indicator without clearing current question state", async () => {
      let streamHandlers: any;

      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers = handlers;
        setTimeout(() => {
          handlers.onQuestion?.(mockQuestion);
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
        />,
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      act(() => {
        streamHandlers.onConnectionStateChange?.("reconnecting");
      });

      expect(screen.getByText("Reconnecting…")).toBeDefined();
      expect(screen.getByText("What is the scope?")).toBeDefined();

      act(() => {
        streamHandlers.onConnectionStateChange?.("connected");
      });

      await waitFor(() => {
        expect(screen.queryByText("Reconnecting…")).toBeNull();
      });
      expect(screen.getByText("What is the scope?")).toBeDefined();
    });

    it("receives second question after answering first without hanging (race condition fix)", async () => {
      // Use fake timers to avoid CI flakiness from tiny setTimeout delays in this race-condition scenario.
      vi.useFakeTimers();

      try {
        const secondQuestion: PlanningQuestion = {
          id: "q-requirements",
          type: "text",
          question: "What are the key requirements?",
          description: "Describe the requirements",
        };

        // Track how many times connectPlanningStream is called
        let streamConnectionCount = 0;
        let streamHandlers: any = null;
        let deliverSecondQuestion: (() => void) | null = null;

        mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
          streamConnectionCount++;
          streamHandlers = handlers;

          // Emit the first question synchronously on initial connection.
          if (streamConnectionCount === 1) {
            handlers.onQuestion?.(mockQuestion);
          }

          return {
            close: vi.fn(),
            isConnected: vi.fn().mockReturnValue(true),
          };
        });

        mockRespondToPlanning.mockImplementation(async () => {
          return new Promise((resolve) => {
            deliverSecondQuestion = () => {
              streamHandlers?.onQuestion?.(secondQuestion);
              resolve({ sessionId: "session-123", currentQuestion: null, summary: null });
            };
          });
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

        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByText("What is the scope?")).toBeDefined();

        // Answer the first question.
        fireEvent.click(screen.getByText("Medium"));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        const continueButton = screen.getByRole("button", { name: "Continue" });
        expect(continueButton.hasAttribute("disabled")).toBe(false);
        fireEvent.click(continueButton);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(mockRespondToPlanning).toHaveBeenCalledTimes(1);
        expect(deliverSecondQuestion).not.toBeNull();

        act(() => {
          deliverSecondQuestion?.();
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        // Verify second question appears without hanging.
        expect(screen.getByText("What are the key requirements?")).toBeDefined();

        // Verify SSE connection was established only ONCE (not reconnected).
        // This confirms the race condition fix - the same connection is reused.
        expect(streamConnectionCount).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Summary view", () => {
    it("shows summary when planning is complete", async () => {
      // Override mock to return summary instead of question
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
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

    it("renders and updates summary size dropdown", async () => {
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        setTimeout(() => {
          handlers.onSummary?.(mockSummary);
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
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      const sizeSelect = screen.getByRole("combobox") as HTMLSelectElement;
      expect(sizeSelect.value).toBe("M");
      expect(Array.from(sizeSelect.options).map((option) => option.textContent)).toEqual([
        "S (Small)",
        "M (Medium)",
        "L (Large)",
      ]);

      fireEvent.change(sizeSelect, { target: { value: "L" } });
      expect(sizeSelect.value).toBe("L");
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
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
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
        expect(mockCreateTaskFromPlanning).toHaveBeenCalledWith("session-123", undefined);
        expect(mockOnTaskCreated).toHaveBeenCalledWith(createdTask);
      });
    });
  });

  describe("Breakdown view", () => {
    it("renders and updates subtask size dropdown", async () => {
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        setTimeout(() => {
          handlers.onSummary?.(mockSummary);
        }, 10);

        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      mockStartPlanningBreakdown.mockResolvedValue({
        sessionId: "session-123",
        subtasks: [
          {
            id: "subtask-1",
            title: "Design auth schema",
            description: "Design the auth data model",
            suggestedSize: "M",
            dependsOn: [],
          },
          {
            id: "subtask-2",
            title: "Implement auth endpoints",
            description: "Create login/signup endpoints",
            suggestedSize: "S",
            dependsOn: ["subtask-1"],
          },
        ],
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      fireEvent.click(screen.getByText("Break into Tasks"));

      await waitFor(() => {
        expect(mockStartPlanningBreakdown).toHaveBeenCalledWith("session-123", undefined);
      });

      await waitFor(() => {
        expect(screen.getByText("Create Tasks")).toBeDefined();
      });

      const firstSubtask = screen.getByTestId("subtask-item-0");
      const sizeSelect = within(firstSubtask).getByRole("combobox") as HTMLSelectElement;

      expect(sizeSelect.value).toBe("M");
      expect(Array.from(sizeSelect.options).map((option) => option.textContent)).toEqual([
        "S",
        "M",
        "L",
      ]);

      fireEvent.change(sizeSelect, { target: { value: "L" } });
      expect(sizeSelect.value).toBe("L");
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
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
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
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
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

      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
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

      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
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

  describe("Modal close behavior", () => {
    it("no confirmation shown when no progress made (initial state)", () => {
      const confirmSpy = vi.spyOn(window, "confirm");

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

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(mockCancelPlanning).not.toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("closes active question session without canceling server session", async () => {
      const confirmSpy = vi.spyOn(window, "confirm");

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      fireEvent.click(screen.getByLabelText("Close"));

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(mockCancelPlanning).not.toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("closes summary view without canceling server session", async () => {
      const confirmSpy = vi.spyOn(window, "confirm");

      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        setTimeout(() => {
          handlers.onSummary?.(mockSummary);
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

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      fireEvent.click(screen.getByLabelText("Close"));

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(mockCancelPlanning).not.toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("closes via overlay without canceling server session", async () => {
      const confirmSpy = vi.spyOn(window, "confirm");

      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      const overlay = container.querySelector(".modal-overlay");
      expect(overlay).not.toBeNull();
      fireEvent.click(overlay!);

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(mockCancelPlanning).not.toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("closes during loading state without canceling server session", async () => {
      const confirmSpy = vi.spyOn(window, "confirm");

      mockConnectPlanningStream.mockImplementationOnce(() => ({
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      }));

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Generating next question...")).toBeDefined();
      });

      fireEvent.click(screen.getByLabelText("Close"));

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(mockCancelPlanning).not.toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("disconnects SSE stream on close", async () => {
      const closeSpy = vi.fn();

      mockConnectPlanningStream.mockImplementationOnce(() => ({
        close: closeSpy,
        isConnected: vi.fn().mockReturnValue(true),
      }));

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Generating next question...")).toBeDefined();
      });

      fireEvent.click(screen.getByLabelText("Close"));

      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(mockCancelPlanning).not.toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });
  });
});
