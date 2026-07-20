import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlanningModeModal } from "../PlanningModeModal";
import { mockFetchAiSession, mockFetchAiSessions, mockRespondToPlanning, mockValidatePlanningSession, mockCreateTaskFromPlanning, mockTasks, mockSummary } from "./PlanningModeModal.test-helpers";

vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useViewportMode", () => ({ MOBILE_MEDIA_QUERY: "(max-width: 768px)", isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => "desktop", isMobileViewport: () => false, useViewportMode: () => "desktop" }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../../api", () => {
  const fn = vi.fn;
  return {
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args), fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    respondToPlanning: (...args: unknown[]) => mockRespondToPlanning(...args), validatePlanningSession: (...args: unknown[]) => mockValidatePlanningSession(...args), createTaskFromPlanning: (...args: unknown[]) => mockCreateTaskFromPlanning(...args),
    fetchSettings: fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }), fetchGlobalSettings: fn().mockResolvedValue({}), fetchModels: fn().mockResolvedValue([]), fetchWorkflowSteps: fn().mockResolvedValue([]), fetchBoardWorkflows: fn().mockResolvedValue({ workflows: [] }),
    startPlanning: fn(), startPlanningStreaming: fn(), createPlanningDraft: fn(), connectPlanningStream: fn(), rewindPlanningSession: fn(), retryPlanningSession: fn(), cancelPlanning: fn(), stopPlanningGeneration: fn(), updatePlanningSessionDraft: fn(), updatePlanningSessionTitle: fn(), startPlanningBreakdown: fn(), createTasksFromPlanning: fn(), parseConversationHistory: () => [], acquireSessionLock: fn(), releaseSessionLock: fn(), forceAcquireSessionLock: fn(), uploadAttachment: fn(), deleteAttachment: fn(), updateTask: fn(), pauseTask: fn(), unpauseTask: fn(), fetchTaskDetail: fn(), requestSpecRevision: fn(), approvePlan: fn(), rejectPlan: fn(), refineTask: fn(), deleteAiSession: fn(), refineText: fn(), getRefineErrorMessage: (error: Error) => error.message,
  };
});

const base = { id: "session-1", title: "Secure plan", projectId: "project-1", updatedAt: new Date().toISOString(), archived: false, conversationHistory: "[]", thinkingOutput: "" };
function renderSession(session: Record<string, unknown>) { return render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" resumeSessionId="session-1" />); }

describe("PlanningModeModal sequential flow", () => {
  beforeEach(() => { vi.clearAllMocks(); mockFetchAiSessions.mockResolvedValue([]); mockValidatePlanningSession.mockResolvedValue({ summary: mockSummary, validated: true }); mockCreateTaskFromPlanning.mockResolvedValue({ id: "FN-8442" }); });
  it("renders plan review after an answered turn without retired interview panes", async () => {
    mockFetchAiSession.mockResolvedValue({ ...base, status: "awaiting_input", currentQuestion: null, result: JSON.stringify(mockSummary), inputPayload: JSON.stringify({ initialPlan: "Secure accounts" }) });
    renderSession({});
    expect(await screen.findByTestId("planning-plan-review")).toHaveTextContent("Build authentication system");
    expect(screen.getByTestId("planning-refine-focus")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refine" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sessions" })).toBeInTheDocument();
    expect(document.querySelector(".planning-running-plan")).toBeNull();
    expect(document.querySelector(".planning-answered-history")).toBeNull();
  });
  it("sends trimmed focus only when Refine requests the next question", async () => {
    mockFetchAiSession.mockResolvedValue({ ...base, status: "awaiting_input", currentQuestion: null, result: JSON.stringify(mockSummary), inputPayload: "{}" });
    mockRespondToPlanning.mockResolvedValue({}); renderSession({});
    fireEvent.change(await screen.findByTestId("planning-refine-focus"), { target: { value: " security " } });
    fireEvent.click(screen.getByRole("button", { name: "Refine" }));
    await waitFor(() => expect(mockRespondToPlanning).toHaveBeenCalledWith("session-1", { refine: true, focus: "security" }, "project-1"));
  });
  it("restores a validated unlinked session to create-only retry", async () => {
    mockFetchAiSession.mockResolvedValue({ ...base, status: "complete", currentQuestion: null, result: JSON.stringify(mockSummary), inputPayload: JSON.stringify({ validated: true }) });
    renderSession({});
    expect(await screen.findByTestId("planning-create-retry")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Validate" })).toBeNull();
  });
});
