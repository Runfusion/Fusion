import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, renderHook, screen, fireEvent, waitFor, within } from "@testing-library/react";
import * as api from "../../api";
import { PlanningModeModal } from "../PlanningModeModal";
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

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalledWith(
          "session-123",
          { "q-scope": "small" },
          undefined,
          "tab-self",
        );
      });
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

    it("shows retry panel when resuming an errored session", async () => {
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
        expect(screen.getByText("Session interrupted")).toBeDefined();
      });
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
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
        expect(screen.getByText("Create Single Task")).toBeDefined();
      });

      const createSingleTaskButton = screen.getByRole("button", { name: "Create Single Task" });
      const breakIntoTasksButton = screen.getByRole("button", { name: "Break into Tasks" });
      expect(createSingleTaskButton.className).toContain("btn");
      expect(createSingleTaskButton.className).not.toContain("btn-primary");
      expect(breakIntoTasksButton.className).toContain("btn-primary");

      fireEvent.click(createSingleTaskButton);

      await waitFor(() => {
        expect(mockCreateTaskFromPlanning).toHaveBeenCalledWith("session-complete-2", resumedSummary, undefined);
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

});
