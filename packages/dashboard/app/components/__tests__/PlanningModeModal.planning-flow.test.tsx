import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});
import { act, render, renderHook, screen, fireEvent, waitFor, within } from "@testing-library/react";
import * as api from "../../api";
import { PlanningModeModal, dedupeSessionsById } from "../PlanningModeModal";
import { TaskDetailModal } from "../TaskDetailModal";
import { useSessionLock } from "../../hooks/useSessionLock";
import { getSessionTabId } from "../../utils/getSessionTabId";
import type { MergeResult } from "@fusion/core";
const mockUseAiSessionSync = vi.fn();

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
  mockDeleteAiSession,
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

const mockAddToast = vi.fn();

vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({
    addToast: mockAddToast,
    removeToast: vi.fn(),
    toasts: [],
  }),
}));

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
  deleteAiSession: (...args: any[]) => mockDeleteAiSession(...args),
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

vi.mock("../../hooks/useAiSessionSync", () => ({
  useAiSessionSync: (...args: any[]) => mockUseAiSessionSync(...args),
}));

describe("PlanningModeModal", () => {
  const mockOnClose = vi.fn();
  const mockOnTaskCreated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockAddToast.mockReset();
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
    mockDeleteAiSession.mockResolvedValue(undefined);
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
    mockUseAiSessionSync.mockReturnValue({
      activeTabMap: new Map(),
      broadcastUpdate: vi.fn(),
      broadcastCompleted: vi.fn(),
      broadcastLock: vi.fn(),
      broadcastUnlock: vi.fn(),
      broadcastHeartbeat: vi.fn(),
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

  describe("Planning flow", () => {
    it("starts planning and shows question view", async () => {
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

      // Wait for streaming to be called
      await waitFor(() => {
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build auth system", undefined, undefined, {
          planningDepth: "medium",
          customQuestionCount: undefined,
        }, undefined);
      });

      // Should transition to question view via streaming
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });
    });

    it("shows locked overlay and allows take-control", async () => {
      window.sessionStorage.setItem("fusion-tab-id", "tab-self");
      mockAcquireSessionLock.mockResolvedValueOnce({ acquired: false, currentHolder: "tab-other" });

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
        expect(screen.getByTestId("session-lock-overlay")).toBeDefined();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Take Control"));
      });

      await waitFor(() => {
        expect(mockForceAcquireSessionLock).toHaveBeenCalledWith("session-123", "tab-self");
      });

      await waitFor(() => {
        expect(screen.queryByTestId("session-lock-overlay")).toBeNull();
      });
    });

    it("does not render duplicate inline lock text while takeover overlay handles lock state", async () => {
      window.sessionStorage.setItem("fusion-tab-id", "tab-self");
      mockAcquireSessionLock.mockResolvedValueOnce({ acquired: false, currentHolder: "tab-other" });
      mockUseAiSessionSync.mockReturnValueOnce({
        activeTabMap: new Map([
          [
            "session-123",
            {
              tabId: "tab-other",
              stale: false,
            },
          ],
        ]),
        broadcastUpdate: vi.fn(),
        broadcastCompleted: vi.fn(),
        broadcastLock: vi.fn(),
        broadcastUnlock: vi.fn(),
        broadcastHeartbeat: vi.fn(),
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
        expect(screen.getByTestId("session-lock-overlay")).toBeDefined();
      });

      expect(screen.getByText("This session is active in another tab")).toBeDefined();
      expect(screen.queryByText("Session is active in another tab.")).toBeNull();
      expect(screen.getByRole("button", { name: "Take Control" })).toBeDefined();
    });

    it("allows normal question interaction when lock is acquired", async () => {
      window.sessionStorage.setItem("fusion-tab-id", "tab-self");

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
        expect(screen.queryByTestId("session-lock-overlay")).toBeNull();
      });

      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      fireEvent.click(screen.getByText("Small"));
      fireEvent.click(screen.getByText("Continue"));

      await waitFor(
        () => {
          expect(mockRespondToPlanning).toHaveBeenCalledWith(
            "session-123",
            { "q-scope": "small" },
            undefined,
            "tab-self",
          );
        },
        // waitFor's private 1s default (independent of vitest testTimeout) has
        // flaked under loaded CI shards; the click->respond chain crosses
        // several state-update hops. Generous bound, still fails fast locally.
        { timeout: 5000 },
      );
    });

    it("shows stop action in loading and stops generation", async () => {
      let streamHandlers: any;
      const closeSpy = vi.fn();
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers = handlers;
        return {
          close: closeSpy,
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
        expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Stop" }));

      await waitFor(() => {
        expect(mockStopPlanningGeneration).toHaveBeenCalledWith("session-123", undefined, expect.any(String));
      });
      expect(closeSpy).toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.getByText("Generation stopped by user. You can retry or start a new session.")).toBeDefined();
      });
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();

      // avoid dangling handlers reference lint
      expect(streamHandlers).toBeDefined();
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
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });

      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Rate limit exceeded")).toBeDefined();
      });
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    });

    it("retries from error state and reconnects stream", async () => {
      let streamAttempt = 0;
      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamAttempt += 1;
        if (streamAttempt === 1) {
          setTimeout(() => handlers.onError?.("Temporary failure"), 10);
        } else {
          setTimeout(() => handlers.onQuestion?.(mockQuestion), 10);
        }

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
        expect(screen.getByText("Temporary failure")).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(mockRetryPlanningSession).toHaveBeenCalledWith("session-123", undefined, expect.any(String));
      });
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });
      expect(mockConnectPlanningStream).toHaveBeenCalledTimes(2);
    });

    it("auto-recovers from a stream error when server session is still generating", async () => {
      let streamAttempt = 0;
      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamAttempt += 1;
        if (streamAttempt === 1) {
          setTimeout(() => handlers.onError?.("Connection lost"), 10);
        }

        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-123",
        type: "planning",
        status: "generating",
        title: "Build auth system",
        inputPayload: JSON.stringify({ initialPlan: "Build auth system" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: null,
        thinkingOutput: "Still thinking...",
        error: null,
        projectId: null,
        lockedByTab: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lockedAt: null,
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

      // No manual retry button — onError silently re-fetches the session,
      // sees status="generating", and reconnects without surfacing the error.
      await waitFor(() => {
        expect(mockFetchAiSession).toHaveBeenCalledWith("session-123");
        expect(mockConnectPlanningStream).toHaveBeenCalledTimes(2);
      });
      expect(screen.queryByText("Connection lost")).toBeNull();
    });

    it("auto-recovers from a stream error when server session is awaiting input", async () => {
      let streamAttempt = 0;
      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamAttempt += 1;
        if (streamAttempt === 1) {
          setTimeout(() => handlers.onError?.("Connection lost"), 10);
        }

        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-123",
        type: "planning",
        status: "awaiting_input",
        title: "Build auth system",
        inputPayload: JSON.stringify({ initialPlan: "Build auth system" }),
        conversationHistory: "[]",
        currentQuestion: JSON.stringify(mockQuestion),
        result: null,
        thinkingOutput: "",
        error: null,
        projectId: null,
        lockedByTab: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lockedAt: null,
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

      // Silent recovery: onError re-fetches the session, sees status=
      // "awaiting_input", and reconnects without surfacing the error.
      await waitFor(() => {
        expect(mockFetchAiSession).toHaveBeenCalledWith("session-123");
        expect(mockConnectPlanningStream).toHaveBeenCalledTimes(2);
      });
      expect(screen.queryByText("Connection lost")).toBeNull();
    });
  });

  describe("Resuming complete sessions", () => {
    function createDeferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    it("FN-4769 shows inline Creating spinner for Create Single Task while task creation is pending", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-spinner-single-task",
        description: "Recovered summary for spinner",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };
      const createTaskDeferred = createDeferred<Task>();

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-spinner-single-task",
        type: "planning",
        status: "complete",
        title: "Resume-spinner-single-task",
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
      mockCreateTaskFromPlanning.mockReturnValueOnce(createTaskDeferred.promise);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-spinner-single-task"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Create Single Task" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Create Single Task" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Creating..." })).toBeDefined();
      });

      createTaskDeferred.resolve({
        id: "FN-4769",
        title: "Created from spinner test",
        description: "",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as Task);

      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });
    });

    it("FN-5912 keeps Break into Tasks labeled while Create Single Task is pending", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-spinner-isolation-single-task",
        description: "Recovered summary for spinner isolation on single-task creation",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };
      const createTaskDeferred = createDeferred<Task>();

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-spinner-isolation-single-task",
        type: "planning",
        status: "complete",
        title: "Resume-spinner-isolation-single-task",
        inputPayload: JSON.stringify({ initialPlan: "Recover and create a single task" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(resumedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      mockCreateTaskFromPlanning.mockReturnValueOnce(createTaskDeferred.promise);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-spinner-isolation-single-task"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Create Single Task" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Create Single Task" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
      });

      expect(screen.getByRole("button", { name: "Break into Tasks" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Breaking down..." })).toBeNull();

      createTaskDeferred.resolve({
        id: "FN-5912",
        title: "Created from spinner isolation test",
        description: "",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as Task);

      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });
    });

    it("FN-4769 shows inline Breaking down spinner for Break into Tasks while breakdown start is pending", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-spinner-breakdown-start",
        description: "Recovered summary for breakdown start spinner",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };
      const breakdownDeferred = createDeferred<{ sessionId: string; subtasks: any[] }>();

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-spinner-breakdown-start",
        type: "planning",
        status: "complete",
        title: "Resume-spinner-breakdown-start",
        inputPayload: JSON.stringify({ initialPlan: "Recover and break down" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(resumedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      mockStartPlanningBreakdown.mockReturnValueOnce(breakdownDeferred.promise);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-spinner-breakdown-start"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Break into Tasks" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Break into Tasks" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Breaking down..." })).toBeDefined();
      });

      breakdownDeferred.resolve({
        sessionId: "session-spinner-breakdown-start",
        subtasks: [
          {
            id: "subtask-1",
            title: "First subtask",
            description: "First description",
            suggestedSize: "M",
            dependsOn: [],
          },
        ],
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Create Tasks" })).toBeDefined();
      });
    });

    it("FN-5912 keeps Create Single Task labeled while Break into Tasks is pending", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-spinner-isolation-breakdown",
        description: "Recovered summary for spinner isolation on breakdown start",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };
      const breakdownDeferred = createDeferred<{ sessionId: string; subtasks: any[] }>();

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-spinner-isolation-breakdown",
        type: "planning",
        status: "complete",
        title: "Resume-spinner-isolation-breakdown",
        inputPayload: JSON.stringify({ initialPlan: "Recover and break down into tasks" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(resumedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      mockStartPlanningBreakdown.mockReturnValueOnce(breakdownDeferred.promise);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-spinner-isolation-breakdown"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Break into Tasks" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Break into Tasks" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Breaking down..." })).toBeDisabled();
      });

      expect(screen.getByRole("button", { name: "Create Single Task" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Creating..." })).toBeNull();

      breakdownDeferred.resolve({
        sessionId: "session-spinner-isolation-breakdown",
        subtasks: [
          {
            id: "subtask-1",
            title: "First subtask",
            description: "First description",
            suggestedSize: "M",
            dependsOn: [],
          },
        ],
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Create Tasks" })).toBeDefined();
      });
    });

    it("FN-4769 shows inline Creating spinner for Create Tasks while breakdown creation is pending", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-spinner-breakdown-create",
        description: "Recovered summary for breakdown create spinner",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };
      const createTasksDeferred = createDeferred<{ tasks: Task[] }>();

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-spinner-breakdown-create",
        type: "planning",
        status: "complete",
        title: "Resume-spinner-breakdown-create",
        inputPayload: JSON.stringify({ initialPlan: "Recover and create tasks" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(resumedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      mockStartPlanningBreakdown.mockResolvedValueOnce({
        sessionId: "session-spinner-breakdown-create",
        subtasks: [
          {
            id: "subtask-1",
            title: "First subtask",
            description: "First description",
            suggestedSize: "M",
            dependsOn: [],
          },
        ],
      });
      mockCreateTasksFromPlanning.mockReturnValueOnce(createTasksDeferred.promise);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-spinner-breakdown-create"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Break into Tasks" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Break into Tasks" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Create Tasks" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Create Tasks" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Creating..." })).toBeDefined();
      });

      createTasksDeferred.resolve({ tasks: [] });

      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });
    });

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
      expect((screen.getByRole("combobox", { name: "Suggested Size" }) as HTMLSelectElement).value).toBe("L");
      expect(screen.getByText("Deliverable A")).toBeDefined();
      expect(screen.getByText("Deliverable B")).toBeDefined();
    });

    it("restores the textarea and reattaches the draft id when reopening a persisted draft", async () => {
      const draftPlan = "Persisted draft text the user typed before closing the modal";
      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-draft-1",
        type: "planning",
        status: "draft",
        title: "New planning session",
        inputPayload: JSON.stringify({ initialPlan: draftPlan }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: null,
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
          resumeSessionId="session-draft-1"
        />,
      );

      await waitFor(() => {
        expect(mockFetchAiSession).toHaveBeenCalledWith("session-draft-1");
      });

      // The draft is restored to the editor (initial view), not surfaced as a
      // question or summary, and the textarea contains exactly the persisted
      // initialPlan so the user can keep editing or click Start Planning.
      const textarea = await screen.findByDisplayValue(draftPlan);
      expect((textarea as HTMLTextAreaElement).tagName).toBe("TEXTAREA");
      expect(screen.getByText("Start Planning")).toBeDefined();
    });

    it("restores the persisted model override when reopening a draft so Start Planning uses it", async () => {
      // The draft was created under an explicit anthropic/claude-opus model.
      // Reopening must restore that selection into the modal's local state
      // so a subsequent Start Planning click uses it instead of silently
      // falling back to whatever the dropdown currently defaults to. The
      // server-side round-trip is covered separately in planning.test.ts;
      // this test pins the React-state restoration.
      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-draft-with-model",
        type: "planning",
        status: "draft",
        title: "New planning session",
        inputPayload: JSON.stringify({
          initialPlan: "Plan that needs a specific model",
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
        }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: null,
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
          resumeSessionId="session-draft-with-model"
        />,
      );

      // Wait for the textarea to be populated from the draft — proves the
      // reopen path ran and the modal is in the editable initial view.
      await screen.findByDisplayValue("Plan that needs a specific model");

      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith(
          "Plan that needs a specific model",
          undefined,
          { planningModelProvider: "anthropic", planningModelId: "claude-sonnet-4-5" },
          { planningDepth: "medium", customQuestionCount: undefined },
          "session-draft-with-model",
        );
      });
    });

    it("lists planning history rows and restores the selected session to the correct view", async () => {
      const completedSummary: PlanningSummary = {
        title: "Completed planning session",
        description: "Recovered summary from history",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement"],
      };

      mockFetchAiSessions.mockResolvedValueOnce([
        {
          id: "session-history-complete",
          type: "planning",
          status: "complete",
          title: "Completed planning session",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
          archived: false,
        },
        {
          id: "session-history-draft",
          type: "planning",
          status: "draft",
          title: "New planning session",
          preview: "Draft plan from history",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          archived: false,
        },
      ]);
      mockFetchAiSession.mockImplementation(async (sessionId: string) => {
        if (sessionId === "session-history-complete") {
          return {
            id: "session-history-complete",
            type: "planning",
            status: "complete",
            title: completedSummary.title,
            inputPayload: JSON.stringify({ initialPlan: "Recover completed session" }),
            conversationHistory: "[]",
            currentQuestion: null,
            result: JSON.stringify(completedSummary),
            thinkingOutput: "",
            error: null,
            projectId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          };
        }

        return {
          id: "session-history-draft",
          type: "planning",
          status: "draft",
          title: "New planning session",
          inputPayload: JSON.stringify({ initialPlan: "Draft plan from history" }),
          conversationHistory: "[]",
          currentQuestion: null,
          result: null,
          thinkingOutput: "",
          error: null,
          projectId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
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

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Completed planning session/i })).toBeDefined();
      });
      expect(screen.getByRole("button", { name: /Draft plan from history/i })).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: /Completed planning session/i }));

      await waitFor(() => {
        expect(mockFetchAiSession).toHaveBeenCalledWith("session-history-complete");
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });
      expect(screen.queryByPlaceholderText(/e.g., Build a user authentication/)).toBeNull();
      expect(screen.getByDisplayValue("Recovered summary from history")).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: /Draft plan from history/i }));

      await waitFor(() => {
        expect(mockFetchAiSession).toHaveBeenCalledWith("session-history-draft");
      });
      expect(screen.getByDisplayValue("Draft plan from history")).toBeDefined();
      expect(screen.getByRole("button", { name: "Start Planning" })).toBeDefined();
    });

    it("shows retry panel when resuming an errored session and retries the same session", async () => {
      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-error-1",
        type: "planning",
        status: "error",
        title: "Errored planning",
        inputPayload: JSON.stringify({ initialPlan: "Recover planning" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: null,
        thinkingOutput: "",
        error: "Session interrupted",
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      mockRetryPlanningSession.mockResolvedValueOnce({ success: true, sessionId: "session-error-1" });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-error-1"
        />,
      );

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Session interrupted");
      });
      expect(screen.queryByRole("button", { name: "Start Planning" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(mockRetryPlanningSession).toHaveBeenCalledWith("session-error-1", undefined, expect.any(String));
      });
    });

    it("shows retry panel when selecting an errored session from the sidebar", async () => {
      mockFetchAiSessions.mockResolvedValueOnce([
        {
          id: "session-sidebar-error",
          type: "planning",
          status: "error",
          title: "Sidebar errored session",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
          archived: false,
        },
      ]);
      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-sidebar-error",
        type: "planning",
        status: "error",
        title: "Sidebar errored session",
        inputPayload: JSON.stringify({ initialPlan: "Recover sidebar session" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: null,
        thinkingOutput: "",
        error: "Sidebar session interrupted",
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
      mockRetryPlanningSession.mockResolvedValueOnce({ success: true, sessionId: "session-sidebar-error" });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Sidebar errored session/i })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: /Sidebar errored session/i }));

      await waitFor(() => {
        expect(mockFetchAiSession).toHaveBeenCalledWith("session-sidebar-error");
        expect(screen.getByRole("alert")).toHaveTextContent("Sidebar session interrupted");
      });
      expect(screen.queryByRole("button", { name: "Start Planning" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(mockRetryPlanningSession).toHaveBeenCalledWith("session-sidebar-error", undefined, expect.any(String));
      });
    });

    it("routes malformed persisted result data from sidebar selection to the recoverable error view", async () => {
      mockFetchAiSessions.mockResolvedValueOnce([
        {
          id: "session-malformed-result",
          type: "planning",
          status: "complete",
          title: "Malformed result session",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
          archived: false,
        },
      ]);
      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-malformed-result",
        type: "planning",
        status: "complete",
        title: "Malformed result session",
        inputPayload: JSON.stringify({ initialPlan: "Recover malformed result" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: "{",
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
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

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Malformed result session/i })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: /Malformed result session/i }));

      await waitFor(() => {
        expect(mockFetchAiSession).toHaveBeenCalledWith("session-malformed-result");
        expect(screen.getByRole("alert")).toBeDefined();
      });
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
      expect(screen.queryByRole("button", { name: "Start Planning" })).toBeNull();
    });

    it("re-syncs the selected session to the recoverable error view when the modal reopens", async () => {
      const reopenedSummary: PlanningSummary = {
        title: "Reopen then recover",
        description: "First open shows a valid summary",
        suggestedSize: "S",
        suggestedDependencies: [],
        keyDeliverables: ["Recover"],
      };

      mockFetchAiSessions.mockResolvedValue([
        {
          id: "session-reopen-recover",
          type: "planning",
          status: "complete",
          title: "Reopen recover session",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
          archived: false,
        },
      ]);
      mockFetchAiSession
        .mockResolvedValueOnce({
          id: "session-reopen-recover",
          type: "planning",
          status: "complete",
          title: "Reopen recover session",
          inputPayload: JSON.stringify({ initialPlan: "Reopen recover session" }),
          conversationHistory: "[]",
          currentQuestion: null,
          result: JSON.stringify(reopenedSummary),
          thinkingOutput: "",
          error: null,
          projectId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        })
        .mockResolvedValueOnce({
          id: "session-reopen-recover",
          type: "planning",
          status: "complete",
          title: "Reopen recover session",
          inputPayload: JSON.stringify({ initialPlan: "Reopen recover session" }),
          conversationHistory: "[]",
          currentQuestion: null,
          result: "{",
          thinkingOutput: "",
          error: null,
          projectId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z",
        });

      const { rerender } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Reopen recover session/i })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: /Reopen recover session/i }));

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      rerender(
        <PlanningModeModal
          isOpen={false}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      rerender(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(mockFetchAiSession).toHaveBeenLastCalledWith("session-reopen-recover");
        expect(screen.getByRole("alert")).toBeDefined();
      });
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
      expect(screen.queryByRole("button", { name: "Start Planning" })).toBeNull();
    });

    it("quietly falls back to the initial view when a resumed session no longer exists", async () => {
      mockFetchAiSession.mockResolvedValueOnce(null);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-deleted"
        />,
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Start Planning" })).toBeDefined();
      });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("Failed to load session")).toBeNull();
    });

    it("quietly falls back to the initial view when a sidebar session no longer exists", async () => {
      mockFetchAiSessions.mockResolvedValueOnce([
        {
          id: "session-sidebar-deleted",
          type: "planning",
          status: "complete",
          title: "Sidebar deleted session",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
          archived: false,
        },
      ]);
      mockFetchAiSession.mockResolvedValueOnce(null);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Sidebar deleted session/i })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: /Sidebar deleted session/i }));

      await waitFor(() => {
        expect(mockFetchAiSession).toHaveBeenCalledWith("session-sidebar-deleted");
        expect(screen.getByRole("button", { name: "Start Planning" })).toBeDefined();
      });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("Failed to load session")).toBeNull();
    });

    it("creates a task from a resumed complete session and keeps the completed session in local history", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-to-task",
        description: "Recovered summary for task creation",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };

      mockFetchAiSessions.mockResolvedValueOnce([
        {
          id: "session-complete-2",
          type: "planning",
          status: "complete",
          title: "Resume-to-task",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          archived: false,
        },
      ]);
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
        expect(screen.getByText("Create Single Task")).toBeDefined();
        expect(screen.getByRole("button", { name: /Resume-to-task/i })).toBeDefined();
      });

      const createSingleTaskButton = screen.getByRole("button", { name: "Create Single Task" });
      const breakIntoTasksButton = screen.getByRole("button", { name: "Break into Tasks" });
      expect(createSingleTaskButton.className).toContain("btn");
      expect(createSingleTaskButton.className).not.toContain("btn-primary");
      expect(breakIntoTasksButton.className).toContain("btn-primary");

      fireEvent.click(createSingleTaskButton);

      await waitFor(() => {
        expect(mockCreateTaskFromPlanning).toHaveBeenCalledWith(
          "session-complete-2",
          expect.objectContaining({ ...resumedSummary, priority: "normal" }),
          undefined,
          expect.objectContaining({ branchSelection: { mode: "project-default" } }),
        );
      });

      expect(screen.getByRole("button", { name: /Resume-to-task/i })).toBeDefined();
    });

    it("submits selected summary priority when creating a single task", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-to-task-priority",
        description: "Recovered summary for priority",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-complete-priority",
        type: "planning",
        status: "complete",
        title: "Resume-to-task-priority",
        inputPayload: JSON.stringify({ initialPlan: "Recover and create with priority" }),
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
          resumeSessionId="session-complete-priority"
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Create Single Task")).toBeDefined();
      });

      fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), {
        target: { value: "high" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create Single Task" }));

      await waitFor(() => {
        expect(mockCreateTaskFromPlanning).toHaveBeenCalledWith(
          "session-complete-priority",
          expect.objectContaining({ priority: "high" }),
          undefined,
          expect.objectContaining({
            branchSelection: { mode: "project-default" },
          }),
        );
      });
    });

    it("surfaces planning branch controls and sends branchSelection in create request", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-branch-controls",
        description: "Recovered summary for branch controls",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-branch-controls",
        type: "planning",
        status: "complete",
        title: "Resume-branch-controls",
        inputPayload: JSON.stringify({ initialPlan: "Recover and create with branch controls" }),
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
          resumeSessionId="session-branch-controls"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Create Single Task" })).toBeDefined();
      });

      const branchStrategy = screen.getByRole("combobox", { name: "Branch strategy" }) as HTMLSelectElement;
      expect(branchStrategy.value).toBe("project-default");

      fireEvent.click(screen.getByRole("button", { name: "Create Single Task" }));
      await waitFor(() => {
        expect(mockCreateTaskFromPlanning).toHaveBeenCalledWith(
          "session-branch-controls",
          expect.any(Object),
          undefined,
          expect.objectContaining({
            branchSelection: { mode: "project-default" },
          }),
        );
      });

      fireEvent.change(branchStrategy, { target: { value: "existing" } });
      expect(screen.getByRole("textbox", { name: "Branch name" })).toBeDefined();

      const createSingleTaskButton = screen.getByRole("button", { name: "Create Single Task" });
      expect(createSingleTaskButton).toBeDisabled();

      fireEvent.change(screen.getByRole("textbox", { name: "Branch name" }), {
        target: { value: "feat/planning-branch" },
      });
      fireEvent.change(screen.getByRole("textbox", { name: "Merge target / base branch (optional)" }), {
        target: { value: "develop" },
      });
      fireEvent.click(createSingleTaskButton);

      await waitFor(() => {
        expect(mockCreateTaskFromPlanning).toHaveBeenLastCalledWith(
          "session-branch-controls",
          expect.any(Object),
          undefined,
          expect.objectContaining({
            branchSelection: {
              mode: "existing",
              branchName: "feat/planning-branch",
              baseBranch: "develop",
            },
          }),
        );
      });

      fireEvent.change(branchStrategy, { target: { value: "auto-new" } });
      expect(screen.queryByRole("textbox", { name: "Branch name" })).toBeNull();

      fireEvent.change(branchStrategy, { target: { value: "custom-new" } });
      expect(screen.getByRole("textbox", { name: "Branch name" })).toBeDefined();
    });

    it("forwards selected branchSelection when creating tasks from breakdown", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-branch-breakdown",
        description: "Recovered summary for branch breakdown",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-branch-breakdown",
        type: "planning",
        status: "complete",
        title: "Resume-branch-breakdown",
        inputPayload: JSON.stringify({ initialPlan: "Recover and create breakdown with branch controls" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(resumedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      mockStartPlanningBreakdown.mockResolvedValueOnce({
        sessionId: "session-branch-breakdown",
        subtasks: [
          {
            id: "subtask-1",
            title: "First subtask",
            description: "First description",
            suggestedSize: "M",
            dependsOn: [],
          },
        ],
      });
      mockCreateTasksFromPlanning.mockResolvedValueOnce({ tasks: [] });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-branch-breakdown"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Break into Tasks" })).toBeDefined();
      });

      const branchStrategy = screen.getByRole("combobox", { name: "Branch strategy" }) as HTMLSelectElement;
      fireEvent.change(branchStrategy, { target: { value: "existing" } });
      fireEvent.change(screen.getByRole("textbox", { name: "Branch name" }), {
        target: { value: "feat/planning-branch" },
      });
      fireEvent.change(screen.getByRole("textbox", { name: "Merge target / base branch (optional)" }), {
        target: { value: "develop" },
      });

      fireEvent.click(screen.getByRole("button", { name: "Break into Tasks" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Create Tasks" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Create Tasks" }));

      await waitFor(() => {
        expect(mockCreateTasksFromPlanning).toHaveBeenCalledWith(
          "session-branch-breakdown",
          [{ id: "subtask-1" }],
          undefined,
          {
            branchSelection: {
              mode: "existing",
              branchName: "feat/planning-branch",
              baseBranch: "develop",
            },
          },
        );
      });
    });

    it("preserves per-subtask priority selections when creating tasks from breakdown", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-to-breakdown-priority",
        description: "Recovered summary for breakdown priority",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-breakdown-priority",
        type: "planning",
        status: "complete",
        title: "Resume-to-breakdown-priority",
        inputPayload: JSON.stringify({ initialPlan: "Recover and break down with priority" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(resumedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      mockStartPlanningBreakdown.mockResolvedValueOnce({
        sessionId: "session-breakdown-priority",
        subtasks: [
          {
            id: "subtask-1",
            title: "First subtask",
            description: "First description",
            suggestedSize: "M",
            dependsOn: [],
          },
        ],
      });
      mockCreateTasksFromPlanning.mockResolvedValueOnce({ tasks: [] });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-breakdown-priority"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Break into Tasks" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Break into Tasks" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Create Tasks" })).toBeDefined();
      });

      const prioritySelect = screen.getAllByRole("combobox", { name: "Priority" })[0];
      fireEvent.change(prioritySelect, { target: { value: "urgent" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Tasks" }));

      await waitFor(() => {
        expect(mockCreateTasksFromPlanning).toHaveBeenCalledWith(
          "session-breakdown-priority",
          [{ id: "subtask-1", priority: "urgent" }],
          undefined,
          { branchSelection: { mode: "project-default" } },
        );
      });
    });

    it("sends only edited breakdown fields when creating tasks", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-to-breakdown-compact",
        description: "Recovered summary for compact breakdown",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-breakdown-compact",
        type: "planning",
        status: "complete",
        title: "Resume-to-breakdown-compact",
        inputPayload: JSON.stringify({ initialPlan: "Recover and break down compactly" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(resumedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      mockStartPlanningBreakdown.mockResolvedValueOnce({
        sessionId: "session-breakdown-compact",
        subtasks: [
          {
            id: "subtask-1",
            title: "First subtask",
            description: "First description",
            suggestedSize: "M",
            dependsOn: [],
          },
          {
            id: "subtask-2",
            title: "Second subtask",
            description: "Second description",
            suggestedSize: "S",
            dependsOn: ["subtask-1"],
          },
        ],
      });
      mockCreateTasksFromPlanning.mockResolvedValueOnce({ tasks: [] });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-breakdown-compact"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Break into Tasks" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Break into Tasks" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Create Tasks" })).toBeDefined();
      });

      const firstSubtask = screen.getByTestId("subtask-item-0");
      fireEvent.change(within(firstSubtask).getAllByRole("textbox")[0]!, {
        target: { value: "Edited first subtask" },
      });
      const secondSubtask = screen.getByTestId("subtask-item-1");
      fireEvent.change(within(secondSubtask).getAllByRole("textbox")[1]!, {
        target: { value: "Edited second description" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create Tasks" }));

      await waitFor(() => {
        expect(mockCreateTasksFromPlanning).toHaveBeenCalledWith(
          "session-breakdown-compact",
          [
            { id: "subtask-1", title: "Edited first subtask" },
            { id: "subtask-2", description: "Edited second description" },
          ],
          undefined,
          { branchSelection: { mode: "project-default" } },
        );
      });
    });

    it("includes client-added subtasks in the compact create-tasks payload", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-to-breakdown-add-subtask",
        description: "Recovered summary for added subtask",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement"],
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-breakdown-add-subtask",
        type: "planning",
        status: "complete",
        title: "Resume-to-breakdown-add-subtask",
        inputPayload: JSON.stringify({ initialPlan: "Recover and add a subtask" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(resumedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      mockStartPlanningBreakdown.mockResolvedValueOnce({
        sessionId: "session-breakdown-add-subtask",
        subtasks: [
          {
            id: "subtask-1",
            title: "Existing subtask",
            description: "Existing description",
            suggestedSize: "M",
            dependsOn: [],
          },
        ],
      });
      mockCreateTasksFromPlanning.mockResolvedValueOnce({ tasks: [] });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-breakdown-add-subtask"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Break into Tasks" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Break into Tasks" }));
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Add subtask" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Add subtask" }));
      const addedSubtask = screen.getByTestId("subtask-item-1");
      const addedTextboxes = within(addedSubtask).getAllByRole("textbox");
      fireEvent.change(addedTextboxes[0]!, { target: { value: "Rollout follow-up" } });
      fireEvent.change(addedTextboxes[1]!, { target: { value: "Prepare rollout notes" } });
      fireEvent.change(within(addedSubtask).getByLabelText("Size"), { target: { value: "S" } });
      fireEvent.change(within(addedSubtask).getByLabelText("Priority"), { target: { value: "high" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Tasks" }));

      await waitFor(() => {
        expect(mockCreateTasksFromPlanning).toHaveBeenCalledWith(
          "session-breakdown-add-subtask",
          [
            { id: "subtask-1" },
            {
              id: "subtask-2",
              title: "Rollout follow-up",
              description: "Prepare rollout notes",
              suggestedSize: "S",
              priority: "high",
              dependsOn: [],
            },
          ],
          undefined,
          { branchSelection: { mode: "project-default" } },
        );
      });
    });

    it("omits removed generated subtasks from the compact create-tasks payload", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-to-breakdown-remove-subtask",
        description: "Recovered summary for removed subtask",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-breakdown-remove-subtask",
        type: "planning",
        status: "complete",
        title: "Resume-to-breakdown-remove-subtask",
        inputPayload: JSON.stringify({ initialPlan: "Recover and remove a subtask" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(resumedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      mockStartPlanningBreakdown.mockResolvedValueOnce({
        sessionId: "session-breakdown-remove-subtask",
        subtasks: [
          {
            id: "subtask-1",
            title: "Existing subtask",
            description: "Existing description",
            suggestedSize: "M",
            dependsOn: [],
          },
          {
            id: "subtask-2",
            title: "Generated follow-up",
            description: "Generated follow-up description",
            suggestedSize: "S",
            dependsOn: ["subtask-1"],
          },
        ],
      });
      mockCreateTasksFromPlanning.mockResolvedValueOnce({ tasks: [] });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-breakdown-remove-subtask"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Break into Tasks" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Break into Tasks" }));
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Create Tasks" })).toBeDefined();
      });

      const secondSubtask = screen.getByTestId("subtask-item-1");
      fireEvent.click(within(secondSubtask).getByRole("button", { name: "Remove" }));
      fireEvent.click(screen.getByRole("button", { name: "Create Tasks" }));

      await waitFor(() => {
        expect(mockCreateTasksFromPlanning).toHaveBeenCalledWith(
          "session-breakdown-remove-subtask",
          [{ id: "subtask-1" }],
          undefined,
          { branchSelection: { mode: "project-default" } },
        );
      });
    });

    it("refines a resumed complete session without blank question view", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Resume-and-refine",
        description: "Recovered summary for refine",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Implement", "Verify"],
      };
      const refinedQuestion: PlanningQuestion = {
        id: "q-refine",
        type: "text",
        question: "Which part should we refine?",
        description: "Refine follow-up",
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-complete-refine",
        type: "planning",
        status: "complete",
        title: "Resume-and-refine",
        inputPayload: JSON.stringify({ initialPlan: "Recover and refine" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(resumedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      let streamHandlers: any;
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers = handlers;
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });
      mockRespondToPlanning.mockImplementationOnce(async () => {
        setTimeout(() => {
          streamHandlers?.onQuestion?.(refinedQuestion);
        }, 10);
        return { type: "question", data: refinedQuestion };
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-complete-refine"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Refine Further" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Refine Further" }));

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalledWith(
          "session-complete-refine",
          { refine: true },
          undefined,
          expect.any(String),
        );
      });

      await waitFor(() => {
        expect(screen.getByText("Which part should we refine?")).toBeDefined();
      });
      expect(screen.queryByText("No active question in session")).toBeNull();
    });
  });

  describe("Conversation history", () => {
    it("hides completed-session Q&A by default behind a summary disclosure", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Summary with hidden history",
        description: "Recovered summary description",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Deliverable A"],
      };

      const restoredHistory = [
        {
          question: {
            id: "q1",
            type: "single_select",
            question: "What scope do you need?",
            options: [
              { id: "small", label: "Small" },
              { id: "medium", label: "Medium" },
            ],
          },
          response: { q1: "medium" },
          thinkingOutput: "Reasoning for scope question",
        },
      ];

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-complete-with-history",
        type: "planning",
        status: "complete",
        title: resumedSummary.title,
        inputPayload: JSON.stringify({ initialPlan: "Build planning history restore" }),
        conversationHistory: JSON.stringify(restoredHistory),
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
          resumeSessionId="session-complete-with-history"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      expect(screen.getByRole("button", { name: "Show user Q&A" })).toBeDefined();
      expect(screen.queryByTestId("conversation-history")).toBeNull();
      expect(screen.queryByText("What scope do you need?")).toBeNull();
      expect(screen.queryByText("Medium")).toBeNull();
    });

    it("reveals completed-session Q&A when summary disclosure is expanded", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Summary with expandable history",
        description: "Recovered summary description",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Deliverable A"],
      };

      const restoredHistory = [
        {
          question: {
            id: "q1",
            type: "single_select",
            question: "What scope do you need?",
            options: [
              { id: "small", label: "Small" },
              { id: "medium", label: "Medium" },
            ],
          },
          response: { q1: "medium" },
          thinkingOutput: "Reasoning for scope question",
        },
      ];

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-complete-with-history-2",
        type: "planning",
        status: "complete",
        title: resumedSummary.title,
        inputPayload: JSON.stringify({ initialPlan: "Build planning history restore" }),
        conversationHistory: JSON.stringify(restoredHistory),
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
          resumeSessionId="session-complete-with-history-2"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Show user Q&A" }));

      await waitFor(() => {
        expect(screen.getByTestId("conversation-history")).toBeDefined();
      });

      expect(screen.getByText("What scope do you need?")).toBeDefined();
      expect(within(screen.getByTestId("conversation-history")).getByText("Medium")).toBeDefined();
    });

    it("restores all persisted Q&A pairs when resuming a session", async () => {
      mockConnectPlanningStream.mockImplementationOnce(() => ({
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      }));

      const resumedQuestion: PlanningQuestion = {
        id: "q-current",
        type: "text",
        question: "What should we prioritize next?",
        description: "Current question",
      };

      const restoredHistory = [
        {
          question: {
            id: "q1",
            type: "single_select",
            question: "What scope do you need?",
            options: [
              { id: "small", label: "Small" },
              { id: "medium", label: "Medium" },
            ],
          },
          response: { q1: "medium" },
          thinkingOutput: "Reasoning for scope question",
        },
        {
          question: {
            id: "q2",
            type: "text",
            question: "List your acceptance criteria",
          },
          response: { q2: "Must support offline mode" },
          thinkingOutput: "Reasoning for criteria question",
        },
      ];

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-awaiting-1",
        type: "planning",
        status: "awaiting_input",
        title: "Resume with history",
        inputPayload: JSON.stringify({ initialPlan: "Build planning history restore" }),
        conversationHistory: JSON.stringify(restoredHistory),
        currentQuestion: JSON.stringify(resumedQuestion),
        result: null,
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
          resumeSessionId="session-awaiting-1"
        />,
      );

      await waitFor(() => {
        expect(mockParseConversationHistory).toHaveBeenCalledWith(JSON.stringify(restoredHistory));
      });

      await waitFor(() => {
        expect(screen.getByText("What scope do you need?")).toBeDefined();
      });

      expect(screen.getByText("List your acceptance criteria")).toBeDefined();
      expect(within(screen.getByTestId("conversation-history")).getByText("Medium")).toBeDefined();
      expect(screen.getByText("Must support offline mode")).toBeDefined();
      expect(screen.getByText("What should we prioritize next?")).toBeDefined();
    });

    it("starts fresh sessions with empty conversation history", async () => {
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
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      expect(screen.queryByTestId("conversation-history")).toBeNull();
    });

    it("appends submitted responses to visible conversation history", async () => {
      const secondQuestion: PlanningQuestion = {
        id: "q-requirements",
        type: "text",
        question: "What are the key requirements?",
        description: "Describe the requirements",
      };

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

      mockRespondToPlanning.mockImplementation(async () => {
        setTimeout(() => {
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

      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      const mediumOption = await screen.findByText("Medium");
      fireEvent.click(mediumOption);

      const continueBtn = await screen.findByRole("button", { name: "Continue" });
      fireEvent.click(continueBtn);

      await waitFor(() => {
        expect(screen.getByText("What are the key requirements?")).toBeDefined();
      }, { timeout: 5000 });

      expect(screen.getByTestId("conversation-history")).toBeDefined();
      expect(screen.getByText("What is the scope?")).toBeDefined();
      expect(screen.getByText("Medium")).toBeDefined();
    });
  });

  describe("Session history", () => {
    it("renders only one row when fetch and SSE deliver the same session id", async () => {
      mockFetchAiSessions.mockResolvedValueOnce([
        {
          id: "session-dup",
          type: "planning",
          status: "complete",
          title: "Duplicate session",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          archived: false,
        },
      ]);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(screen.getAllByText("Duplicate session")).toHaveLength(1);
      });
      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      act(() => {
        MockEventSource.instances[0]?.emit("ai_session:updated", {
          id: "session-dup",
          type: "planning",
          status: "complete",
          title: "Duplicate session",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
          archived: false,
        });
      });

      await waitFor(() => {
        expect(screen.getAllByText("Duplicate session")).toHaveLength(1);
      });
    });

    it("removes a session after a successful delete", async () => {
      mockFetchAiSessions.mockResolvedValueOnce([
        {
          id: "session-delete",
          type: "planning",
          status: "complete",
          title: "Delete me",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          archived: false,
        },
      ]);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Delete me")).toBeDefined();
      });

      const sidebar = screen.getByLabelText("Planning sessions");
      fireEvent.click(within(sidebar).getAllByTitle("Delete session")[0]!);
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));

      await waitFor(() => {
        expect(mockDeleteAiSession).toHaveBeenCalledWith("session-delete");
        expect(screen.queryByText("Delete me")).toBeNull();
      });
    });

    it("reconciles the session row and shows a toast when delete fails", async () => {
      const sessions = [
        {
          id: "session-delete-fail",
          type: "planning",
          status: "complete",
          title: "Still here",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          archived: false,
        },
      ];
      mockFetchAiSessions.mockResolvedValueOnce(sessions).mockResolvedValueOnce(sessions);
      mockDeleteAiSession.mockRejectedValueOnce(new Error("Delete failed"));

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Still here")).toBeDefined();
      });

      const sidebar = screen.getByLabelText("Planning sessions");
      fireEvent.click(within(sidebar).getAllByTitle("Delete session")[0]!);
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));

      await waitFor(() => {
        expect(mockDeleteAiSession).toHaveBeenCalledWith("session-delete-fail");
        expect(mockAddToast).toHaveBeenCalledWith("Delete failed", "error");
        expect(mockFetchAiSessions).toHaveBeenCalledTimes(2);
        expect(screen.getByText("Still here")).toBeDefined();
      });
    });
  });

  describe("dedupeSessionsById export", () => {
    it("keeps the newest session for duplicate ids while preserving stable order on ties", () => {
      expect(
        dedupeSessionsById([
          {
            id: "session-a",
            type: "planning",
            status: "complete",
            title: "older",
            projectId: null,
            lockedByTab: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
            archived: false,
          },
          {
            id: "session-b",
            type: "planning",
            status: "complete",
            title: "peer",
            projectId: null,
            lockedByTab: null,
            updatedAt: "2026-01-02T00:00:00.000Z",
            archived: false,
          },
          {
            id: "session-a",
            type: "planning",
            status: "complete",
            title: "newer",
            projectId: null,
            lockedByTab: null,
            updatedAt: "2026-01-03T00:00:00.000Z",
            archived: false,
          },
          {
            id: "session-c",
            type: "planning",
            status: "complete",
            title: "tie-first",
            projectId: null,
            lockedByTab: null,
            updatedAt: "2026-01-02T00:00:00.000Z",
            archived: false,
          },
        ]),
      ).toEqual([
        {
          id: "session-a",
          type: "planning",
          status: "complete",
          title: "newer",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-03T00:00:00.000Z",
          archived: false,
        },
        {
          id: "session-b",
          type: "planning",
          status: "complete",
          title: "peer",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
          archived: false,
        },
        {
          id: "session-c",
          type: "planning",
          status: "complete",
          title: "tie-first",
          projectId: null,
          lockedByTab: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
          archived: false,
        },
      ]);
    });
  });
});
