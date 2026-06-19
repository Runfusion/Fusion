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
} from "./PlanningModeModal.test-helpers";

const mockAddToast = vi.fn();

vi.mock("../../hooks/useToast", () => ({
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
  startPlanningBreakdown: (...args: any[]) => mockStartPlanningBreakdown(...args),
  createTasksFromPlanning: (...args: any[]) => mockCreateTasksFromPlanning(...args),
  fetchAiSession: (...args: any[]) => mockFetchAiSession(...args),
  parseConversationHistory: (...args: any[]) => mockParseConversationHistory(...args),
  fetchSettings: vi.fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
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
  useViewportMode: () => mockUseViewportMode(),
  getViewportMode: () => mockUseViewportMode(),
  isMobileViewport: () => mockUseViewportMode() === "mobile",
}));

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: (...args: any[]) => mockUseMobileKeyboard(...args),
}));

vi.mock("../../hooks/useSessionLock", () => ({
  useSessionLock: () => ({ isLockedByOther: false, takeControl: vi.fn(), isLoading: false }),
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
    mockAddToast.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockStartPlanningStreaming.mockResolvedValue({ sessionId: "session-123" });
    mockCreatePlanningDraft.mockResolvedValue({ sessionId: "draft-123", title: "New planning session" });
    mockRetryPlanningSession.mockResolvedValue({ success: true, sessionId: "session-123" });
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

  it("keeps SummaryView collapsed and expanded autosize caps distinct", async () => {
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 900;
      },
    });

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

    const description = await screen.findByDisplayValue("Recovered summary description from persisted session") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(description.style.height).toBe("640px");
    });

    fireEvent.click(screen.getByText("Expand"));
    await waitFor(() => {
      expect(description.style.height).toBe("800px");
    });
  });
});
