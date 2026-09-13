import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PlanningModeModal } from "../PlanningModeModal";
import { mockFetchAiSession, mockFetchAiSessions, mockSummary, mockTasks } from "./PlanningModeModal.test-helpers";

const mockViewportMode = vi.hoisted(() => vi.fn(() => "desktop" as "desktop" | "tablet" | "mobile"));
const mockConnectPlanningStream = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useViewportMode", () => ({ MOBILE_MEDIA_QUERY: "(max-width: 768px)", isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => mockViewportMode(), isMobileViewport: () => mockViewportMode() === "mobile", useViewportMode: () => mockViewportMode() }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));
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

function renderPlanning() {
  return render(
    <PlanningModeModal
      isOpen
      onClose={vi.fn()}
      onTaskCreated={vi.fn()}
      onTasksCreated={vi.fn()}
      tasks={mockTasks}
      projectId="project-1"
      resumeSessionId="session-1"
      presentation="embedded"
    />,
  );
}

/*
FNXC:PlanningKeepAlive 2026-09-12-05:41:
Planning Mode keeps the desktop/tablet session list permanently beside the always-mounted detail pane, while mobile list/detail flips remain CSS-class transitions. Re-selecting the active session on either surface must preserve the interview and avoid another session load.
*/
describe("PlanningModeModal internal transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockViewportMode.mockReturnValue("desktop");
    mockFetchAiSessions.mockResolvedValue([
      { id: "session-1", type: "planning", status: "awaiting_input", title: "Kept-alive plan", projectId: "project-1", updatedAt: base.updatedAt, archived: false },
    ]);
    mockFetchAiSession.mockResolvedValue(awaitingQuestionSession);
  });

  it("keeps the desktop sidebar and interview mounted when re-selecting the active session", async () => {
    renderPlanning();
    expect(await screen.findByTestId("planning-question-text")).toHaveTextContent("What is the scope?");
    const sidebar = screen.getByRole("complementary", { name: "Planning sessions" });
    const sessionLoads = mockFetchAiSession.mock.calls.length;

    expect(screen.queryByRole("button", { name: "Back to sessions" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Kept-alive plan/ }));
    expect(screen.getByRole("complementary", { name: "Planning sessions" })).toBe(sidebar);
    expect(screen.getByTestId("planning-question-text")).toHaveTextContent("What is the scope?");
    expect(mockFetchAiSession.mock.calls.length).toBe(sessionLoads);
  });

  it("keeps the detail pane mounted across a mobile list/detail flip round-trip", async () => {
    mockViewportMode.mockReturnValue("mobile");
    renderPlanning();
    expect(await screen.findByTestId("planning-question-text")).toHaveTextContent("What is the scope?");
    const sessionLoads = mockFetchAiSession.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    expect(screen.getByTestId("planning-question-text")).toHaveTextContent("What is the scope?");

    fireEvent.click(screen.getByRole("button", { name: /Kept-alive plan/ }));
    expect(screen.getByTestId("planning-question-text")).toHaveTextContent("What is the scope?");
    expect(mockFetchAiSession.mock.calls.length).toBe(sessionLoads);
  });
});
