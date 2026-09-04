// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanningModeModal, SummaryView, resetPlanningAutoRetryAttemptsForTests } from "../PlanningModeModal";
import {
  mockCreatePlanningDraft,
  mockCreateTaskFromPlanning,
  mockFetchAiSession,
  mockFetchAiSessions,
  mockRespondToPlanning,
  mockRetryPlanningSession,
  mockStartPlanningStreaming,
  mockStopPlanningGeneration,
  mockSummary,
  mockTasks,
  mockValidatePlanningSession,
} from "./PlanningModeModal.test-helpers";

const mockViewportMode = vi.hoisted(() => vi.fn(() => "desktop" as "desktop" | "tablet" | "mobile"));
const mockUpdatePlanningSessionDraft = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useViewportMode", () => ({ MOBILE_MEDIA_QUERY: "(max-width: 768px)", isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => mockViewportMode(), isMobileViewport: () => mockViewportMode() === "mobile", isTabletTouchViewport: (mode?: string) => mode === "tablet", useViewportMode: () => mockViewportMode() }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));
vi.mock("../../api", () => {
  const fn = vi.fn;
  return {
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args), fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    respondToPlanning: (...args: unknown[]) => mockRespondToPlanning(...args), validatePlanningSession: (...args: unknown[]) => mockValidatePlanningSession(...args), createTaskFromPlanning: (...args: unknown[]) => mockCreateTaskFromPlanning(...args),
    fetchSettings: fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }), fetchGlobalSettings: fn().mockResolvedValue({}), fetchModels: fn().mockResolvedValue([]), fetchWorkflowSteps: fn().mockResolvedValue([]), fetchBoardWorkflows: fn().mockResolvedValue({ workflows: [] }),
    startPlanning: fn(), startPlanningStreaming: (...args: unknown[]) => mockStartPlanningStreaming(...args), createPlanningDraft: (...args: unknown[]) => mockCreatePlanningDraft(...args), connectPlanningStream: fn(), rewindPlanningSession: fn(), retryPlanningSession: (...args: unknown[]) => mockRetryPlanningSession(...args), cancelPlanning: fn(), stopPlanningGeneration: (...args: unknown[]) => mockStopPlanningGeneration(...args), updatePlanningSessionDraft: (...args: unknown[]) => mockUpdatePlanningSessionDraft(...args), updatePlanningSessionTitle: fn(), startPlanningBreakdown: fn(), createTasksFromPlanning: fn(), parseConversationHistory: (raw: string) => JSON.parse(raw || "[]"), acquireSessionLock: fn(), releaseSessionLock: fn(), forceAcquireSessionLock: fn(), uploadAttachment: fn(), deleteAttachment: fn(), updateTask: fn(), pauseTask: fn(), unpauseTask: fn(), fetchTaskDetail: fn(), requestSpecRevision: fn(), approvePlan: fn(), rejectPlan: fn(), refineTask: fn(), deleteAiSession: fn(), archiveAiSession: fn(), unarchiveAiSession: fn(), refineText: fn(), getRefineErrorMessage: (error: Error) => error.message,
  };
});

const history = [{
  question: { id: "scope", type: "text", question: "What should change?" },
  response: { scope: "Rework billing" },
}];

const sessionBase = {
  id: "session-1",
  title: "Billing plan",
  projectId: "project-1",
  updatedAt: "2026-08-28T00:00:00.000Z",
  archived: false,
  status: "awaiting_input",
  currentQuestion: JSON.stringify({ id: "next", type: "text", question: "What comes next?" }),
  result: JSON.stringify(mockSummary),
  inputPayload: "{}",
  conversationHistory: JSON.stringify(history),
  thinkingOutput: "",
};

const modalProps = {
  isOpen: true,
  onClose: vi.fn(),
  onTaskCreated: vi.fn(),
  onTasksCreated: vi.fn(),
  tasks: mockTasks,
  projectId: "project-1",
};

function renderSession(sessionId = "session-1") {
  return render(<PlanningModeModal {...modalProps} resumeSessionId={sessionId} />);
}

