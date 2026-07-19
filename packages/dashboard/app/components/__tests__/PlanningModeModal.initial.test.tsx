import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, renderHook, screen, fireEvent, waitFor, within } from "@testing-library/react";
import * as api from "../../api";
import { PlanningModeModal } from "../PlanningModeModal";
import { TaskDetailModal } from "../TaskDetailModal";

const mockAddToast = vi.fn();

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({
    addToast: mockAddToast,
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
  mockValidatePlanningSession,
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
  validatePlanningSession: (...args: any[]) => mockValidatePlanningSession(...args),
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
  FNXC:PlanningModeSettings 2026-07-18-10:50:
  Sync-settle clarification settings so Start Planning is not racey under full-suite load.
  */
  fetchGlobalSettings: vi.fn(() => {
    const settled = {
      then(onFulfilled: (settings: { agentClarificationEnabled: boolean }) => unknown) {
        onFulfilled({ agentClarificationEnabled: false });
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
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
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
    mockAddToast.mockReset();
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
    mockValidatePlanningSession.mockResolvedValue({ summary: mockSummary, validated: true });
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

  /*
  FNXC:PlanningMode 2026-07-04-17:04:
  The draft-creation debounce tests assert a NEGATIVE (a 300ms debounce interval elapsing without spawning a duplicate
  createPlanningDraft). They previously did this with real-time `setTimeout(350)` sleeps, burning ~2.1s of wall-clock per
  run for zero added signal (FN-5048: do not add slow tests). Those tests now drive fake timers via
  `vi.advanceTimersByTimeAsync`, which advances the debounce deterministically and flushes the mock's promise
  microtasks between timers. This afterEach restores real timers so the remaining real-timer + waitFor tests are unaffected.
  */
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Initial view", () => {
    it("renders the initial input view when open", () => {
      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
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
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      expect(screen.queryByText("Planning Mode")).toBeNull();
    });

    it("does not auto-focus the initial textarea on mobile open until the user focuses it", () => {
      mockViewport("mobile");

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByLabelText("What do you want to build?") as HTMLTextAreaElement;
      expect(document.activeElement).not.toBe(textarea);

      act(() => {
        textarea.focus();
      });

      expect(document.activeElement).toBe(textarea);
    });

    it("does not auto-focus the initial textarea in embedded desktop presentation", () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          initialPlan={undefined}
          presentation="embedded"
        />
      );

      const textarea = screen.getByLabelText("What do you want to build?") as HTMLTextAreaElement;
      expect(textarea.value).toBe("");
      expect(document.activeElement).not.toBe(textarea);
    });

    it("auto-starts populated initialPlan handoffs without focusing the initial textarea", async () => {
      const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, "focus");

      try {
        render(
          <PlanningModeModal
            isOpen={true}
            onClose={mockOnClose}
            onTaskCreated={mockOnTaskCreated}
            onTasksCreated={vi.fn()}
            tasks={mockTasks}
            initialPlan="Build a login system from handoff"
          />
        );

        await waitFor(() => {
          expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build a login system from handoff", undefined, undefined, {
            clarificationEnabled: false,
          }, undefined);
        });

        expect(focusSpy).not.toHaveBeenCalled();
      } finally {
        focusSpy.mockRestore();
      }
    });

    it("focuses the initial textarea when New session is clicked while already composing", () => {
      const rafSpy = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((callback: FrameRequestCallback) => {
          callback(0);
          return 1;
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

        const textarea = screen.getByLabelText("What do you want to build?") as HTMLTextAreaElement;
        expect(document.activeElement).not.toBe(textarea);

        fireEvent.click(screen.getByRole("button", { name: "New session" }));

        expect(rafSpy).toHaveBeenCalled();
        expect(document.activeElement).toBe(textarea);
      } finally {
        rafSpy.mockRestore();
      }
    });

    it("resets a selected desktop session to compose view and focuses New session", async () => {
      const rafSpy = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        });
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
      mockFetchAiSession.mockResolvedValue({
        id: "session-existing",
        type: "planning",
        status: "complete",
        title: "Existing session",
        inputPayload: JSON.stringify({ initialPlan: "Existing selected plan" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: JSON.stringify(mockSummary),
        error: null,
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

        fireEvent.click(await screen.findByText("Existing session"));

        await waitFor(() => {
          expect(mockFetchAiSession).toHaveBeenCalledWith("session-existing");
        });

        fireEvent.click(screen.getByRole("button", { name: "New session" }));

        const textarea = screen.getByLabelText("What do you want to build?") as HTMLTextAreaElement;
        expect(textarea.value).toBe("");
        expect(document.activeElement).toBe(textarea);
        expect(screen.getByRole("button", { name: /Start Planning/ })).toBeDisabled();
      } finally {
        rafSpy.mockRestore();
      }
    });

    it("shows the mobile detail pane and focuses compose when New session is clicked from the list", async () => {
      mockViewport("mobile");
      const rafSpy = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        });
      mockFetchAiSessions.mockResolvedValue([
        {
          id: "session-mobile",
          type: "planning",
          status: "complete",
          title: "Mobile session",
          preview: "A mobile planning session",
          projectId: null,
          lockedByTab: null,
          updatedAt: new Date().toISOString(),
          archived: false,
        },
      ]);

      try {
        const { container } = render(
          <PlanningModeModal
            isOpen={true}
            onClose={mockOnClose}
            onTaskCreated={mockOnTaskCreated}
            onTasksCreated={vi.fn()}
            tasks={mockTasks}
          />,
        );

        await screen.findByText("Mobile session");
        const body = container.querySelector(".planning-modal-body");
        await waitFor(() => {
          expect(body?.classList.contains("planning-modal-body--show-list")).toBe(true);
        });

        fireEvent.click(screen.getByRole("button", { name: "New session" }));

        const textarea = screen.getByLabelText("What do you want to build?") as HTMLTextAreaElement;
        expect(body?.classList.contains("planning-modal-body--show-detail")).toBe(true);
        expect(document.activeElement).toBe(textarea);
      } finally {
        rafSpy.mockRestore();
      }
    });

    it("preserves existing compose draft text and moves the caret to the end on New session focus", () => {
      const rafSpy = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((callback: FrameRequestCallback) => {
          callback(0);
          return 1;
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

        const textarea = screen.getByLabelText("What do you want to build?") as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: "Keep this restored draft" } });
        textarea.setSelectionRange(0, 0);

        fireEvent.click(screen.getByRole("button", { name: "New session" }));

        expect(textarea.value).toBe("Keep this restored draft");
        expect(document.activeElement).toBe(textarea);
        expect(textarea.selectionStart).toBe(textarea.value.length);
        expect(textarea.selectionEnd).toBe(textarea.value.length);
      } finally {
        rafSpy.mockRestore();
      }
    });

    it("mobile close path blurs focused input and resets viewport scroll", () => {
      mockViewport("mobile");
      const scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
      const rafSpy = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((callback: FrameRequestCallback) => {
          callback(0);
          return 1;
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

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/) as HTMLTextAreaElement;
      act(() => {
        textarea.focus();
      });
      const blurSpy = vi.spyOn(textarea, "blur");

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
      });

      expect(blurSpy).toHaveBeenCalledTimes(1);
      expect(scrollToSpy).toHaveBeenCalledWith(0, 0);
      expect(rafSpy).toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("hides send to background button in initial state", () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      expect(screen.queryByLabelText("Send to background")).toBeNull();
    });

    it("enables start button when text is entered", async () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      const startButton = screen.getByText("Start Planning");
      expect(startButton.closest("button")?.hasAttribute("disabled")).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Advanced planning settings" }));
      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      await waitFor(() => expect(document.querySelector("#planning-clarification-enabled")).not.toBeDisabled());
      fireEvent.change(textarea, { target: { value: "Test plan" } });

      expect(startButton.closest("button")?.hasAttribute("disabled")).toBe(false);
    });

    it("shows example chips", () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
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

      expect(screen.getByRole("button", { name: "Advanced planning settings" })).toBeDefined();
      expect(screen.queryByRole("button", { name: "Planning Model" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Advanced planning settings" }));

      const modelTrigger = screen.getByRole("button", { name: "Planning Model" });
      expect(modelTrigger).toBeDefined();

      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalledTimes(1);
        expect(screen.getByText("openai/gpt-4o")).toBeDefined();
      });
    });

    it("shows resolved default model badge and switches to override badge when selected", async () => {
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

      fireEvent.click(screen.getByRole("button", { name: "Advanced planning settings" }));
      expect(screen.getByText("openai/gpt-4o")).toBeDefined();
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

      fireEvent.click(screen.getByRole("button", { name: "Advanced planning settings" }));
      fireEvent.click(screen.getByRole("button", { name: "Planning Model" }));
      fireEvent.click(screen.getByRole("option", { name: /Claude Sonnet 4.5/ }));

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build auth system", undefined, {
          planningModelProvider: "anthropic",
          planningModelId: "claude-sonnet-4-5",
        }, {
          clarificationEnabled: false,
        }, undefined);
      });
    });

    it("keeps advanced disclosure collapsed by default and reveals controls when expanded", async () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      const disclosureButton = screen.getByRole("button", { name: "Advanced planning settings" });
      expect(disclosureButton).toBeDefined();

      const disclosure = disclosureButton.closest(".onboarding-disclosure");
      expect(disclosure).not.toBeNull();
      const disclosureScope = within(disclosure as HTMLElement);

      expect(disclosureButton.getAttribute("aria-expanded")).toBe("false");
      expect(disclosureScope.queryByRole("button", { name: "Planning Model" })).toBeNull();
      expect(disclosureScope.queryByText(/Selects which model runs the planning interview/)).toBeNull();

      fireEvent.click(disclosureButton);
      expect(disclosureButton.getAttribute("aria-expanded")).toBe("true");

      expect(disclosureScope.getByRole("button", { name: "Planning Model" })).toBeDefined();
      await waitFor(() => {
        expect(disclosureScope.getByText("openai/gpt-4o")).toBeDefined();
      });
      expect(disclosureScope.getByText(/Selects which model runs the planning interview/)).toBeDefined();
      expect(disclosureScope.getByLabelText("Allow follow-up clarification questions")).toBeDefined();
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

      fireEvent.click(screen.getByRole("button", { name: "Advanced planning settings" }));
      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      await waitFor(() => expect(document.querySelector("#planning-clarification-enabled")).not.toBeDisabled());
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build auth system", undefined, undefined, {
          clarificationEnabled: false,
        }, undefined);
      });
    });

    it("auto-creates a draft after typing and reuses it when starting", async () => {
      // FNXC:PlanningMode 2026-07-04-17:04: fake timers drive the 300ms create-draft debounce deterministically
      // (advanceTimersByTimeAsync flushes the mock promise between timers), replacing real-time sleeps.
      vi.useFakeTimers();
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
      fireEvent.change(textarea, { target: { value: "Build a detailed auth system plan" } });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      expect(mockCreatePlanningDraft).toHaveBeenCalledTimes(1);
      expect(mockCreatePlanningDraft).toHaveBeenCalledWith(
        "Build a detailed auth system plan",
        undefined,
        undefined,
      );

      // Sidebar shows the inputPayload-derived preview for draft rows so
      // multiple drafts are distinguishable, not the placeholder title that
      // createDraftSession returns. The text also appears in the textarea
      // value, so scope the query to the sidebar item title element.
      const sidebarItem = document.querySelector(".planning-sidebar-item-title");
      expect(sidebarItem?.textContent).toBe("Build a detailed auth system plan");

      fireEvent.change(textarea, { target: { value: "Build a detailed auth system plan with extras" } });
      // Let the debounce interval elapse; the existing draft must be reused, not re-created.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      expect(mockCreatePlanningDraft).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByText("Start Planning"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(mockStartPlanningStreaming).toHaveBeenCalledWith(
        "Build a detailed auth system plan with extras",
        undefined,
        undefined,
        {
          clarificationEnabled: false,
        },
        "draft-123",
      );
    });

    // FNXC:PlanningMode 2026-07-01-00:00: regression — deliberate typing must not spawn one draft per keystroke.
    // Original symptom: each character created a new draft while the create-draft request was in flight, because
    // the create-suppression guard only checked draftSessionIdRef, which is populated after the round-trip resolves.
    it("creates exactly one draft when keystrokes arrive while the create request is still in flight", async () => {
      // FNXC:PlanningMode 2026-07-04-17:04: fake timers drive the 300ms debounce deterministically; the in-flight
      // create stays unresolved (resolveCreate) so the suppression sentinel is what collapses keystrokes to one create.
      vi.useFakeTimers();
      let resolveCreate: ((value: { sessionId: string; title: string }) => void) | undefined;
      mockCreatePlanningDraft.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          }),
      );

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

      // First keystroke → debounce (300ms) fires the create; it stays in flight (unresolved).
      fireEvent.change(textarea, { target: { value: "Build" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      expect(mockCreatePlanningDraft).toHaveBeenCalledTimes(1);

      // Subsequent keystrokes while the create is still in flight must be suppressed by the
      // synchronous in-flight sentinel — not each spawn another draft.
      fireEvent.change(textarea, { target: { value: "Build a" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      fireEvent.change(textarea, { target: { value: "Build an" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      fireEvent.change(textarea, { target: { value: "Build an auth" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });

      expect(mockCreatePlanningDraft).toHaveBeenCalledTimes(1);

      // Once the create resolves and further edits arrive, they patch the single draft — no new create.
      resolveCreate?.({ sessionId: "draft-123", title: "New planning session" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(document.querySelector(".planning-sidebar-item-title")).not.toBeNull();
      fireEvent.change(textarea, { target: { value: "Build an auth system" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      expect(mockCreatePlanningDraft).toHaveBeenCalledTimes(1);
    });

    it("auto-starts planning when initialPlan prop is provided", async () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          initialPlan="Build a login system from new task dialog"
        />
      );

      // Wait for startPlanningStreaming to be called (allow time for setTimeout in useEffect)
      await waitFor(() => {
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build a login system from new task dialog", undefined, undefined, {
          clarificationEnabled: false,
        }, undefined);
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
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          initialPlan="Pre-filled plan from new task"
        />
      );

      // The auto-start should happen with the initial plan (allow time for setTimeout in useEffect)
      await waitFor(() => {
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Pre-filled plan from new task", undefined, undefined, {
          clarificationEnabled: false,
        }, undefined);
      }, { timeout: 2000 });
    });

    it("shows streamed thinking in loading view before first question arrives", async () => {
      mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        setTimeout(() => {
          handlers.onThinking?.("Analyzing requirements...");
        }, 0);

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

      fireEvent.click(screen.getByRole("button", { name: "Advanced planning settings" }));
      await waitFor(() => expect(document.querySelector("#planning-clarification-enabled")).not.toBeDisabled());
      fireEvent.change(screen.getByPlaceholderText(/e.g., Build a user authentication/), {
        target: { value: "Draft a migration plan" },
      });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("AI is thinking...")).toBeDefined();
        expect(screen.getByText("Analyzing requirements...")).toBeDefined();
      });

      const loader = document.querySelector(".planning-loading .spin");
      expect(loader).not.toBeNull();

      const { loadAllAppCss } = await import("../../test/cssFixture");
      const css = loadAllAppCss();
      /*
      FNXC:LoadingIndicators 2026-06-25-12:05:
      Planning's first-paint spinner contract follows the shared collision-proof dashboard keyframe name. Do not require the obsolete global `spin` keyframe here; lazy CSS chunks can redefine generic keyframes.
      */
      expect(css).toMatch(/\.spin\s*\{[^}]*animation:\s*fusion-spinner-spin\s+1s\s+linear\s+infinite;/);

      expect(screen.getByRole("button", { name: "Hide thinking" })).toBeDefined();
      expect(document.querySelector(".planning-thinking-output")?.textContent).toContain("Analyzing requirements...");
    });
  });

  describe("modal height constraint regression", () => {
    it("desktop planning modal max-height accounts for overlay padding", async () => {
      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />
      );

      const modal = container.querySelector(".planning-modal");
      expect(modal).toBeTruthy();

      const { loadAllAppCss } = await import("../../test/cssFixture");
      const css = loadAllAppCss();

      const blockMatch = css.match(
        /\.planning-modal\s*\{[^}]*max-height:\s*([^;]+);/,
      );
      expect(blockMatch).toBeTruthy();

      const maxHeightValue = blockMatch![1].trim();
      expect(maxHeightValue).toContain("calc(");
      expect(maxHeightValue).toContain("100dvh");
      expect(maxHeightValue).toContain("--overlay-padding-top");
    });

    it("uses planning-scoped disclosure overrides to remove inherited content indent", async () => {
      const { loadAllAppCssBaseOnly } = await import("../../test/cssFixture");
      const css = loadAllAppCssBaseOnly();

      const blockMatch = css.match(
        /\.planning-advanced-disclosure\s+\.onboarding-disclosure-content\s*\{[^}]*\}/,
      );
      expect(blockMatch).toBeTruthy();
      expect(blockMatch![0]).toContain("padding-inline-start: 0;");
      expect(blockMatch![0]).toContain("justify-content: center;");
    });

    it("keeps mobile question view top spacing compact", async () => {
      const { loadAllAppCss } = await import("../../test/cssFixture");
      const css = loadAllAppCss();
      const mobileBlocks = getMediaBlocks(css, "@media (max-width: 768px)");
      const mobileCss = mobileBlocks.join("\n");

      expect(mobileCss).toContain(".planning-question-scroll");
      expect(mobileCss).toContain("padding-top: var(--space-sm);");
      expect(mobileCss).toContain("gap: var(--space-md);");
    });
  });

});
