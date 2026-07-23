import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { PlanningModeModal } from "../PlanningModeModal";
import { clearResumeEvents, getResumeEvents } from "../../utils/resumeInstrumentation";
import { mockFetchAiSession, mockFetchAiSessions, mockSummary, mockTasks } from "./PlanningModeModal.test-helpers";

const mockViewportMode = vi.hoisted(() => vi.fn(() => "desktop" as "desktop" | "tablet" | "mobile"));
const mockConnectPlanningStream = vi.hoisted(() => vi.fn());
const mockSseState = vi.hoisted(() => ({ subscribeCalls: 0, unsubscribeCalls: 0 }));

vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useViewportMode", () => ({ MOBILE_MEDIA_QUERY: "(max-width: 768px)", isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => mockViewportMode(), isMobileViewport: () => mockViewportMode() === "mobile", useViewportMode: () => mockViewportMode() }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => {
    mockSseState.subscribeCalls += 1;
    return () => {
      mockSseState.unsubscribeCalls += 1;
    };
  }),
}));
vi.mock("../../api", () => {
  const fn = vi.fn;
  return {
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args), fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    respondToPlanning: fn(), validatePlanningSession: fn(), createTaskFromPlanning: fn(),
    fetchSettings: fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }), fetchGlobalSettings: fn().mockResolvedValue({}), fetchModels: fn().mockResolvedValue([]), fetchWorkflowSteps: fn().mockResolvedValue([]), fetchBoardWorkflows: fn().mockResolvedValue({ workflows: [] }),
    startPlanning: fn(), startPlanningStreaming: fn(), createPlanningDraft: fn(), connectPlanningStream: (...args: unknown[]) => mockConnectPlanningStream(...args), rewindPlanningSession: fn(), retryPlanningSession: fn().mockResolvedValue({ success: true }), cancelPlanning: fn(), stopPlanningGeneration: fn(), updatePlanningSessionDraft: fn(), updatePlanningSessionTitle: fn(), startPlanningBreakdown: fn(), createTasksFromPlanning: fn(), parseConversationHistory: (raw: string) => JSON.parse(raw || "[]"), acquireSessionLock: fn(), releaseSessionLock: fn(), forceAcquireSessionLock: fn(), uploadAttachment: fn(), deleteAttachment: fn(), updateTask: fn(), pauseTask: fn(), unpauseTask: fn(), fetchTaskDetail: fn(), requestSpecRevision: fn(), approvePlan: fn(), rejectPlan: fn(), refineTask: fn(), deleteAiSession: fn(), refineText: fn(), getRefineErrorMessage: (error: Error) => error.message,
  };
});

const base = { id: "session-1", title: "Kept-alive plan", projectId: "project-1", updatedAt: new Date().toISOString(), archived: false, conversationHistory: "[]", thinkingOutput: "" };

const awaitingQuestionSession = {
  ...base,
  status: "awaiting_input",
  currentQuestion: JSON.stringify({
    id: "q-scope",
    type: "single_select",
    question: "What is the scope?",
    options: [{ id: "small", label: "Small" }, { id: "large", label: "Large" }],
  }),
  result: JSON.stringify(mockSummary),
  inputPayload: "{}",
};

function planningProps(active: boolean) {
  return {
    isOpen: true,
    active,
    onClose: vi.fn(),
    onTaskCreated: vi.fn(),
    onTasksCreated: vi.fn(),
    tasks: mockTasks,
    projectId: "project-1",
    resumeSessionId: "session-1",
    presentation: "embedded" as const,
  };
}

