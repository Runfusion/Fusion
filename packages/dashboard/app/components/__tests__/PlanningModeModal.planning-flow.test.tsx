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
import {
  PLANNING_DEEPEN_CHECKPOINT_ID,
  PLANNING_DEEPEN_CHECKPOINT_QUESTION,
  PLANNING_DEEPEN_PROCEED_OPTION_ID,
} from "@fusion/core";
import type { MergeResult, PlanningQuestion } from "@fusion/core";

import {
  mockStartPlanning,
  mockStartPlanningStreaming,
  mockCreatePlanningDraft,
  mockConnectPlanningStream,
  mockRespondToPlanning,
  mockRewindPlanningSession,
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
const mockCopyTextToClipboard = vi.fn();

/*
FNXC:PlanningModeStreamHarness 2026-07-17-16:20:
FN-8245 requires planning-stream test events to retain their asynchronous protocol
boundary without depending on wall-clock timers. Queue one deterministic microtask
so every question, summary, and error settles before the awaiting assertion runs,
even when dashboard tests share loaded jsdom workers.
*/
function queuePlanningStreamEvent(callback: () => void): void {
  queueMicrotask(callback);
}

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
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
  rewindPlanningSession: (...args: any[]) => mockRewindPlanningSession(...args),
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
  /*
  FNXC:PlanningModeSettings 2026-07-17-15:45:
  FN-8245 keeps the clarification-settings dependency deterministic for every
  planning interaction. The modal intentionally blocks Start Planning while
  settings load, so this test double settles synchronously rather than making
  each user-flow assertion depend on an arbitrary event-loop delay.
  */
  fetchGlobalSettings: vi.fn(() => {
    const settled = {
      then(onFulfilled: (settings: Record<string, never>) => unknown) {
        onFulfilled({});
        return settled;
      },
      catch() {
        return settled;
      },
      finally(onFinally: () => unknown) {
        onFinally();
        return settled;
      },
    };
    return settled;
  }),
  fetchModels: (...args: any[]) => mockFetchModels(...args),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  refineText: vi.fn(),
  getRefineErrorMessage: vi.fn((err: any) => err?.message || "Failed to refine"),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
  duplicateTask: vi.fn().mockResolvedValue({}),
  fetchAiSessions: (...args: any[]) => mockFetchAiSessions(...args),
  deleteAiSession: (...args: any[]) => mockDeleteAiSession(...args),
}));

