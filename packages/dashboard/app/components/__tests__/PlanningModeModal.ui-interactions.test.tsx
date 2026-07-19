/*
FNXC:DashboardTests 2026-06-14-08:31:
FN-6441 rescued this orphaned component test after standalone dashboard-app execution passed without assertion, timeout, or source-code changes. Keep the planning modal UI-interaction coverage in app backfill so question flow, summary, and breakdown interactions remain executed after leaving the skip-list.

FNXC:DashboardTests 2026-06-14-08:32:
PlanningModeModal calls useToast(), which throws without a ToastProvider. These tests render it bare, so the hook stays mocked in the same style as PlanningModeModal.autosize.test.tsx instead of introducing broad provider wiring during skip-list rescue.
*/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
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
import userEvent from "@testing-library/user-event";
import * as api from "../../api";
import { PlanningModeModal } from "../PlanningModeModal";
import { TaskDetailModal } from "../TaskDetailModal";
import type { MergeResult, PlanningQuestion } from "@fusion/core";
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
  fetchTaskEffectiveSettings: vi.fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
  /*
  FNXC:PlanningModeSettings 2026-07-18-07:20:
  Same FN-8245 deterministic settle as planning-flow: Start Planning is gated on
  clarificationSettingsLoading, so a microtask-resolved fetchGlobalSettings makes
  fireEvent.click races no-op and leaves the suite red under full-suite load.
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
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
  getViewportMode: () => mockUseViewportMode(),
  isMobileViewport: () => mockUseViewportMode() === "mobile",
  useViewportMode: () => mockUseViewportMode(),
}));

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: (...args: any[]) => mockUseMobileKeyboard(...args),
}));

const MARKDOWN_QUESTION: PlanningQuestion = {
  id: "markdown-question",
  type: "text",
  question: "Do you want **fast** mode?\n\nfirst line  \nsecond line\n\n- Option A\n- Option B",
  description: "Choose the mode before continuing.",
};

function expectMarkdownQuestionFormatting() {
  const question = screen.getByTestId("planning-question-text");
  expect(question.querySelector("strong")).toHaveTextContent("fast");
  expect([...question.querySelectorAll("p")].find((paragraph) => paragraph.textContent?.includes("first line"))?.querySelector("br")).not.toBeNull();
  expect([...question.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["Option A", "Option B"]);
  expect(question).not.toHaveTextContent("**fast**");
}

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

      expect(screen.getByText("Example task")).toBeDefined();
      expect(screen.getByRole("button", { name: "Plan" })).toBeDefined();
      expect(container.querySelector(".detail-body")).not.toBeNull();
    });
  });

  it("renders markdown formatting in AI planning questions", async () => {
    mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
      setTimeout(() => handlers.onQuestion?.(MARKDOWN_QUESTION), 0);
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
      target: { value: "Format the planning question" },
    });
    fireEvent.click(screen.getByText("Start Planning"));

    await waitFor(expectMarkdownQuestionFormatting);
  });

  describe("Loading state", () => {
    function getPlanningLoadingSpinner(container: HTMLElement): SVGSVGElement {
      const spinner = container.querySelector<SVGSVGElement>(".planning-loading svg.spin");
      expect(spinner).not.toBeNull();
      return spinner!;
    }

    async function startPlanningAndHoldLoading(container: HTMLElement): Promise<SVGSVGElement> {
      mockConnectPlanningStream.mockImplementationOnce(() => ({
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      }));

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Generating next question...")).toBeDefined();
      });

      return getPlanningLoadingSpinner(container);
    }

    it.each([
      { presentation: "modal" as const, viewport: "desktop" as const },
      { presentation: "modal" as const, viewport: "mobile" as const },
      { presentation: "embedded" as const, viewport: "desktop" as const },
      { presentation: "embedded" as const, viewport: "mobile" as const },
    ])("keeps the first loading-frame spinner animated for $presentation on $viewport", async ({ presentation, viewport }) => {
      mockViewport(viewport);

      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          presentation={presentation}
        />
      );

      const spinner = await startPlanningAndHoldLoading(container);

      expect(spinner).toHaveClass("spin");
      expect(spinner).toHaveClass("icon-todo");
      expect(spinner.style.animation).toBe("");
      expect(spinner.style.animationName).toBe("");
    });

    it("uses SVG-safe spin geometry so the first Planning loading paint rotates", () => {
      const styles = readFileSync(resolve(process.cwd(), "app/styles.css"), "utf8");
      const sharedSvgSpinRule = styles.match(/svg\.animate-spin,\s*\n(?:svg\.[\w-]+,\s*\n)*svg\.[\w-]+\s*\{[^}]*\}/)?.[0] ?? "";

      expect(sharedSvgSpinRule).toContain("transform-box: fill-box");
    });

    it("keeps the streaming loading-frame spinner on the same animation contract", async () => {
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
          presentation="embedded"
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Generating next question...")).toBeDefined();
      });

      act(() => {
        streamHandlers.onThinking?.("Analyzing requirements...");
      });

      await waitFor(() => {
        expect(screen.getByText("AI is thinking...")).toBeDefined();
      });

      const spinner = getPlanningLoadingSpinner(container);
      expect(spinner).toHaveClass("spin");
      expect(spinner.style.animation).toBe("");
      expect(spinner.style.animationName).toBe("");
    });

    it("keeps other Planning Mode Loader2 spin affordances wired", () => {
      const source = readFileSync(resolve(process.cwd(), "app/components/PlanningModeModal.tsx"), "utf8");

      expect(source).toContain('className="spin planning-sidebar-status-icon planning-sidebar-status-generating"');
      expect(source).toContain('className="spin icon-mr-8"');
      expect(source).toContain('className="spin icon-mr-6"');
    });

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
      /*
      FNXC:DashboardTests 2026-07-18-11:45:
      Full Suite shard 3 failed when a 50ms setTimeout second-question race skipped the
      loading paint under CI load. Gate the next SSE question on an explicit release so
      `.planning-loading` is assertable before the follow-up question arrives.
      */
      const secondQuestion: PlanningQuestion = {
        id: "q-requirements",
        type: "text",
        question: "What are the key requirements?",
        description: "Describe the requirements",
      };

      let streamHandlers: any = null;
      let releaseSecondQuestion: (() => void) | null = null;
      const secondQuestionGate = new Promise<void>((resolve) => {
        releaseSecondQuestion = resolve;
      });

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
        // Hold the follow-up question until the loading UI has been observed.
        void secondQuestionGate.then(() => {
          if (streamHandlers) {
            streamHandlers.onQuestion?.(secondQuestion);
          }
        });
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

      await act(async () => {
        releaseSecondQuestion?.();
      });

      // Wait for second question to appear
      await waitFor(() => {
        expect(screen.getByText("What are the key requirements?")).toBeDefined();
      });
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

  /*
  FNXC:Planning 2026-06-23-02:00:
  The embedded Planning sidebar is resizable like Missions: a desktop-only drag handle (role=separator) drives an inline width on .planning-sidebar that persists to localStorage and is clamped to the PLANNING_SIDEBAR_MIN/MAX range. These tests assert the handle exists on desktop, persists a clamped width on arrow-key resize, restores from localStorage, and is absent on mobile (where the sidebar stacks full-width).
  */
  describe("Resizable sidebar (Missions parity)", () => {
    const STORAGE_KEY = "fusion:planning-sidebar-width";

    beforeEach(() => {
      window.localStorage.removeItem(STORAGE_KEY);
    });

    function renderEmbedded() {
      return render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
          presentation="embedded"
        />,
      );
    }

    it("renders a desktop resize handle and defaults the sidebar to 300px", () => {
      mockViewport("desktop");
      const { container } = renderEmbedded();

      const handle = container.querySelector(".planning-sidebar-resize-handle");
      expect(handle).not.toBeNull();
      expect(handle?.getAttribute("role")).toBe("separator");
      expect(handle?.getAttribute("aria-orientation")).toBe("vertical");

      const sidebar = container.querySelector<HTMLElement>(".planning-sidebar");
      expect(sidebar?.style.width).toBe("300px");
    });

    it("clamps and persists width on arrow-key resize", () => {
      mockViewport("desktop");
      const { container } = renderEmbedded();

      const handle = container.querySelector<HTMLElement>(".planning-sidebar-resize-handle")!;
      // Shift+ArrowRight steps +50 -> 350px, persisted.
      fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });

      const sidebar = container.querySelector<HTMLElement>(".planning-sidebar");
      expect(sidebar?.style.width).toBe("350px");
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("350");

      // ArrowLeft below the minimum clamps to PLANNING_SIDEBAR_MIN_WIDTH (220).
      for (let i = 0; i < 20; i += 1) {
        fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
      }
      expect(sidebar?.style.width).toBe("220px");
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("220");
    });

    it("restores a persisted clamped width from localStorage", () => {
      window.localStorage.setItem(STORAGE_KEY, "9999");
      mockViewport("desktop");
      const { container } = renderEmbedded();

      // Out-of-range stored value clamps to PLANNING_SIDEBAR_MAX_WIDTH (560).
      const sidebar = container.querySelector<HTMLElement>(".planning-sidebar");
      expect(sidebar?.style.width).toBe("560px");
    });

    it("omits the resize handle and inline width on mobile", () => {
      mockViewport("mobile");
      const { container } = renderEmbedded();

      expect(container.querySelector(".planning-sidebar-resize-handle")).toBeNull();
      const sidebar = container.querySelector<HTMLElement>(".planning-sidebar");
      expect(sidebar?.style.width).toBe("");
    });
  });

  describe("Summary markdown preview toggle", () => {
    async function renderPlanningSummary(description: string) {
      mockConnectPlanningStream.mockImplementationOnce((_sessionId: string, _projectId: string | undefined, handlers: any) => {
        setTimeout(() => {
          handlers.onSummary?.({
            ...mockSummary,
            description,
          });
        }, 10);

        return {
          close: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
        };
      });

      const result = render(
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

      return result;
    }

    it("toggles description between plain textarea and formatted markdown preview", async () => {
      const { container } = await renderPlanningSummary("## Heading\n\n- item\n\n**bold**");

      expect(container.querySelector(".planning-description-preview")).not.toBeNull();
      expect(container.querySelector(".planning-textarea")).toBeNull();
      expect(screen.getByRole("heading", { level: 2, name: "Heading" })).toBeDefined();
      expect(container.querySelector("strong")?.textContent).toBe("bold");

      fireEvent.click(screen.getByTestId("planning-description-markdown-toggle"));

      await waitFor(() => {
        expect(container.querySelector(".planning-textarea")).not.toBeNull();
        expect(container.querySelector(".planning-description-preview")).toBeNull();
      });

      fireEvent.click(screen.getByTestId("planning-description-markdown-toggle"));

      await waitFor(() => {
        expect(container.querySelector(".planning-description-preview")).not.toBeNull();
        expect(screen.getByRole("heading", { level: 2, name: "Heading" })).toBeDefined();
        expect(container.querySelector("strong")?.textContent).toBe("bold");
      });
    });

    it.each([
      { viewport: "mobile" as const, typedDescription: "Mobile summary accepts spaces" },
      { viewport: "desktop" as const, typedDescription: "Desktop summary accepts spaces" },
    ])("preserves typed spaces in the $viewport summary description textarea", async ({ viewport, typedDescription }) => {
      mockViewport(viewport);
      const user = userEvent.setup();
      await renderPlanningSummary("Generated summary with existing words");
      fireEvent.click(screen.getByTestId("planning-description-markdown-toggle"));

      const textarea = screen.getByLabelText("Description") as HTMLTextAreaElement;
      textarea.focus();
      textarea.setSelectionRange(0, textarea.value.length);
      await user.type(textarea, typedDescription);

      expect(textarea.value).toContain(typedDescription);
      expect(textarea.value).not.toContain(typedDescription.replaceAll(" ", ""));
      expect(screen.getByRole("button", { name: /Create Single Task/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /Break into Tasks/i })).toBeDefined();
    });

    it("expands and collapses the mobile summary description without breaking the adjacent markdown toggle", async () => {
      mockViewport("mobile");
      const { container } = await renderPlanningSummary(
        "## Heading\n\n" +
          "This is a long planning description that should visibly change between collapsed and expanded summary states on mobile.\n\n" +
          "- Keep markdown available\n" +
          "- Keep expand available",
      );

      const markdownToggle = screen.getByTestId("planning-description-markdown-toggle");
      const expandButton = screen.getByRole("button", { name: "Expand description" });
      expect(markdownToggle.closest("label")).toBeNull();
      expect(expandButton.closest("label")).toBeNull();

      expect(container.querySelector(".planning-description-preview")).not.toBeNull();
      expect(container.querySelector(".planning-textarea")).toBeNull();

      fireEvent.click(markdownToggle);

      const textarea = container.querySelector<HTMLTextAreaElement>(".planning-textarea");
      expect(textarea).not.toBeNull();
      expect(textarea?.classList.contains("expanded")).toBe(false);

      fireEvent.click(expandButton);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Collapse description" })).toBeDefined();
        expect(container.querySelector(".planning-textarea")?.classList.contains("expanded")).toBe(true);
      });

      fireEvent.click(markdownToggle);

      await waitFor(() => {
        const preview = container.querySelector(".planning-description-preview");
        expect(preview).not.toBeNull();
        expect(preview?.classList.contains("expanded")).toBe(true);
        expect(screen.getByRole("heading", { level: 2, name: "Heading" })).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Collapse description" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Expand description" })).toBeDefined();
        expect(container.querySelector(".planning-description-preview")?.classList.contains("expanded")).toBe(false);
      });

      fireEvent.click(markdownToggle);

      await waitFor(() => {
        expect(container.querySelector(".planning-textarea")).not.toBeNull();
        expect(container.querySelector(".planning-description-preview")).toBeNull();
      });
    });
  });

});