/*
FNXC:PlanningKeepAlive 2026-07-22-12:35:
FN remount-churn fix R5/R8: the kept-alive embedded Planning view must suspend its background work while hidden (session-list SSE closed, recovery poll idle) and restore instantly on reveal — same instance, no session reload, resume instrumentation recording route-active rather than a second remount.
*/
describe("PlanningModeModal keep-alive gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    clearResumeEvents();
    mockSseState.subscribeCalls = 0;
    mockSseState.unsubscribeCalls = 0;
    mockViewportMode.mockReturnValue("desktop");
    mockFetchAiSessions.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes the session-list SSE while hidden, then re-subscribes and refreshes the list on reveal", async () => {
    mockFetchAiSession.mockResolvedValue(awaitingQuestionSession);

    const { rerender } = render(<PlanningModeModal {...planningProps(true)} />);
    await waitFor(() => expect(mockSseState.subscribeCalls).toBeGreaterThanOrEqual(1));
    const subscribedWhileVisible = mockSseState.subscribeCalls;
    const listRefreshesWhileVisible = mockFetchAiSessions.mock.calls.length;

    rerender(<PlanningModeModal {...planningProps(false)} />);
    await waitFor(() => expect(mockSseState.unsubscribeCalls).toBe(subscribedWhileVisible));
    expect(mockSseState.subscribeCalls).toBe(subscribedWhileVisible);

    rerender(<PlanningModeModal {...planningProps(true)} />);
    await waitFor(() => expect(mockSseState.subscribeCalls).toBe(subscribedWhileVisible + 1));
    // Reveal refreshes the sessions list once so events dropped while hidden cannot leave stale rows.
    await waitFor(() => expect(mockFetchAiSessions.mock.calls.length).toBe(listRefreshesWhileVisible + 1));
  });

  it("preserves the in-flight interview across hide/reveal without reloading the session", async () => {
    mockFetchAiSession.mockResolvedValue(awaitingQuestionSession);

    const { rerender } = render(<PlanningModeModal {...planningProps(true)} />);
    expect(await screen.findByTestId("planning-question-text")).toHaveTextContent("What is the scope?");
    const sessionLoads = mockFetchAiSession.mock.calls.length;

    rerender(<PlanningModeModal {...planningProps(false)} />);
    rerender(<PlanningModeModal {...planningProps(true)} />);

    // Same instance, same ViewState — no reload flash, no re-fetch of the session.
    expect(screen.getByTestId("planning-question-text")).toHaveTextContent("What is the scope?");
    expect(mockFetchAiSession.mock.calls.length).toBe(sessionLoads);
  });

  it("suspends the loading-state recovery poll while hidden and re-arms it on reveal", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "generating",
      currentQuestion: null,
      result: null,
      inputPayload: JSON.stringify({ generationPurpose: "plan_update" }),
    });

    const { rerender } = render(<PlanningModeModal {...planningProps(true)} />);
    await waitFor(() => expect(mockConnectPlanningStream).toHaveBeenCalledTimes(1));
    const loadsBeforeHide = mockFetchAiSession.mock.calls.length;

    vi.useFakeTimers();
    rerender(<PlanningModeModal {...planningProps(false)} />);
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(mockFetchAiSession.mock.calls.length).toBe(loadsBeforeHide);

    rerender(<PlanningModeModal {...planningProps(true)} />);
    await act(async () => {
      vi.advanceTimersByTime(9_000);
    });
    expect(mockFetchAiSession.mock.calls.length).toBeGreaterThan(loadsBeforeHide);
  });

  it("records remount on first activation and route-active (not remount) on keep-alive reveal", async () => {
    mockFetchAiSession.mockResolvedValue(awaitingQuestionSession);

    const { rerender } = render(<PlanningModeModal {...planningProps(true)} />);
    expect(await screen.findByTestId("planning-question-text")).toHaveTextContent("What is the scope?");

    const planningTriggers = () => getResumeEvents().filter((event) => event.view === "PlanningMode").map((event) => event.trigger);
    expect(planningTriggers()).toEqual(["remount"]);

    rerender(<PlanningModeModal {...planningProps(false)} />);
    expect(planningTriggers()).toEqual(["remount", "route-inactive"]);

    rerender(<PlanningModeModal {...planningProps(true)} />);
    expect(planningTriggers()).toEqual(["remount", "route-inactive", "route-active"]);
  });
});