vi.mock("../../utils/copyToClipboard", () => ({
  copyTextToClipboard: (...args: unknown[]) => mockCopyTextToClipboard(...args),
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
    mockAddToast.mockReset();
    mockCopyTextToClipboard.mockReset();
    mockCopyTextToClipboard.mockResolvedValue(true);
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
    mockRewindPlanningSession.mockReset();
    mockUpdatePlanningSessionDraft.mockResolvedValue({ ok: true });
    mockStopPlanningGeneration.mockResolvedValue({ success: true });

    // Default stream behavior belongs only to fresh sessions. Resumed sessions restore their
    // persisted question and must not receive a synthetic fresh-session question.
    mockConnectPlanningStream.mockImplementation((sessionId: string, _projectId: string | undefined, handlers: any) => {
      if (sessionId === "session-123") {
        queuePlanningStreamEvent(() => {
          handlers.onQuestion?.(mockQuestion);
        });
      }

      return {
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      };
    });
  });

  describe("embedded presentation", () => {
    it("renders as a main-content region without modal overlay or backdrop-close behavior", async () => {
      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          presentation="embedded"
        />
      );

      const region = await screen.findByTestId("planning-view");
      expect(region.getAttribute("role")).toBe("region");
      expect(region.getAttribute("aria-modal")).toBeNull();
      expect(container.querySelector(".modal-overlay")).toBeNull();
      expect(container.querySelector(".planning-modal--embedded")).toBeTruthy();

      fireEvent.mouseDown(region);
      fireEvent.click(region);
      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });

  describe("Planning flow", () => {
    it.each(["desktop", "mobile"] as const)("renders the mandatory deepening checkpoint before summary actions on %s", async (viewportMode) => {
      mockViewport(viewportMode);
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        queuePlanningStreamEvent(() => {
          handlers.onQuestion?.({
            id: PLANNING_DEEPEN_CHECKPOINT_ID,
            type: "multi_select",
            question: PLANNING_DEEPEN_CHECKPOINT_QUESTION,
            description: "Select areas to explore or proceed.",
            options: [
              { id: PLANNING_DEEPEN_PROCEED_OPTION_ID, label: "Proceed to final plan" },
              { id: "theme-ux", label: "UX and interaction details" },
              { id: "theme-testing", label: "Testing and verification" },
            ],
            planPreview: {
              title: "Checkpoint preview title",
              description: "Checkpoint **Markdown** description",
              keyDeliverables: ["Preview deliverable one", "Preview deliverable two"],
            },
          });
        });
        return { close: vi.fn() };
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
        target: { value: "Plan a checkpoint flow" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      const checkpointQuestion = await screen.findByText(PLANNING_DEEPEN_CHECKPOINT_QUESTION);
      const previewTitle = screen.getByText("Checkpoint preview title");
      expect(previewTitle.compareDocumentPosition(checkpointQuestion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByText("Markdown").tagName).toBe("STRONG");
      expect(screen.getByText("Preview deliverable one")).toBeInTheDocument();
      expect(screen.getByText("Preview deliverable two")).toBeInTheDocument();
      expect(screen.queryByText("Planning Complete!")).toBeNull();
      expect(screen.queryByRole("button", { name: "Create Single Task" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Break into Tasks" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Refine Further" })).toBeNull();
      expect(screen.getByText("Proceed to final plan")).toBeInTheDocument();
      expect(screen.getByTestId("planning-option-other")).toBeInTheDocument();
    });

    it("submits selected checkpoint themes with a custom topic and can proceed to the final summary", async () => {
      let streamHandlers: any;
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers = handlers;
        queuePlanningStreamEvent(() => {
          handlers.onQuestion?.({
            id: PLANNING_DEEPEN_CHECKPOINT_ID,
            type: "multi_select",
            question: PLANNING_DEEPEN_CHECKPOINT_QUESTION,
            options: [
              { id: PLANNING_DEEPEN_PROCEED_OPTION_ID, label: "Proceed to final plan" },
              { id: "theme-ux", label: "UX and interaction details" },
            ],
          });
        });
        return { close: vi.fn() };
      });
      mockRespondToPlanning.mockResolvedValue({ type: "question", data: null });

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
        target: { value: "Plan iterative deepening" },
      });
      fireEvent.click(screen.getByText("Start Planning"));
      await screen.findByText(PLANNING_DEEPEN_CHECKPOINT_QUESTION);

      fireEvent.click(screen.getByText("UX and interaction details"));
      fireEvent.click(screen.getByTestId("planning-option-other"));
      fireEvent.change(screen.getByTestId("planning-other-input"), { target: { value: "  Explore rollout risk  " } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalledWith(
          "session-123",
          {
            [PLANNING_DEEPEN_CHECKPOINT_ID]: ["theme-ux"],
            _other: "Explore rollout risk",
          },
          undefined,
        );
      });

      act(() => {
        streamHandlers.onQuestion?.({
          id: "q-follow-up",
          type: "text",
          question: "What rollout risk matters?",
        });
      });
      fireEvent.change(screen.getByPlaceholderText("Type your answer here..."), { target: { value: "Operator docs" } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      act(() => {
        streamHandlers.onQuestion?.({
          id: PLANNING_DEEPEN_CHECKPOINT_ID,
          type: "multi_select",
          question: PLANNING_DEEPEN_CHECKPOINT_QUESTION,
          options: [
            { id: PLANNING_DEEPEN_PROCEED_OPTION_ID, label: "Proceed to final plan" },
            { id: "theme-testing", label: "Testing and verification" },
          ],
        });
      });
      await waitFor(() => {
        expect(screen.getAllByText(PLANNING_DEEPEN_CHECKPOINT_QUESTION).length).toBeGreaterThan(0);
      });
      fireEvent.click(screen.getByText("Proceed to final plan"));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenLastCalledWith(
          "session-123",
          { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
          undefined,
        );
      });

      act(() => {
        streamHandlers.onSummary?.(mockSummary);
        streamHandlers.onComplete?.();
      });
      expect(await screen.findByText("Planning Complete!")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create Single Task" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Break into Tasks" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Refine Further" })).toBeEnabled();
    });
    it.each(["desktop", "mobile"] as const)("FN-6977 renders malformed live summary without generic error on %s", async (viewportMode) => {
      mockViewport(viewportMode);
      mockStartPlanningStreaming.mockResolvedValueOnce({ sessionId: `session-fn-6977-live-${viewportMode}` });
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        queuePlanningStreamEvent(() => {
          handlers.onSummary?.({
            title: "Live malformed summary",
            description: "Live Planning Mode summary omitted deliverable arrays",
            suggestedSize: "M",
          });
        });

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
        target: { value: "Plan from live malformed summary" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      expect(screen.getByText("Live Planning Mode summary omitted deliverable arrays")).toBeDefined();
      expect(screen.queryByText(/Something went wrong/i)).toBeNull();
      expect(screen.getByRole("button", { name: "Create Single Task" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Break into Tasks" })).toBeEnabled();
    });

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
          clarificationEnabled: false,
        }, undefined);
      });

      // Should transition to question view via streaming
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });
      expect(screen.queryByText("Your plan so far")).toBeNull();
    });

    /*
    FNXC:PlanningMultiTab 2026-07-14-00:00:
    Planning has no cross-tab locking. Even when another tab is using the same session, this
    tab must never call the lock API, never render a lock overlay, and must remain fully
    interactive — the persisted session row is the shared source of truth.
    */
    it("never acquires a tab lock and stays interactive even when another tab uses the session", async () => {
      window.sessionStorage.setItem("fusion-tab-id", "tab-self");
      // If any legacy lock path survived, this rejection would surface an overlay.
      mockAcquireSessionLock.mockResolvedValue({ acquired: false, currentHolder: "tab-other" });

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

      expect(screen.queryByTestId("session-lock-overlay")).toBeNull();
      expect(screen.queryByRole("button", { name: "Take Control" })).toBeNull();
      expect(mockAcquireSessionLock).not.toHaveBeenCalled();
      expect(mockForceAcquireSessionLock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText("Small"));
      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalledWith(
          "session-123",
          { "q-scope": "small" },
          undefined,
        );
      });
    });

    it("allows normal question interaction", async () => {
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
          );
        },
        // waitFor's private 1s default (independent of vitest testTimeout) has
        // flaked under loaded CI shards; the click->respond chain crosses
        // several state-update hops. Generous bound, still fails fast locally.
        { timeout: 5000 },
      );
    });

    it("allows Other-only answers for single-select planning questions", async () => {
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
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      const continueButton = screen.getByRole("button", { name: "Continue" });
      fireEvent.click(screen.getByTestId("planning-option-other"));
      expect(continueButton).toBeDisabled();

      const otherInput = screen.getByTestId("planning-other-input");
      fireEvent.change(otherInput, { target: { value: "  Make this a design spike  " } });
      expect(continueButton).toBeEnabled();
      fireEvent.click(continueButton);

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalledWith(
          "session-123",
          { _other: "Make this a design spike" },
          undefined,
        );
      });
    });

    it("clears stale Other text when switching back to a provided planning option", async () => {
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
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      const continueButton = screen.getByRole("button", { name: "Continue" });
      fireEvent.click(screen.getByTestId("planning-option-other"));
      fireEvent.change(screen.getByTestId("planning-other-input"), { target: { value: "   " } });
      expect(continueButton).toBeDisabled();
      fireEvent.change(screen.getByTestId("planning-other-input"), { target: { value: "Ignore suggested scope" } });
      expect(continueButton).toBeEnabled();

      fireEvent.click(screen.getByText("Small"));
      expect(screen.queryByTestId("planning-other-input")).toBeNull();
      fireEvent.click(continueButton);

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalledWith(
          "session-123",
          { "q-scope": "small" },
          undefined,
        );
      });
    });

    it("allows Other-only answers for multi-select planning questions", async () => {
      window.sessionStorage.setItem("fusion-tab-id", "tab-self");
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        queuePlanningStreamEvent(() => {
          handlers.onQuestion?.({
            id: "q-priorities",
            type: "multi_select",
            question: "Which priorities matter?",
            options: [
              { id: "speed", label: "Speed" },
              { id: "quality", label: "Quality" },
            ],
          });
        });
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
        expect(screen.getByText("Which priorities matter?")).toBeDefined();
      });

      const continueButton = screen.getByRole("button", { name: "Continue" });
      fireEvent.click(within(screen.getByTestId("planning-option-other")).getByRole("checkbox"));
      expect(continueButton).toBeDisabled();

      /*
      FNXC:PlanningModeOptions 2026-07-17-15:55:
      FN-8245 waits for the Other input after its toggle commits React state.
      This preserves the user-visible invariant that Other opens an editable
      input without assuming a same-tick DOM update under loaded jsdom workers.
      */
      const otherInput = await screen.findByTestId("planning-other-input");
      fireEvent.change(otherInput, { target: { value: "  Challenge the premise  " } });
      expect(continueButton).toBeEnabled();
      fireEvent.click(continueButton);

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalledWith(
          "session-123",
          { _other: "Challenge the premise" },
          undefined,
        );
      });
    });

    it("combines provided options with Other text for multi-select planning questions on mobile", async () => {
      window.sessionStorage.setItem("fusion-tab-id", "tab-self");
      mockViewport("mobile");
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        queuePlanningStreamEvent(() => {
          handlers.onQuestion?.({
            id: "q-priorities",
            type: "multi_select",
            question: "Which priorities matter?",
            options: [
              { id: "speed", label: "Speed" },
              { id: "quality", label: "Quality" },
            ],
          });
        });
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
        expect(screen.getByText("Which priorities matter?")).toBeDefined();
      });

      const continueButton = screen.getByRole("button", { name: "Continue" });
      fireEvent.click(screen.getByText("Speed"));
      fireEvent.click(within(screen.getByTestId("planning-option-other")).getByRole("checkbox"));
      const otherInput = screen.getByTestId("planning-other-input");
      fireEvent.change(otherInput, { target: { value: "  Preserve operator control  " } });
      expect(continueButton).toBeEnabled();
      fireEvent.click(continueButton);

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalledWith(
          "session-123",
          { "q-priorities": ["speed"], _other: "Preserve operator control" },
          undefined,
        );
      });
    });

    it.each(["desktop", "mobile"] as const)("lets confirm questions submit an Other answer on %s", async (viewportMode) => {
      window.sessionStorage.setItem("fusion-tab-id", "tab-self");
      mockViewport(viewportMode);
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        queuePlanningStreamEvent(() => {
          handlers.onQuestion?.({
            id: "q-confirm-scope",
            type: "confirm",
            question: "Proceed with this scope?",
            description: "Choose Yes, No, or write a different answer.",
          });
        });
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
        expect(screen.getByText("Proceed with this scope?")).toBeDefined();
      });

      expect(screen.getByRole("button", { name: /Yes/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /No/ })).toBeInTheDocument();
      expect(screen.getByTestId("planning-option-other")).toBeInTheDocument();
      expect(screen.queryByTestId("planning-other-input")).toBeNull();

      const continueButton = screen.getByRole("button", { name: "Continue" });
      fireEvent.click(screen.getByTestId("planning-option-other"));
      expect(screen.getByTestId("planning-other-input")).toBeInTheDocument();
      expect(continueButton).toBeDisabled();

      fireEvent.change(screen.getByTestId("planning-other-input"), { target: { value: "   " } });
      expect(continueButton).toBeDisabled();

      fireEvent.change(screen.getByTestId("planning-other-input"), {
        target: { value: "  Ask a different scoping question  " },
      });
      expect(continueButton).toBeEnabled();
      fireEvent.click(continueButton);

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalledWith(
          "session-123",
          { _other: "Ask a different scoping question" },
          undefined,
        );
      });
    });

    it("clears confirm Other text when switching back to Yes or No", async () => {
      window.sessionStorage.setItem("fusion-tab-id", "tab-self");
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        queuePlanningStreamEvent(() => {
          handlers.onQuestion?.({
            id: "q-confirm-scope",
            type: "confirm",
            question: "Proceed with this scope?",
          });
        });
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
        expect(screen.getByText("Proceed with this scope?")).toBeDefined();
      });

      const continueButton = screen.getByRole("button", { name: "Continue" });
      fireEvent.click(screen.getByTestId("planning-option-other"));
      fireEvent.change(screen.getByTestId("planning-other-input"), {
        target: { value: "Ask a different scoping question" },
      });
      fireEvent.change(screen.getByLabelText("Additional comments (optional)"), {
        target: { value: "Keep the planner moving" },
      });
      expect(continueButton).toBeEnabled();

      fireEvent.click(screen.getByRole("button", { name: /No/ }));
      expect(screen.queryByTestId("planning-other-input")).toBeNull();
      fireEvent.click(continueButton);

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalledWith(
          "session-123",
          { "q-confirm-scope": false, _comment: "Keep the planner moving" },
          undefined,
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
        expect(mockStopPlanningGeneration).toHaveBeenCalledWith("session-123", undefined);
      });
      expect(closeSpy).toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.getByText("Generation stopped by user. You can retry or start a new session.")).toBeDefined();
      });
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();

      // avoid dangling handlers reference lint
      expect(streamHandlers).toBeDefined();
    });

    it("auto-retries a persisted stream error three times before showing the permanent error", async () => {
      const streamHandlers: any[] = [];
      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers.push(handlers);
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });
      mockFetchAiSession.mockResolvedValue({
        id: "session-123",
        type: "planning",
        status: "error",
        title: "Build auth system",
        inputPayload: JSON.stringify({ initialPlan: "Build auth system" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: null,
        thinkingOutput: "",
        error: "Rate limit exceeded",
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
        />,
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => expect(streamHandlers).toHaveLength(1));

      await act(async () => {
        streamHandlers[0].onError?.("Rate limit exceeded");
      });
      await waitFor(() => expect(mockRetryPlanningSession).toHaveBeenCalledTimes(1));
      expect(screen.getByText("Retrying… (attempt 1 of 3)")).toBeDefined();

      await act(async () => {
        streamHandlers[1].onError?.("Rate limit exceeded");
      });
      await waitFor(() => expect(mockRetryPlanningSession).toHaveBeenCalledTimes(2));
      expect(screen.getByText("Retrying… (attempt 2 of 3)")).toBeDefined();

      await act(async () => {
        streamHandlers[2].onError?.("Rate limit exceeded");
      });
      await waitFor(() => expect(mockRetryPlanningSession).toHaveBeenCalledTimes(3));
      expect(screen.getByText("Retrying… (attempt 3 of 3)")).toBeDefined();

      await act(async () => {
        streamHandlers[3].onError?.("Rate limit exceeded");
      });
      await waitFor(() => {
        expect(screen.getByText("Rate limit exceeded")).toBeDefined();
      });
      expect(mockRetryPlanningSession).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    });

    it("manual retry still starts a fresh retry after the auto-retry budget is exhausted", async () => {
      const streamHandlers: any[] = [];
      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers.push(handlers);
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });
      mockFetchAiSession.mockResolvedValue({
        id: "session-123",
        type: "planning",
        status: "error",
        title: "Build auth system",
        inputPayload: JSON.stringify({ initialPlan: "Build auth system" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: null,
        thinkingOutput: "",
        error: "Temporary failure",
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
        />,
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => expect(streamHandlers).toHaveLength(1));
      for (let index = 0; index < 4; index += 1) {
        await act(async () => {
          streamHandlers[index].onError?.("Temporary failure");
        });
      }

      await waitFor(() => {
        expect(screen.getByText("Temporary failure")).toBeDefined();
      });
      expect(mockRetryPlanningSession).toHaveBeenCalledTimes(3);

      mockFetchAiSession.mockResolvedValue({
        id: "session-123",
        type: "planning",
        status: "generating",
        title: "Build auth system",
        inputPayload: JSON.stringify({ initialPlan: "Build auth system" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: null,
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(mockRetryPlanningSession).toHaveBeenCalledTimes(4);
      });
      await act(async () => {
        streamHandlers[4].onQuestion?.(mockQuestion);
      });
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });
    });

    it("resets the auto-retry budget after successful question progress", async () => {
      const streamHandlers: any[] = [];
      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers.push(handlers);
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });
      mockFetchAiSession.mockResolvedValue({
        id: "session-123",
        type: "planning",
        status: "error",
        title: "Build auth system",
        inputPayload: JSON.stringify({ initialPlan: "Build auth system" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: null,
        thinkingOutput: "",
        error: "Temporary failure",
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
        />,
      );

      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Build auth system" },
      });
      fireEvent.click(screen.getByText("Start Planning"));
      await waitFor(() => expect(streamHandlers).toHaveLength(1));

      await act(async () => {
        streamHandlers[0].onError?.("Temporary failure");
      });
      await waitFor(() => expect(screen.getByText("Retrying… (attempt 1 of 3)")).toBeDefined());

      await act(async () => {
        streamHandlers[1].onQuestion?.(mockQuestion);
      });
      await waitFor(() => expect(screen.getByText("What is the scope?")).toBeDefined());

      await act(async () => {
        streamHandlers[1].onError?.("Temporary failure");
      });
      await waitFor(() => expect(mockRetryPlanningSession).toHaveBeenCalledTimes(2));
      expect(screen.getByText("Retrying… (attempt 1 of 3)")).toBeDefined();
      expect(screen.queryByText("Temporary failure")).toBeNull();
    });

    it("single-flights overlapping SSE error and stuck-poll retry signals", async () => {
      const streamHandlers: any[] = [];
      let pollTick: (() => void | Promise<void>) | undefined;
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((callback: TimerHandler, timeout?: number) => {
        if (timeout === 8000) {
          pollTick = callback as () => void | Promise<void>;
        }
        return 1 as unknown as ReturnType<typeof setInterval>;
      });
      let resolveRetry!: (value: { success: boolean; sessionId: string }) => void;
      const retryPromise = new Promise<{ success: boolean; sessionId: string }>((resolve) => {
        resolveRetry = resolve;
      });
      mockRetryPlanningSession.mockReturnValue(retryPromise);
      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers.push(handlers);
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });
      mockFetchAiSession.mockResolvedValue({
        id: "session-123",
        type: "planning",
        status: "error",
        title: "Build auth system",
        inputPayload: JSON.stringify({ initialPlan: "Build auth system" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: null,
        thinkingOutput: "",
        error: "Temporary failure",
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      try {
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
        await waitFor(() => expect(streamHandlers).toHaveLength(1));
        await waitFor(() => expect(pollTick).toBeDefined());

        await act(async () => {
          void streamHandlers[0].onError?.("Temporary failure");
          await Promise.resolve();
          await pollTick?.();
        });

        expect(mockRetryPlanningSession).toHaveBeenCalledTimes(1);
        expect(screen.getByText("Retrying… (attempt 1 of 3)")).toBeDefined();

        await act(async () => {
          resolveRetry({ success: true, sessionId: "session-123" });
        });
      } finally {
        setIntervalSpy.mockRestore();
      }
    });

    it("surfaces the permanent error view once the stuck-poll fallback exhausts the auto-retry budget without any SSE onError signal", async () => {
      // FN-7946 regression: if the SSE connection never invokes onError (e.g. a
      // dropped event) and the 8s watchdog poll is the only signal that discovers
      // a terminal session error, the poll path must still surface the permanent
      // error view once MAX_PLANNING_AUTO_RETRIES is exhausted — not leave the
      // modal stuck on the loading spinner forever.
      const streamHandlers: any[] = [];
      const pollTicks: Array<() => void | Promise<void>> = [];
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((callback: TimerHandler, timeout?: number) => {
        if (timeout === 8000) {
          pollTicks.push(callback as () => void | Promise<void>);
        }
        return 1 as unknown as ReturnType<typeof setInterval>;
      });
      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers.push(handlers);
        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });
      mockFetchAiSession.mockResolvedValue({
        id: "session-123",
        type: "planning",
        status: "error",
        title: "Build auth system",
        inputPayload: JSON.stringify({ initialPlan: "Build auth system" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: null,
        thinkingOutput: "",
        error: "Watchdog aborted a stalled turn",
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      try {
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
        await waitFor(() => expect(streamHandlers).toHaveLength(1));

        // Drive every retry attempt purely through the watchdog poll — the SSE
        // handlers never call onError, simulating a missed/dropped SSE event.
        // The interval is registered once while the view stays "loading" across
        // retries (lockSessionId/session id do not change), so the same captured
        // tick callback is re-invoked on each simulated 8s beat, exactly as the
        // real setInterval would re-invoke it.
        await waitFor(() => expect(pollTicks.length).toBeGreaterThan(0));
        for (let index = 0; index < 4; index += 1) {
          await act(async () => {
            await pollTicks[0]?.();
          });
        }

        await waitFor(() => {
          expect(screen.getByText("Watchdog aborted a stalled turn")).toBeDefined();
        });
        expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
        expect(mockRetryPlanningSession).toHaveBeenCalledTimes(3);
      } finally {
        setIntervalSpy.mockRestore();
      }
    });

    it("auto-recovers from a stream error when server session is still generating", async () => {
      let streamAttempt = 0;
      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamAttempt += 1;
        if (streamAttempt === 1) {
          queuePlanningStreamEvent(() => handlers.onError?.("Connection lost"));
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
          queuePlanningStreamEvent(() => handlers.onError?.("Connection lost"));
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

    it.each(["desktop", "mobile"] as const)("FN-6977 renders malformed persisted summary without generic error on %s", async (viewportMode) => {
      mockViewport(viewportMode);
      const malformedSummary = {
        title: "Malformed summary without arrays",
        description: "Recovered summary missing deliverable and dependency arrays",
        suggestedSize: "M",
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: `session-fn-6977-${viewportMode}`,
        type: "planning",
        status: "complete",
        title: "Malformed summary without arrays",
        inputPayload: JSON.stringify({ initialPlan: "Recover malformed summary" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(malformedSummary),
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
          resumeSessionId={`session-fn-6977-${viewportMode}`}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      expect(screen.getByText("Recovered summary missing deliverable and dependency arrays")).toBeDefined();
      expect(screen.queryByText(/Something went wrong/i)).toBeNull();
      expect(screen.getByRole("button", { name: "Create Single Task" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Break into Tasks" })).toBeEnabled();
    });

    it("FN-6977 sends normalized empty arrays when creating from a malformed summary", async () => {
      const malformedSummary = {
        title: "Malformed summary create task",
        description: "Recovered summary can still create a task",
        suggestedSize: "M",
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-fn-6977-create",
        type: "planning",
        status: "complete",
        title: "Malformed summary create task",
        inputPayload: JSON.stringify({ initialPlan: "Recover malformed summary and create" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(malformedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      mockCreateTaskFromPlanning.mockResolvedValueOnce({
        id: "FN-6977",
        title: "Created from malformed summary",
        description: "",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as Task);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-fn-6977-create"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Create Single Task" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Create Single Task" }));

      await waitFor(() => {
        expect(mockCreateTaskFromPlanning).toHaveBeenCalledWith(
          "session-fn-6977-create",
          expect.objectContaining({
            suggestedDependencies: [],
            keyDeliverables: [],
          }),
          undefined,
          expect.any(Object),
        );
      });
      expect(screen.queryByText(/Something went wrong/i)).toBeNull();
    });

    it("FN-6977 starts breakdown from malformed summary and normalizes missing subtask dependsOn", async () => {
      const malformedSummary = {
        title: "Malformed summary breakdown",
        description: "Recovered summary can still be broken down",
        suggestedSize: "M",
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-fn-6977-breakdown",
        type: "planning",
        status: "complete",
        title: "Malformed summary breakdown",
        inputPayload: JSON.stringify({ initialPlan: "Recover malformed summary and break down" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(malformedSummary),
        thinkingOutput: "",
        error: null,
        projectId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      mockStartPlanningBreakdown.mockResolvedValueOnce({
        sessionId: "session-fn-6977-breakdown",
        subtasks: [
          {
            id: "subtask-1",
            title: "Fallback implementation",
            description: "Generated despite omitted deliverables",
            suggestedSize: "M",
          },
        ],
      });
      mockCreateTasksFromPlanning.mockResolvedValueOnce({ tasks: [] });
      const onTasksCreated = vi.fn();

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={onTasksCreated}
          tasks={mockTasks}
          resumeSessionId="session-fn-6977-breakdown"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Break into Tasks" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Break into Tasks" }));

      await waitFor(() => {
        expect(mockStartPlanningBreakdown).toHaveBeenCalledWith(
          "session-fn-6977-breakdown",
          expect.objectContaining({ suggestedDependencies: [], keyDeliverables: [] }),
          undefined,
        );
        expect(screen.getByDisplayValue("Fallback implementation")).toBeDefined();
      });
      expect(screen.getByText("First subtask cannot have dependencies.")).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "Create Tasks" }));

      await waitFor(() => {
        expect(mockCreateTasksFromPlanning).toHaveBeenCalledWith(
          "session-fn-6977-breakdown",
          [expect.objectContaining({ id: "subtask-1" })],
          undefined,
          expect.any(Object),
        );
        expect(onTasksCreated).toHaveBeenCalledWith([]);
      });
      expect(screen.queryByText(/Something went wrong/i)).toBeNull();
    });

    it("resumes awaiting deepening checkpoint sessions without showing summary actions", async () => {
      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-awaiting-checkpoint",
        type: "planning",
        status: "awaiting_input",
        title: "Awaiting checkpoint",
        inputPayload: JSON.stringify({ initialPlan: "Resume pending checkpoint" }),
        conversationHistory: "[]",
        currentQuestion: JSON.stringify({
          id: PLANNING_DEEPEN_CHECKPOINT_ID,
          type: "multi_select",
          question: PLANNING_DEEPEN_CHECKPOINT_QUESTION,
          options: [
            { id: PLANNING_DEEPEN_PROCEED_OPTION_ID, label: "Proceed to final plan" },
            { id: "theme-testing", label: "Testing and verification" },
          ],
          planPreview: {
            title: "Restored checkpoint plan",
            description: "Restored plan description",
            keyDeliverables: ["Restored deliverable"],
          },
        }),
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
          resumeSessionId="session-awaiting-checkpoint"
        />
      );

      const checkpointQuestion = await screen.findByText(PLANNING_DEEPEN_CHECKPOINT_QUESTION);
      const previewTitle = screen.getByText("Restored checkpoint plan");
      expect(previewTitle.compareDocumentPosition(checkpointQuestion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByText("Restored plan description")).toBeInTheDocument();
      expect(screen.getByText("Restored deliverable")).toBeInTheDocument();
      expect(screen.getByText("Proceed to final plan")).toBeInTheDocument();
      expect(screen.queryByText("Planning Complete!")).toBeNull();
      expect(screen.queryByRole("button", { name: "Create Single Task" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Break into Tasks" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Refine Further" })).toBeNull();
    });

    it.each(["desktop", "mobile"] as const)("keeps persisted awaiting-input questions free of reconnecting hints on %s", async (viewportMode) => {
      mockViewport(viewportMode);
      let streamHandlers: any;
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers = handlers;
        return { close: vi.fn(), isConnected: vi.fn().mockReturnValue(true) };
      });
      mockFetchAiSession.mockResolvedValueOnce({
        id: `session-reconnect-question-${viewportMode}`,
        type: "planning",
        status: "awaiting_input",
        title: "Persisted question",
        inputPayload: JSON.stringify({ initialPlan: "Resume persisted question" }),
        conversationHistory: "[]",
        currentQuestion: JSON.stringify(mockQuestion),
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
          resumeSessionId={`session-reconnect-question-${viewportMode}`}
        />,
      );

      expect(await screen.findByText(mockQuestion.question)).toBeInTheDocument();
      act(() => {
        streamHandlers.onConnectionStateChange?.("reconnecting");
      });

      expect(screen.getByText(mockQuestion.question)).toBeInTheDocument();
      expect(screen.queryByText("Reconnecting…")).toBeNull();
    });

    it("shows the reconnecting hint while active generation is loading", async () => {
      let streamHandlers: any;
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers = handlers;
        return { close: vi.fn(), isConnected: vi.fn().mockReturnValue(true) };
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
        target: { value: "Generate a planning task" },
      });
      fireEvent.click(screen.getByText("Start Planning"));
      await waitFor(() => expect(mockConnectPlanningStream).toHaveBeenCalledTimes(1));

      act(() => {
        streamHandlers.onConnectionStateChange?.("reconnecting");
      });

      expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
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

      expect(screen.getByText("Recovered summary description from persisted session")).toBeDefined();
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
          { planningModelProvider: "anthropic", planningModelId: "claude-sonnet-4-5", thinkingLevel: undefined },
          { planningDepth: "medium", customQuestionCount: undefined, clarificationEnabled: false },
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
      expect(screen.getByText("Recovered summary from history")).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: /Draft plan from history/i }));

      await waitFor(() => {
        expect(mockFetchAiSession).toHaveBeenCalledWith("session-history-draft");
      });
      expect(screen.getByDisplayValue("Draft plan from history")).toBeDefined();
      expect(screen.getByRole("button", { name: "Start Planning" })).toBeDefined();
    });

    it("auto-retries when resuming an errored session", async () => {
      /*
       * FNXC:PlanningRetry 2026-07-15-00:00:
       * FN-8025 requires the stream to remain in the retry loading window while this test observes the transient status.
       * Do not use the suite default here: its delayed question event clears the auto-retry state before the assertion can run.
       */
      mockConnectPlanningStream.mockImplementation(() => ({
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      }));
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
        expect(mockRetryPlanningSession).toHaveBeenCalledWith("session-error-1", undefined);
      });
      await waitFor(() => expect(screen.getByText("Retrying… (attempt 1 of 3)")).toBeDefined());
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: "Start Planning" })).toBeNull();
    });

    it("auto-retries when selecting an errored session from the sidebar", async () => {
      mockConnectPlanningStream.mockImplementation(() => ({
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      }));
      mockFetchAiSessions.mockResolvedValueOnce([
        {
          id: "session-sidebar-error",
          type: "planning",
          status: "error",
          title: "Sidebar errored session",
          projectId: null,
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
        expect(mockRetryPlanningSession).toHaveBeenCalledWith("session-sidebar-error", undefined);
      });
      await waitFor(() => expect(screen.getByText("Retrying… (attempt 1 of 3)")).toBeDefined());
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: "Start Planning" })).toBeNull();
    });

    it("routes malformed persisted result data from sidebar selection to the recoverable error view", async () => {
      mockFetchAiSessions.mockResolvedValueOnce([
        {
          id: "session-malformed-result",
          type: "planning",
          status: "complete",
          title: "Malformed result session",
          projectId: null,
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
        queuePlanningStreamEvent(() => {
          streamHandlers?.onQuestion?.(refinedQuestion);
        });
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
        );
      });

      await waitFor(() => {
        expect(screen.getByText("Which part should we refine?")).toBeDefined();
      });
      expect(screen.queryByText("No active question in session")).toBeNull();
    });

    it.each(["desktop", "mobile"] as const)("keeps resumed Refine Further single-flight on rapid %s activation", async (viewportMode) => {
      mockViewport(viewportMode);
      const resumedSummary: PlanningSummary = {
        title: "Populated summary for duplicate refine",
        description: "Recovered summary with edited details before refine",
        suggestedSize: "M",
        suggestedDependencies: ["FN-001"],
        keyDeliverables: ["Keep edits", "Ask follow-up"],
      };
      const refinedQuestion: PlanningQuestion = {
        id: `q-refine-${viewportMode}`,
        type: "text",
        question: `What should we refine next on ${viewportMode}?`,
        description: "Follow-up from the original refine stream",
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: `session-complete-refine-${viewportMode}`,
        type: "planning",
        status: "complete",
        title: resumedSummary.title,
        inputPayload: JSON.stringify({ initialPlan: "Recover and refine without duplicate generation" }),
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
      let streamClosed = false;
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers = handlers;
        return {
          close: vi.fn(() => {
            streamClosed = true;
          }),
          isConnected: vi.fn(() => !streamClosed),
        };
      });
      mockRespondToPlanning.mockImplementation(async () => {
        queuePlanningStreamEvent(() => {
          if (!streamClosed) {
            streamHandlers?.onQuestion?.(refinedQuestion);
          }
        });
        return { type: "question", data: refinedQuestion };
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId={`session-complete-refine-${viewportMode}`}
        />
      );

      const refineButton = await screen.findByRole("button", { name: "Refine Further" });
      fireEvent.click(refineButton);
      fireEvent.click(refineButton);

      await waitFor(() => {
        expect(mockRespondToPlanning).toHaveBeenCalledTimes(1);
      });
      expect(mockRespondToPlanning).toHaveBeenCalledWith(
        `session-complete-refine-${viewportMode}`,
        { refine: true },
        undefined,
      );

      await waitFor(() => {
        expect(screen.getByText(`What should we refine next on ${viewportMode}?`)).toBeDefined();
      });
      expect(screen.queryByText(/generation already in progress/i)).toBeNull();
      expect(screen.queryByText(/generation in progress/i)).toBeNull();
    });

    it("keeps the refine stream alive when the accepted turn reports generation already in progress", async () => {
      const resumedSummary: PlanningSummary = {
        title: "Backend conflict refine",
        description: "Summary that was already accepted for refinement",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Continue stream"],
      };
      const refinedQuestion: PlanningQuestion = {
        id: "q-refine-conflict",
        type: "text",
        question: "What detail should the already-running refine turn clarify?",
        description: "Follow-up from the active refine generation",
      };

      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-complete-refine-conflict",
        type: "planning",
        status: "complete",
        title: resumedSummary.title,
        inputPayload: JSON.stringify({ initialPlan: "Refine active conflict" }),
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
      let streamClosed = false;
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers = handlers;
        return {
          close: vi.fn(() => {
            streamClosed = true;
          }),
          isConnected: vi.fn(() => !streamClosed),
        };
      });
      mockRespondToPlanning.mockImplementationOnce(async () => {
        queuePlanningStreamEvent(() => {
          if (!streamClosed) {
            streamHandlers?.onQuestion?.(refinedQuestion);
          }
        });
        throw new Error("Generation already in progress for this response");
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          resumeSessionId="session-complete-refine-conflict"
        />
      );

      fireEvent.click(await screen.findByRole("button", { name: "Refine Further" }));

      await waitFor(() => {
        expect(screen.getByText("What detail should the already-running refine turn clarify?")).toBeDefined();
      });
      expect(streamClosed).toBe(false);
      expect(screen.queryByText(/generation already in progress/i)).toBeNull();
      expect(screen.queryByText(/generation in progress/i)).toBeNull();
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
        queuePlanningStreamEvent(() => {
          handlers.onQuestion?.(mockQuestion);
        });

        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      mockRespondToPlanning.mockImplementation(async () => {
        queuePlanningStreamEvent(() => {
          streamHandlers?.onQuestion?.(secondQuestion);
        });
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

  /*
  FNXC:PlanningMode 2026-07-05-00:00:
  FN-7615 regression coverage: Back is deterministic history navigation (a pure server-side
  rewind), not AI generation, so it must never render `.planning-loading` (the "Generating next
  question..."/"AI is thinking..." spinner + Stop screen reserved for real model turns). Cover the
  success path, the failure path (error surfaced, still on a question form), and the
  no-history-yet state where the Back button is absent.
  */
  describe("Back navigation (FN-7615)", () => {
    const secondQuestion: PlanningQuestion = {
      id: "q-requirements",
      type: "text",
      question: "What are the key requirements?",
      description: "Describe the requirements",
    };

    const thirdQuestion: PlanningQuestion = {
      id: "q-details",
      type: "text",
      question: "Any additional details?",
      description: "Optional extra context",
    };

    async function advanceToThirdQuestion() {
      let streamHandlers: any;
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers = handlers;
        queuePlanningStreamEvent(() => {
          handlers.onQuestion?.(mockQuestion);
        });

        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      let respondCallCount = 0;
      mockRespondToPlanning.mockImplementation(async () => {
        respondCallCount += 1;
        const nextQuestion = respondCallCount === 1 ? secondQuestion : thirdQuestion;
        queuePlanningStreamEvent(() => {
          streamHandlers?.onQuestion?.(nextQuestion);
        });
        return { sessionId: "session-123", currentQuestion: null, summary: null };
      });

      const renderResult = render(
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
      fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

      await waitFor(() => {
        expect(screen.getByText("What are the key requirements?")).toBeDefined();
      }, { timeout: 5000 });

      const requirementsTextarea = screen.getByPlaceholderText("Type your answer here...");
      fireEvent.change(requirementsTextarea, { target: { value: "Auth requirements" } });
      fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

      await waitFor(() => {
        expect(screen.getByText("Any additional details?")).toBeDefined();
      }, { timeout: 5000 });

      return renderResult;
    }

    it("never renders the generation screen while going back, and restores the previous question with prior Q&A visible", async () => {
      let resolveRewind!: (value: {
        currentQuestion: PlanningQuestion;
        history: Array<{ question: PlanningQuestion; response: unknown; thinkingOutput?: string }>;
      }) => void;
      mockRewindPlanningSession.mockImplementation(
        () => new Promise((resolve) => {
          resolveRewind = resolve;
        }),
      );

      const { container } = await advanceToThirdQuestion();

      const backButton = screen.getByRole("button", { name: /Back/i });

      await act(async () => {
        fireEvent.click(backButton);
      });

      // Symptom assertion (FN-7615): immediately after the click, while the deterministic
      // rewind is still in flight, the generation view must never be present.
      expect(container.querySelector(".planning-loading")).toBeNull();
      expect(screen.queryByText("Generating next question...")).toBeNull();
      expect(screen.queryByText("AI is thinking...")).toBeNull();

      await act(async () => {
        resolveRewind({
          currentQuestion: secondQuestion,
          history: [{ question: mockQuestion, response: { [mockQuestion.id]: "medium" } }],
        });
      });

      await waitFor(() => {
        expect(screen.getByText("What are the key requirements?")).toBeDefined();
      });

      // Symptom assertion (FN-7615): after the async rewind settles, the generation view must
      // still never have appeared, and the previous question form is shown with the prior Q&A
      // (Q1's restored answer) visible above it.
      expect(container.querySelector(".planning-loading")).toBeNull();
      expect(screen.getByTestId("conversation-history")).toBeDefined();
      expect(screen.getByText("What is the scope?")).toBeDefined();
      expect(screen.getByText("Medium")).toBeDefined();
      expect(mockRewindPlanningSession).toHaveBeenCalledWith("session-123", undefined);
    });

    it("stays on the question form and surfaces an error when the rewind request fails", async () => {
      mockRewindPlanningSession.mockRejectedValueOnce(new Error("rewind failed"));

      const { container } = await advanceToThirdQuestion();

      const backButton = screen.getByRole("button", { name: /Back/i });

      await act(async () => {
        fireEvent.click(backButton);
      });

      expect(container.querySelector(".planning-loading")).toBeNull();

      await waitFor(() => {
        expect(screen.getByText("rewind failed")).toBeDefined();
      });

      // Still on a question form (not loading, not generation) after the failure.
      expect(container.querySelector(".planning-loading")).toBeNull();
      expect(screen.getByText("Any additional details?")).toBeDefined();
    });

    it("does not render a Back button on the first question, before any history exists", async () => {
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

      expect(screen.queryByRole("button", { name: /Back/i })).toBeNull();
    });
  });

  describe("copy original prompt recovery", () => {
    it("copies the fresh original prompt from an active interview", async () => {
      const originalPrompt = "Build a recovery flow\nwith a restart path";
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
        target: { value: originalPrompt },
      });
      fireEvent.click(screen.getByRole("button", { name: "Start Planning" }));

      const copyButton = await screen.findByRole("button", { name: /copy original prompt/i });
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(mockCopyTextToClipboard).toHaveBeenCalledWith(originalPrompt);
        expect(mockAddToast).toHaveBeenCalledWith("Prompt copied to clipboard", "success");
      });
    });

    it("copies the fresh original prompt after the interview errors", async () => {
      const streamHandlers: any[] = [];
      const originalPrompt = "Build an interview that can recover";
      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        streamHandlers.push(handlers);
        return { close: vi.fn(), isConnected: vi.fn().mockReturnValue(true) };
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
        target: { value: originalPrompt },
      });
      fireEvent.click(screen.getByRole("button", { name: "Start Planning" }));
      await waitFor(() => expect(streamHandlers).toHaveLength(1));

      for (let index = 0; index < 4; index += 1) {
        await act(async () => {
          streamHandlers[index].onError?.("Planning provider failed");
        });
      }

      const copyButton = await screen.findByRole("button", { name: /copy original prompt/i });
      fireEvent.click(copyButton);
      await waitFor(() => expect(mockCopyTextToClipboard).toHaveBeenCalledWith(originalPrompt));
    });

    it("restores a resumable awaiting-input session prompt before copying", async () => {
      const originalPrompt = "Resume awaiting-input prompt";
      mockFetchAiSession.mockResolvedValueOnce({
        id: "copy-awaiting-input",
        type: "planning",
        status: "awaiting_input",
        title: "Recoverable session",
        inputPayload: JSON.stringify({ initialPlan: originalPrompt }),
        conversationHistory: "[]",
        currentQuestion: JSON.stringify(mockQuestion),
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
          resumeSessionId="copy-awaiting-input"
        />,
      );

      const copyButton = await screen.findByRole("button", { name: /copy original prompt/i });
      fireEvent.click(copyButton);
      await waitFor(() => expect(mockCopyTextToClipboard).toHaveBeenCalledWith(originalPrompt));
    });


    it.each(["desktop", "mobile"] as const)("hides Copy prompt without a persisted prompt on %s", async (viewportMode) => {
      mockViewport(viewportMode);
      mockFetchAiSession.mockResolvedValueOnce({
        id: `copy-empty-${viewportMode}`,
        type: "planning",
        status: "awaiting_input",
        title: "Missing prompt",
        inputPayload: "{}",
        conversationHistory: "[]",
        currentQuestion: JSON.stringify(mockQuestion),
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
          resumeSessionId={`copy-empty-${viewportMode}`}
        />,
      );

      await screen.findByText(mockQuestion.question);
      expect(screen.queryByRole("button", { name: /copy original prompt/i })).toBeNull();
      expect(mockCopyTextToClipboard).not.toHaveBeenCalled();
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

  describe("planning sidebar loading", () => {
    it("renders skeleton rows rather than a blank sidebar while the session refresh is pending", async () => {
      let resolveSessions!: (sessions: Array<Record<string, unknown>>) => void;
      mockFetchAiSessions.mockImplementationOnce(() => new Promise((resolve) => {
        resolveSessions = resolve;
      }));

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      expect(await screen.findByTestId("planning-sidebar-skeleton")).toBeDefined();
      expect(screen.queryByText(/No saved sessions yet/i)).toBeNull();

      await act(async () => {
        resolveSessions([{
          id: "loaded-planning-session",
          type: "planning",
          status: "complete",
          title: "Loaded planning session",
          projectId: null,
          updatedAt: "2026-07-15T00:00:00.000Z",
        }]);
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Loaded planning session/i })).toBeDefined();
        expect(screen.queryByTestId("planning-sidebar-skeleton")).toBeNull();
      });
    });

    it("shows initial background planning sessions before an authoritative refresh resolves", async () => {
      mockFetchAiSessions.mockImplementationOnce(() => new Promise(() => {}));
      const initialSessions = [{
        id: "background-planning-session",
        type: "planning" as const,
        status: "awaiting_input" as const,
        title: "Continue background planning",
        projectId: null,
        updatedAt: "2026-07-15T00:00:00.000Z",
      }];

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          initialSessions={initialSessions}
        />,
      );

      expect(screen.getByRole("button", { name: /Continue background planning/i })).toBeDefined();
      expect(screen.queryByTestId("planning-sidebar-skeleton")).toBeNull();
      await waitFor(() => expect(mockFetchAiSessions).toHaveBeenCalledTimes(1));
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
            updatedAt: "2026-01-01T00:00:00.000Z",
            archived: false,
          },
          {
            id: "session-b",
            type: "planning",
            status: "complete",
            title: "peer",
            projectId: null,
            updatedAt: "2026-01-02T00:00:00.000Z",
            archived: false,
          },
          {
            id: "session-a",
            type: "planning",
            status: "complete",
            title: "newer",
            projectId: null,
            updatedAt: "2026-01-03T00:00:00.000Z",
            archived: false,
          },
          {
            id: "session-c",
            type: "planning",
            status: "complete",
            title: "tie-first",
            projectId: null,
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
          updatedAt: "2026-01-03T00:00:00.000Z",
          archived: false,
        },
        {
          id: "session-b",
          type: "planning",
          status: "complete",
          title: "peer",
          projectId: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
          archived: false,
        },
        {
          id: "session-c",
          type: "planning",
          status: "complete",
          title: "tie-first",
          projectId: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
          archived: false,
        },
      ]);
    });
  });
});
