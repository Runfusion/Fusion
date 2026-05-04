import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, renderHook, screen, fireEvent, waitFor, within } from "@testing-library/react";
import * as api from "../../api";
import { PlanningModeModal } from "../PlanningModeModal";
import { TaskDetailModal } from "../TaskDetailModal";
import { useSessionLock } from "../../hooks/useSessionLock";
import { getSessionTabId } from "../../utils/getSessionTabId";
import type { MergeResult } from "@fusion/core";
import {
  mockStartPlanning,
  mockStartPlanningStreaming,
  mockCreatePlanningDraft,
  mockConnectPlanningStream,
  mockRespondToPlanning,
  mockRetryPlanningSession,
  mockCancelPlanning,
  mockStopPlanningGeneration,
  mockUpdatePlanningSessionDraft,
  mockCreateTaskFromPlanning,
  mockStartPlanningBreakdown,
  mockCreateTasksFromPlanning,
  mockFetchAiSession,
  mockParseConversationHistory,
  mockFetchModels,
  mockAcquireSessionLock,
  mockReleaseSessionLock,
  mockForceAcquireSessionLock,
  mockUploadAttachment,
  mockDeleteAttachment,
  mockUpdateTask,
  mockPauseTask,
  mockUnpauseTask,
  mockFetchTaskDetail,
  mockRequestSpecRevision,
  mockApprovePlan,
  mockRejectPlan,
  mockRefineTask,
  mockFetchAiSessions,
  mockConfirm,
  mockUseViewportMode,
  mockUseMobileKeyboard,
  mockTasks,
  mockModels,
  mockQuestion,
  mockSummary,
  mockTaskDetail,
  MockEventSource,
  getMediaBlocks,
  mockViewport,
} from "./PlanningModeModal.test-helpers";

vi.mock("../../api", () => ({
  startPlanning: (...args: any[]) => mockStartPlanning(...args),
  startPlanningStreaming: (...args: any[]) => mockStartPlanningStreaming(...args),
  createPlanningDraft: (...args: any[]) => mockCreatePlanningDraft(...args),
  connectPlanningStream: (...args: any[]) => mockConnectPlanningStream(...args),
  respondToPlanning: (...args: any[]) => mockRespondToPlanning(...args),
  retryPlanningSession: (...args: any[]) => mockRetryPlanningSession(...args),
  cancelPlanning: (...args: any[]) => mockCancelPlanning(...args),
  stopPlanningGeneration: (...args: any[]) => mockStopPlanningGeneration(...args),
  updatePlanningSessionDraft: (...args: any[]) => mockUpdatePlanningSessionDraft(...args),
  createTaskFromPlanning: (...args: any[]) => mockCreateTaskFromPlanning(...args),
  startPlanningBreakdown: (...args: any[]) => mockStartPlanningBreakdown(...args),
  createTasksFromPlanning: (...args: any[]) => mockCreateTasksFromPlanning(...args),
  fetchAiSession: (...args: any[]) => mockFetchAiSession(...args),
  parseConversationHistory: (...args: any[]) => mockParseConversationHistory(...args),
  acquireSessionLock: (...args: any[]) => mockAcquireSessionLock(...args),
  releaseSessionLock: (...args: any[]) => mockReleaseSessionLock(...args),
  forceAcquireSessionLock: (...args: any[]) => mockForceAcquireSessionLock(...args),
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
  fetchAiSessions: (...args: any[]) => mockFetchAiSessions(...args),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: () => mockUseViewportMode(),
}));

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: (...args: any[]) => mockUseMobileKeyboard(...args),
}));

