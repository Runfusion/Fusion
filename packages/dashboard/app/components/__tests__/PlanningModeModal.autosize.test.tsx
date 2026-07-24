import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { PlanningModeModal } from "../PlanningModeModal";
import {
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
  mockFetchAiSessions,
  mockConfirm,
  mockUseViewportMode,
  mockUseMobileKeyboard,
  mockTasks,
  mockModels,
  mockSummary,
} from "./PlanningModeModal.test-helpers";

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

vi.mock("../../api", () => ({
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
  fetchSettings: vi.fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
  /*
  FNXC:PlanningModeSettings 2026-07-18-10:50:
  Product mounts fetchGlobalSettings for clarification gating. Without this export
  the suite fails at render (full-suite shard 4). Sync-settle like planning-flow
  so Start Planning is not blocked by a microtask.
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
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
  duplicateTask: vi.fn().mockResolvedValue({}),
  fetchAiSessions: (...args: any[]) => mockFetchAiSessions(...args),
  archiveAiSession: vi.fn(),
  unarchiveAiSession: vi.fn(),
  deleteAiSession: vi.fn(),
  summarizePlanningDraftTitle: vi.fn().mockResolvedValue({ title: "Draft" }),
  fetchModelsWithFallback: vi.fn(),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
  useViewportMode: () => mockUseViewportMode(),
  getViewportMode: () => mockUseViewportMode(),
  isMobileViewport: () => mockUseViewportMode() === "mobile",
}));

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: (...args: any[]) => mockUseMobileKeyboard(...args),
}));

const originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "scrollHeight");

describe("PlanningModeModal autosize", () => {
  afterEach(() => {
    if (originalScrollHeightDescriptor) {
      Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", originalScrollHeightDescriptor);
    } else {
      Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockAddToast.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockStartPlanningStreaming.mockResolvedValue({ sessionId: "session-123" });
    mockCreatePlanningDraft.mockResolvedValue({ sessionId: "draft-123", title: "New planning session" });
    mockRetryPlanningSession.mockResolvedValue({ success: true, sessionId: "session-123" });
    mockValidatePlanningSession.mockResolvedValue({ summary: mockSummary, validated: true });
    mockStartPlanningBreakdown.mockResolvedValue({ sessionId: "session-123", subtasks: [] });
    mockFetchAiSession.mockResolvedValue(null);
    mockFetchAiSessions.mockResolvedValue([]);
    mockParseConversationHistory.mockReturnValue([]);
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
    mockConnectPlanningStream.mockReturnValue({ close: vi.fn(), isConnected: vi.fn().mockReturnValue(true) } as any);
    mockUseViewportMode.mockReturnValue("desktop");
    mockUseMobileKeyboard.mockReturnValue({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false });
  });

  it.each(["modal", "embedded"] as const)("starts planning on the first mobile touch without dismissing the %s surface", async (presentation) => {
    mockUseViewportMode.mockReturnValue("mobile");
    mockUseMobileKeyboard.mockReturnValue({ keyboardOverlap: 320, viewportHeight: 480, viewportOffsetTop: 0, keyboardOpen: true });
    const onClose = vi.fn();
    render(<PlanningModeModal isOpen={true} onClose={onClose} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} presentation={presentation} />);

    fireEvent.change(screen.getByPlaceholderText(/Build a user authentication/i), { target: { value: "Build a mobile-first dashboard" } });
    const startButton = screen.getByRole("button", { name: "Start Planning" });
    fireEvent.pointerDown(startButton, { pointerType: "touch" });

    expect(startButton).toBeInTheDocument();
    expect(mockStartPlanningStreaming).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(startButton);

    await waitFor(() => expect(mockStartPlanningStreaming).toHaveBeenCalledWith(
      "Build a mobile-first dashboard",
      undefined,
      undefined,
      { clarificationEnabled: true },
      "draft-123",
    ));
    expect(screen.getByText("Generating initial plan…")).toBeInTheDocument();
  });

  it("grows initial planning textarea and caps at max", async () => {
    render(<PlanningModeModal isOpen={true} onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} />);

    const textarea = screen.getByPlaceholderText(/Build a user authentication/i) as HTMLTextAreaElement;
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        const value = (this as HTMLTextAreaElement).value;
        if (!value) return 24;
        if (value.includes("line 7")) return 900;
        if (value.includes("line 5")) return 500;
        return 180;
      },
    });

    await userEvent.type(textarea, "line 1\nline 2");
    await waitFor(() => {
      expect(Number.parseInt(textarea.style.height, 10)).toBeGreaterThanOrEqual(120);
      expect(Number.parseInt(textarea.style.height, 10)).toBeLessThanOrEqual(640);
    });

    await userEvent.type(textarea, "\nline 3\nline 4\nline 5");
    await waitFor(() => {
      expect(textarea.style.height).toBe("500px");
    });

    await userEvent.type(textarea, "\nline 6\nline 7");
    await waitFor(() => {
      expect(textarea.style.height).toBe("640px");
    });
  });

  it("resumes a complete session without a created task into the full plan review workspace", async () => {
    /*
    FNXC:PlanningMode 2026-07-24-05:45:
    status=complete is only written by validateSession. A missing inputPayload.validated flag
    must not strand reopen on "still being prepared".

    FNXC:PlanningReopenAfterValidate 2026-07-23-23:30:
    A finished plan with no created task must resume into plan review — readable, still
    editable (the server reopens validated sessions on any new turn), with Proceed available —
    never a create-retry error card or any other do-nothing screen.
    */
    mockFetchAiSession.mockResolvedValueOnce({
      id: "session-complete-1",
      type: "planning",
      status: "complete",
      title: "Resume-ready planning output",
      inputPayload: JSON.stringify({ initialPlan: "Build resilient planning resume" }),
      conversationHistory: "[]",
      currentQuestion: null,
      result: JSON.stringify({
        title: "Resume-ready planning output",
        description: "Recovered summary description from persisted session",
        suggestedSize: "L",
        suggestedDependencies: ["FN-001"],
        keyDeliverables: ["Deliverable A", "Deliverable B"],
      }),
      thinkingOutput: "",
      error: null,
      projectId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    render(
      <PlanningModeModal
        isOpen={true}
        onClose={vi.fn()}
        onTaskCreated={vi.fn()}
        onTasksCreated={vi.fn()}
        tasks={mockTasks}
        resumeSessionId="session-complete-1"
      />
    );

    expect(await screen.findByTestId("planning-plan-review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proceed with plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refine" })).toBeInTheDocument();
    expect(screen.queryByTestId("planning-create-retry")).toBeNull();
    expect(screen.queryByText("This plan is still being prepared")).toBeNull();
  });

  /*
  FNXC:PlanningMultiTask 2026-07-24-00:20:
  A session whose task exists resumes to the editable plan review workspace with a banner
  linking that task — not a terminal handoff — so the plan can evolve into further tasks.
  */
  it("resumes a task-linked complete session to plan review with the linked-task banner", async () => {
    mockFetchAiSession.mockResolvedValueOnce({
      id: "session-complete-linked",
      type: "planning",
      status: "complete",
      title: "Linked planning output",
      inputPayload: JSON.stringify({
        initialPlan: "Build resilient planning resume",
        validated: true,
        createdTaskId: "FN-9001",
      }),
      conversationHistory: "[]",
      currentQuestion: null,
      result: JSON.stringify({
        title: "Linked planning output",
        description: "Recovered summary",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Done"],
      }),
      thinkingOutput: "",
      error: null,
      projectId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    render(
      <PlanningModeModal
        isOpen={true}
        onClose={vi.fn()}
        onTaskCreated={vi.fn()}
        onTasksCreated={vi.fn()}
        tasks={mockTasks}
        resumeSessionId="session-complete-linked"
      />
    );

    expect(await screen.findByTestId("planning-plan-review")).toBeInTheDocument();
    expect(screen.getByTestId("planning-linked-task-note")).toBeInTheDocument();
    expect(screen.getByTestId("planning-linked-task-note").textContent).toContain("FN-9001");
    expect(screen.getByRole("button", { name: "Proceed with plan" })).toBeInTheDocument();
    expect(screen.queryByTestId("planning-create-retry")).toBeNull();
  });
});
