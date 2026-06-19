/*
FNXC:DashboardTests 2026-06-14-08:31:
FN-6441 rescued this orphaned component test after standalone dashboard-app execution passed without assertion, timeout, or source-code changes. Keep the planning modal UI-interaction coverage in app backfill so question flow, summary, and breakdown interactions remain executed after leaving the skip-list.

FNXC:DashboardTests 2026-06-14-08:32:
PlanningModeModal calls useToast(), which throws without a ToastProvider. These tests render it bare, so the hook stays mocked in the same style as PlanningModeModal.autosize.test.tsx instead of introducing broad provider wiring during skip-list rescue.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({
    addToast: vi.fn(),
    removeToast: vi.fn(),
    toasts: [],
  }),
}));

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});
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
  api: vi.fn().mockResolvedValue({ sessions: [] }),
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
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  fetchModels: (...args: any[]) => mockFetchModels(...args),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  fetchBoardWorkflows: vi.fn().mockResolvedValue({ flagEnabled: false, defaultWorkflowId: "", workflows: [], taskWorkflowIds: {} }),
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
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  getViewportMode: () => mockUseViewportMode(),
  isMobileViewport: () => mockUseViewportMode() === "mobile",
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
          onTasksCreated={vi.fn()}
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
          onTasksCreated={vi.fn()}
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
          onTasksCreated={vi.fn()}
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
          onTasksCreated={vi.fn()}
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
            render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      // Click X button while still in initial state (no planning started)
      const closeButton = screen.getByLabelText("Close");
      fireEvent.click(closeButton);

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockCancelPlanning).not.toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("closes active question session WITHOUT abandoning the server session", async () => {
            render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
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

      expect(mockConfirm).not.toHaveBeenCalled();
      // Closing the modal should leave the server session intact so it stays in the sidebar list
      expect(mockCancelPlanning).not.toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("closes summary view WITHOUT abandoning the server session", async () => {
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

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      fireEvent.click(screen.getByLabelText("Close"));

      expect(mockConfirm).not.toHaveBeenCalled();
      // Completed sessions remain available to resume; closing must not cancel them
      expect(mockCancelPlanning).not.toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("closes via overlay WITHOUT abandoning the server session", async () => {
            const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
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
      // Simulate a real overlay click — both mousedown and click must originate
      // on the overlay, otherwise the dismissal guard suppresses close.
      fireEvent.mouseDown(overlay!);
      fireEvent.click(overlay!);

      expect(mockConfirm).not.toHaveBeenCalled();
      // Sessions persist in the sidebar; overlay click should not cancel
      expect(mockCancelPlanning).not.toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("closes during loading state WITHOUT abandoning the server session", async () => {
            mockConnectPlanningStream.mockImplementationOnce(() => ({
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      }));

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
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

      expect(mockConfirm).not.toHaveBeenCalled();
      // Loading state means the session is still being generated server-side; preserve it
      expect(mockCancelPlanning).not.toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("close (X) drops the local stream but preserves the server session", async () => {
      // The "Send to background" button was removed — closing the modal now
      // has the same semantics: tear down the SSE stream, keep the persisted
      // session alive so the user can reopen and resume it.
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
          onTasksCreated={vi.fn()}
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
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("disconnects the SSE stream on close (but keeps the server session)", async () => {
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
          onTasksCreated={vi.fn()}
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
      // The local SSE stream closes on modal close, but the server session is preserved
      // for later resume from the sidebar list.
      expect(mockCancelPlanning).not.toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe("Mobile empty-session routing (FN-3269)", () => {
    it("shows detail pane on mobile when session list is empty", async () => {
      mockViewport("mobile");
      mockFetchAiSessions.mockResolvedValue([]);

      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(mockFetchAiSessions).toHaveBeenCalled();
      });

      // Wait for the session list to load and the routing effect to fire
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // The modal body should show detail pane (composer), not list pane
      const body = container.querySelector(".planning-modal-body");
      expect(body?.classList.contains("planning-modal-body--show-detail")).toBe(true);
      expect(body?.classList.contains("planning-modal-body--show-list")).toBe(false);

      // The composer textarea should be visible
      expect(screen.getByPlaceholderText(/e.g., Build a user authentication/)).toBeDefined();
    });

    it("stays on list pane on mobile when sessions exist", async () => {
      mockViewport("mobile");
      mockFetchAiSessions.mockResolvedValue([
        {
          id: "session-existing",
          type: "planning",
          status: "complete",
          title: "Existing session",
          preview: "An existing planning session",
          projectId: null,
          lockedByTab: null,
          updatedAt: new Date().toISOString(),
          archived: false,
        },
      ]);

      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(mockFetchAiSessions).toHaveBeenCalled();
      });

      // Wait one more tick to let state updates settle
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // The modal body should show list pane (sidebar), not detail pane
      const body = container.querySelector(".planning-modal-body");
      expect(body?.classList.contains("planning-modal-body--show-list")).toBe(true);
      expect(body?.classList.contains("planning-modal-body--show-detail")).toBe(false);
    });

    it("does not auto-show detail pane on desktop with empty sessions", async () => {
      mockViewport("desktop");
      mockFetchAiSessions.mockResolvedValue([]);

      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(mockFetchAiSessions).toHaveBeenCalled();
      });

      // Wait one more tick to let state updates settle
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Desktop shows both panes in split view regardless of mobileShowDetail.
      // Both sidebar and detail pane should be present in the DOM.
      expect(container.querySelector(".planning-sidebar")).not.toBeNull();
      expect(container.querySelector(".planning-detail")).not.toBeNull();
      // The mobile-only back button should NOT be visible (it's gated on mobileShowDetail,
      // which stays false on desktop since the routing effect skips non-mobile viewports).
      expect(container.querySelector(".planning-mobile-back")).toBeNull();
    });
  });

  describe("Summary markdown preview toggle", () => {
    it("toggles description between plain textarea and formatted markdown preview", async () => {
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        setTimeout(() => {
          handlers.onSummary?.({
            ...mockSummary,
            description: "## Heading\n\n- item\n\n**bold**",
          });
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
        />,
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      expect(container.querySelector(".planning-textarea")).not.toBeNull();
      expect(container.querySelector(".planning-description-preview")).toBeNull();

      fireEvent.click(screen.getByTestId("planning-description-markdown-toggle"));

      await waitFor(() => {
        expect(container.querySelector(".planning-description-preview")).not.toBeNull();
        expect(screen.getByRole("heading", { level: 2, name: "Heading" })).toBeDefined();
        expect(container.querySelector("strong")?.textContent).toBe("bold");
      });

      fireEvent.click(screen.getByTestId("planning-description-markdown-toggle"));

      await waitFor(() => {
        expect(container.querySelector(".planning-textarea")).not.toBeNull();
      });
    });
  });

});