describe("PlanningModeModal", () => {
  const mockOnClose = vi.fn();
  const mockOnTaskCreated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
    MockEventSource.reset();
    vi.stubGlobal("EventSource", MockEventSource as any);
    window.sessionStorage.clear();
    // Default to desktop viewport; mobile-specific tests override per-test.
    mockViewport("desktop");
    
    // Default mock for streaming
    mockStartPlanningStreaming.mockResolvedValue({ sessionId: "session-123" });
    // Server's createDraftSession always returns the placeholder title; the
    // real summarized title only arrives later via blur/close summarize or
    // when the session transitions out of draft. Mirror that in the mock so
    // the sidebar render rule (preview while title === placeholder) behaves
    // realistically in tests.
    mockCreatePlanningDraft.mockResolvedValue({ sessionId: "draft-123", title: "New planning session" });
    mockRetryPlanningSession.mockResolvedValue({ success: true, sessionId: "session-123" });
    mockStartPlanningBreakdown.mockResolvedValue({ sessionId: "session-123", subtasks: [] });
    mockFetchAiSession.mockResolvedValue(null);
    mockFetchAiSessions.mockResolvedValue([]);
    mockParseConversationHistory.mockImplementation((raw: string) => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    });
    mockFetchModels.mockResolvedValue({
      models: mockModels,
      favoriteProviders: [],
      favoriteModels: [],
      resolvedPlanningProvider: "openai",
      resolvedPlanningModelId: "gpt-4o",
    });
    mockAcquireSessionLock.mockResolvedValue({ acquired: true, currentHolder: null });
    mockReleaseSessionLock.mockResolvedValue(undefined);
    mockForceAcquireSessionLock.mockResolvedValue(undefined);
    mockCancelPlanning.mockResolvedValue(undefined);
    mockUpdatePlanningSessionDraft.mockResolvedValue({ ok: true });
    mockStopPlanningGeneration.mockResolvedValue({ success: true });

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

  describe("Initial-turn reasoning visibility (FN-3274)", () => {
    it("preserves reasoning in conversation history when first question arrives after thinking", async () => {
      let streamHandlers: any;
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers = handlers;
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
        />,
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      // Wait for loading state to appear
      await waitFor(() => {
        expect(screen.getByText("Generating next question...")).toBeDefined();
      });

      // Simulate thinking output arriving during loading
      act(() => {
        streamHandlers.onThinking?.("Analyzing the plan requirements...");
      });

      await waitFor(() => {
        expect(screen.getByText("AI is thinking...")).toBeDefined();
      });

      // Transition to question view
      act(() => {
        streamHandlers.onQuestion?.(mockQuestion);
      });

      // Question should be visible
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      // The reasoning should now be in conversation history as an expandable entry
      expect(screen.getByTestId("conversation-history")).toBeDefined();
      expect(screen.getByText("AI Reasoning")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: /Show AI reasoning/i }));
      expect(screen.getByText("Analyzing the plan requirements...")).toBeDefined();

      // avoid dangling handlers reference lint
      expect(streamHandlers).toBeDefined();
    });

    it("preserves reasoning in conversation history when summary arrives after thinking", async () => {
      let streamHandlers: any;
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers = handlers;
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
        />,
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Generating next question...")).toBeDefined();
      });

      // Simulate thinking output arriving
      act(() => {
        streamHandlers.onThinking?.("Finalizing the planning summary...");
      });

      await waitFor(() => {
        expect(screen.getByText("AI is thinking...")).toBeDefined();
      });

      // Transition directly to summary view
      act(() => {
        streamHandlers.onSummary?.(mockSummary);
      });

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      // The reasoning should be visible in the Q&A disclosure
      fireEvent.click(screen.getByRole("button", { name: "Show user Q&A" }));
      await waitFor(() => {
        expect(screen.getByTestId("conversation-history")).toBeDefined();
      });
      expect(screen.getByText("AI Reasoning")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: /Show AI reasoning/i }));
      expect(screen.getByText("Finalizing the planning summary...")).toBeDefined();

      expect(streamHandlers).toBeDefined();
    });

    it("restores persisted thinkingOutput as conversation history when resuming awaiting_input session", async () => {
      mockConnectPlanningStream.mockImplementationOnce(() => ({
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      }));

      const resumedQuestion: PlanningQuestion = {
        id: "q-current",
        type: "text",
        question: "What should we prioritize next?",
      };

      const restoredHistory = [
        {
          question: {
            id: "q1",
            type: "single_select",
            question: "What scope?",
            options: [{ id: "small", label: "Small" }],
          },
          response: { q1: "small" },
        },
      ];

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-awaiting-reasoning",
        type: "planning",
        status: "awaiting_input",
        title: "Resume with reasoning",
        inputPayload: JSON.stringify({ initialPlan: "Build planning with reasoning" }),
        conversationHistory: JSON.stringify(restoredHistory),
        currentQuestion: JSON.stringify(resumedQuestion),
        result: null,
        thinkingOutput: "Server-side reasoning captured during generation",
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
          resumeSessionId="session-awaiting-reasoning"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("What should we prioritize next?")).toBeDefined();
      });

      // The persisted thinkingOutput should appear as a conversation history entry
      const history = screen.getByTestId("conversation-history");
      expect(history).toBeDefined();

      // Should show the existing Q&A plus the AI Reasoning entry
      expect(screen.getByText("What scope?")).toBeDefined();
      expect(screen.getByText("AI Reasoning")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: /Show AI reasoning/i }));
      expect(screen.getByText("Server-side reasoning captured during generation")).toBeDefined();
    });

    it("does not create duplicate reasoning entries on repeated transitions", async () => {
      let streamHandlers: any;
      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers = handlers;
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      const secondQuestion: PlanningQuestion = {
        id: "q-second",
        type: "text",
        question: "Any additional requirements?",
      };

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Generating next question...")).toBeDefined();
      });

      // Emit thinking then question
      act(() => {
        streamHandlers.onThinking?.("First reasoning block");
      });
      act(() => {
        streamHandlers.onQuestion?.(mockQuestion);
      });

      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      // Answer the question
      fireEvent.click(screen.getByText("Medium"));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalled();
      });

      // Simulate thinking for second question then emit second question
      act(() => {
        streamHandlers.onThinking?.("Second reasoning block");
      });
      act(() => {
        streamHandlers.onQuestion?.(secondQuestion);
      });

      await waitFor(() => {
        expect(screen.getByText("Any additional requirements?")).toBeDefined();
      });

      // Conversation history should contain both reasoning entries without duplicates
      const history = screen.getByTestId("conversation-history");
      expect(history).toBeDefined();

      // Should have Q1, reasoning1, reasoning2 entries
      const reasoningButtons = screen.getAllByRole("button", { name: /Show AI reasoning/i });
      // First reasoning button should be next to Q1, second should be standalone
      // There should be exactly 2 reasoning entries (not duplicated)
      expect(reasoningButtons.length).toBe(2);

      expect(streamHandlers).toBeDefined();
    });

    it("preserves reasoning when answer submission transitions back to loading then question", async () => {
      let streamHandlers: any;
      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers = handlers;
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      const secondQuestion: PlanningQuestion = {
        id: "q-requirements",
        type: "text",
        question: "What are the key requirements?",
      };

      mockRespondToPlanning.mockImplementation(async () => {
        // Simulate thinking then second question via the existing stream
        setTimeout(() => {
          streamHandlers?.onThinking?.("Thinking about requirements...");
          streamHandlers?.onQuestion?.(secondQuestion);
        }, 10);
        return { sessionId: "session-123", currentQuestion: null, summary: null };
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      // Wait for first thinking and question
      await waitFor(() => {
        expect(screen.getByText("Generating next question...")).toBeDefined();
      });

      act(() => {
        streamHandlers.onThinking?.("Initial analysis...");
      });
      act(() => {
        streamHandlers.onQuestion?.(mockQuestion);
      });

      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      // Answer the first question
      fireEvent.click(screen.getByText("Medium"));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      // Wait for second question to arrive
      await waitFor(() => {
        expect(screen.getByText("What are the key requirements?")).toBeDefined();
      }, { timeout: 3000 });

      // Conversation history should contain the first Q&A pair and initial reasoning
      const history = screen.getByTestId("conversation-history");
      expect(history).toBeDefined();
      expect(screen.getByText("What is the scope?")).toBeDefined();
      expect(screen.getByText("Medium")).toBeDefined();

      expect(streamHandlers).toBeDefined();
    });
  });

  describe("Question view", () => {
    it("renders single_select question with options", async () => {
      const { container } = render(
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
        expect(screen.getByText("Small")).toBeDefined();
        expect(screen.getByText("Medium")).toBeDefined();
        expect(screen.getByText("Large")).toBeDefined();
      });

      expect(container.querySelector(".planning-question-form > .planning-view-scroll")).not.toBeNull();
      expect(container.querySelector(".planning-question-form > .planning-actions")).not.toBeNull();
    });

    it("shows comment textarea for single_select questions", async () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      expect(await screen.findByPlaceholderText("Add any extra context or direction...")).toBeInTheDocument();
    });

    it("does not show comment textarea for text questions", async () => {
      const textQuestion: PlanningQuestion = {
        id: "q-text",
        type: "text",
        question: "Describe your requirements",
      };

      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        setTimeout(() => {
          handlers.onQuestion?.(textQuestion);
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
        />,
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await screen.findByText("Describe your requirements");
      expect(screen.queryByPlaceholderText("Add any extra context or direction...")).not.toBeInTheDocument();
    });

    it("includes _comment in response when comment is filled", async () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await screen.findByText("What is the scope?");
      fireEvent.click(screen.getByText("Medium"));
      fireEvent.change(screen.getByPlaceholderText("Add any extra context or direction..."), {
        target: { value: "Prioritize API first" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalledWith(
          "session-123",
          expect.objectContaining({ "q-scope": "medium", _comment: "Prioritize API first" }),
          undefined,
          expect.any(String),
        );
      });
    });

    it("omits _comment when comment is empty", async () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await screen.findByText("What is the scope?");
      fireEvent.click(screen.getByText("Medium"));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalledWith(
          "session-123",
          expect.not.objectContaining({ _comment: expect.anything() }),
          undefined,
          expect.any(String),
        );
      });
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
          onTasksCreated={vi.fn()}
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
            onTasksCreated={vi.fn()}
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

    it("connects to stream when resuming awaiting_input session to receive real-time updates", async () => {
      // This test verifies the fix for the mismatch where a session was advertised as
      // needing input but the resume path initially entered loading state.
      // The modal should connect to the stream for awaiting_input sessions to receive
      // real-time updates (thinking output, next question, etc.).
      const resumedQuestion: PlanningQuestion = {
        id: "q-priority",
        type: "single_select",
        question: "What's your priority?",
        options: [
          { id: "speed", label: "Speed" },
          { id: "quality", label: "Quality" },
          { id: "cost", label: "Cost" },
        ],
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-awaiting-stream-1",
        type: "planning",
        status: "awaiting_input",
        title: "Resume with stream",
        inputPayload: JSON.stringify({ initialPlan: "Build planning with stream" }),
        conversationHistory: "[]",
        currentQuestion: JSON.stringify(resumedQuestion),
        result: null,
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      // Track stream connections
      let streamConnectedSessionId: string | null = null;
      mockConnectPlanningStream.mockImplementationOnce((sessionId: string, _projectId: string | undefined, _handlers: any) => {
        streamConnectedSessionId = sessionId;
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
          resumeSessionId="session-awaiting-stream-1"
        />,
      );

      // Flush React state updates from the resume effect
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Session should be fetched
      await waitFor(() => {
        expect(mockFetchAiSession).toHaveBeenCalledWith("session-awaiting-stream-1");
      });

      // Question should appear immediately from session data
      await waitFor(() => {
        expect(screen.getByText("What's your priority?")).toBeDefined();
      });

      // Modal should connect to the stream for real-time updates
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      // Verify stream connection was established
      expect(mockConnectPlanningStream).toHaveBeenCalled();
      expect(streamConnectedSessionId).toBe("session-awaiting-stream-1");

      // Should NOT be stuck in loading state
      expect(screen.queryByText("Generating next question...")).toBeNull();
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
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Create Single Task")).toBeDefined();
      });

      fireEvent.click(screen.getByText("Create Single Task"));

      await waitFor(() => {
        expect(mockCreateTaskFromPlanning).toHaveBeenCalledWith("session-123", mockSummary, undefined);
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
        expect(mockStartPlanningBreakdown).toHaveBeenCalledWith("session-123", mockSummary, undefined);
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

});