async function openHistory() {
  fireEvent.click(await screen.findByRole("button", { name: "History" }));
  return screen.findByTestId("planning-history-overlay");
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetPlanningAutoRetryAttemptsForTests();
  mockViewportMode.mockReturnValue("desktop");
  mockFetchAiSessions.mockResolvedValue([]);
  mockCreatePlanningDraft.mockResolvedValue({ sessionId: "draft-1", title: "Billing plan" });
  mockStartPlanningStreaming.mockResolvedValue({ sessionId: "draft-1" });
  mockRetryPlanningSession.mockResolvedValue({ success: true });
  mockStopPlanningGeneration.mockResolvedValue({ success: true });
  mockValidatePlanningSession.mockResolvedValue({ summary: mockSummary, validated: true });
  mockCreateTaskFromPlanning.mockResolvedValue({ id: "FN-210" });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetPlanningAutoRetryAttemptsForTests();
  vi.restoreAllMocks();
});

describe("Planning Mode initiating prompt history", () => {
  it("shows the exact prompt alongside populated desktop history", async () => {
    const prompt = "Rework the billing page\nwith usage tiers";
    mockFetchAiSession.mockResolvedValue({ ...sessionBase, inputPayload: JSON.stringify({ initialPlan: prompt }) });
    renderSession();

    const overlay = within(await openHistory());
    const textarea = overlay.getByTestId("planning-history-initial-prompt");
    expect(textarea).toHaveValue(prompt);
    expect(textarea).toHaveProperty("readOnly", true);
    expect(overlay.getByTestId("conversation-history")).toBeInTheDocument();
  });

  it("shows the prompt together with the empty-history state", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...sessionBase,
      conversationHistory: "[]",
      inputPayload: JSON.stringify({ initialPlan: "Keep the starting idea visible" }),
    });
    renderSession();

    const overlay = within(await openHistory());
    expect(overlay.getByTestId("planning-history-initial-prompt")).toHaveValue("Keep the starting idea visible");
    expect(overlay.getByText("No history yet")).toBeInTheDocument();
  });

  it.each([
    ["an absent prompt", "{}"],
    ["a whitespace-only prompt", JSON.stringify({ initialPlan: "   \n  " })],
  ])("renders no prompt shell for %s", async (_label, inputPayload) => {
    mockFetchAiSession.mockResolvedValue({ ...sessionBase, inputPayload });
    renderSession();

    const overlay = within(await openHistory());
    expect(overlay.queryByTestId("planning-history-initial-prompt")).toBeNull();
    expect(overlay.queryByRole("textbox")).toBeNull();
  });

  it("ignores a malformed payload while preserving Q&A", async () => {
    mockFetchAiSession.mockResolvedValue({ ...sessionBase, inputPayload: "not-json" });
    renderSession();

    const overlay = within(await openHistory());
    expect(overlay.queryByTestId("planning-history-initial-prompt")).toBeNull();
    expect(overlay.queryByRole("textbox")).toBeNull();
    expect(overlay.getByTestId("conversation-history")).toBeInTheDocument();
  });

  it("shows the exact prompt in the mobile history panel", async () => {
    const prompt = "Rework the billing page\nwith usage tiers";
    mockViewportMode.mockReturnValue("mobile");
    mockFetchAiSession.mockResolvedValue({ ...sessionBase, inputPayload: JSON.stringify({ initialPlan: prompt }) });
    renderSession();

    expect(within(await openHistory()).getByTestId("planning-history-initial-prompt")).toHaveValue(prompt);
  });

  it("shows distinct prompt boxes in the error pane and its open history overlay", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...sessionBase,
      status: "error",
      currentQuestion: null,
      error: "The planning stream was interrupted",
      inputPayload: JSON.stringify({ initialPlan: "Recover this idea" }),
    });
    mockRetryPlanningSession.mockRejectedValue(new Error("Retry remains unavailable"));
    renderSession();

    await waitFor(() => expect(mockRetryPlanningSession).toHaveBeenCalledTimes(3));
    const errorPrompt = await screen.findByTestId("planning-error-initial-prompt");
    expect(errorPrompt).toHaveValue("Recover this idea");

    const overlayPrompt = within(await openHistory()).getByTestId("planning-history-initial-prompt");
    expect(overlayPrompt).toHaveValue("Recover this idea");
    expect(screen.getAllByTestId("planning-history-initial-prompt")).toHaveLength(1);
    expect(screen.getAllByTestId("planning-error-initial-prompt")).toHaveLength(1);
    expect(overlayPrompt).not.toBe(errorPrompt);
  });

  it("clears the prior prompt when switching sessions", async () => {
    const sessions = new Map([
      ["session-a", { ...sessionBase, id: "session-a", title: "Session A", inputPayload: JSON.stringify({ initialPlan: "Prompt A" }) }],
      ["session-b-empty", { ...sessionBase, id: "session-b-empty", title: "Session B empty", inputPayload: "{}" }],
      ["session-b-prompt", { ...sessionBase, id: "session-b-prompt", title: "Session B prompt", inputPayload: JSON.stringify({ initialPlan: "Prompt B" }) }],
    ]);
    mockFetchAiSession.mockImplementation((sessionId: string) => Promise.resolve(sessions.get(sessionId)));

    const view = renderSession("session-a");
    expect(within(await openHistory()).getByTestId("planning-history-initial-prompt")).toHaveValue("Prompt A");
    fireEvent.click(screen.getByRole("button", { name: "Close history" }));

    view.rerender(<PlanningModeModal {...modalProps} resumeSessionId="session-b-empty" />);
    await screen.findByText("Session B empty");
    expect(within(await openHistory()).queryByTestId("planning-history-initial-prompt")).toBeNull();
    expect(screen.queryByText("Prompt A")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close history" }));

    view.rerender(<PlanningModeModal {...modalProps} resumeSessionId="session-b-prompt" />);
    await screen.findByText("Session B prompt");
    expect(within(await openHistory()).getByTestId("planning-history-initial-prompt")).toHaveValue("Prompt B");
    expect(screen.queryByText("Prompt A")).toBeNull();
  });

  it("clears the prior prompt while a different session is still loading", async () => {
    const sessionA = {
      ...sessionBase,
      id: "session-a",
      title: "Session A",
      inputPayload: JSON.stringify({ initialPlan: "Prompt A" }),
    };
    const sessionB = {
      ...sessionBase,
      id: "session-b",
      title: "Session B",
      inputPayload: JSON.stringify({ initialPlan: "Prompt B" }),
    };
    let resolveSessionB!: (session: typeof sessionB) => void;
    const deferredSessionB = new Promise<typeof sessionB>((resolve) => {
      resolveSessionB = resolve;
    });
    mockFetchAiSession.mockImplementation((sessionId: string) => (
      sessionId === "session-a" ? Promise.resolve(sessionA) : deferredSessionB
    ));

    const view = renderSession("session-a");
    const overlay = within(await openHistory());
    expect(overlay.getByTestId("planning-history-initial-prompt")).toHaveValue("Prompt A");

    view.rerender(<PlanningModeModal {...modalProps} resumeSessionId="session-b" />);

    await waitFor(() => expect(mockFetchAiSession).toHaveBeenCalledWith("session-b"));
    await waitFor(() => {
      expect(overlay.queryByTestId("planning-history-initial-prompt")).toBeNull();
      expect(overlay.queryByDisplayValue("Prompt A")).toBeNull();
    });

    resolveSessionB(sessionB);
    expect(await overlay.findByTestId("planning-history-initial-prompt")).toHaveValue("Prompt B");
  });

  it("does not mutate the prompt or planning draft", async () => {
    const user = userEvent.setup();
    const prompt = "Rework the billing page\nwith usage tiers";
    mockFetchAiSession.mockResolvedValue({ ...sessionBase, inputPayload: JSON.stringify({ initialPlan: prompt }) });
    renderSession();

    const textarea = within(await openHistory()).getByTestId("planning-history-initial-prompt");
    await user.type(textarea, "edit");

    expect(textarea).toHaveValue(prompt);
    expect(mockUpdatePlanningSessionDraft).not.toHaveBeenCalled();
  });

  it("shows the prompt alongside Q&A in the summary disclosure and omits a blank prompt", async () => {
    const user = userEvent.setup();
    const summaryProps = {
      projectId: "project-1",
      summary: mockSummary,
      historyEntries: history,
      onSummaryChange: vi.fn(),
      tasks: [],
      branchMode: "project-default" as const,
      branchName: "",
      baseBranch: "main",
      onBranchModeChange: vi.fn(),
      onBranchNameChange: vi.fn(),
      onBaseBranchChange: vi.fn(),
      onCreateTask: vi.fn(),
      isCreatingTask: false,
      isRefiningSummary: false,
    };
    const view = render(<SummaryView {...summaryProps} initialPrompt="Summary-stage prompt" />);

    await user.click(screen.getByRole("button", { name: "Show user Q&A" }));
    expect(screen.getByTestId("planning-summary-initial-prompt")).toHaveValue("Summary-stage prompt");
    expect(screen.getByTestId("conversation-history")).toBeInTheDocument();

    view.unmount();
    render(<SummaryView {...summaryProps} />);
    await user.click(screen.getByRole("button", { name: "Show user Q&A" }));
    expect(screen.queryByTestId("planning-summary-initial-prompt")).toBeNull();
  });
});
