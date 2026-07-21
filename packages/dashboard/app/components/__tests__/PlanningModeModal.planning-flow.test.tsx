import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlanningModeModal } from "../PlanningModeModal";
import { mockCreatePlanningDraft, mockFetchAiSession, mockFetchAiSessions, mockRespondToPlanning, mockStartPlanningStreaming, mockValidatePlanningSession, mockCreateTaskFromPlanning, mockTasks, mockSummary } from "./PlanningModeModal.test-helpers";

const mockViewportMode = vi.hoisted(() => vi.fn(() => "desktop" as "desktop" | "mobile"));

vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useViewportMode", () => ({ MOBILE_MEDIA_QUERY: "(max-width: 768px)", isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => mockViewportMode(), isMobileViewport: () => mockViewportMode() === "mobile", useViewportMode: () => mockViewportMode() }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../../api", () => {
  const fn = vi.fn;
  return {
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args), fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    respondToPlanning: (...args: unknown[]) => mockRespondToPlanning(...args), validatePlanningSession: (...args: unknown[]) => mockValidatePlanningSession(...args), createTaskFromPlanning: (...args: unknown[]) => mockCreateTaskFromPlanning(...args),
    fetchSettings: fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }), fetchGlobalSettings: fn().mockResolvedValue({}), fetchModels: fn().mockResolvedValue([]), fetchWorkflowSteps: fn().mockResolvedValue([]), fetchBoardWorkflows: fn().mockResolvedValue({ workflows: [] }),
    startPlanning: fn(), startPlanningStreaming: (...args: unknown[]) => mockStartPlanningStreaming(...args), createPlanningDraft: (...args: unknown[]) => mockCreatePlanningDraft(...args), connectPlanningStream: fn(), rewindPlanningSession: fn(), retryPlanningSession: fn(), cancelPlanning: fn(), stopPlanningGeneration: fn(), updatePlanningSessionDraft: fn(), updatePlanningSessionTitle: fn(), startPlanningBreakdown: fn(), createTasksFromPlanning: fn(), parseConversationHistory: () => [], acquireSessionLock: fn(), releaseSessionLock: fn(), forceAcquireSessionLock: fn(), uploadAttachment: fn(), deleteAttachment: fn(), updateTask: fn(), pauseTask: fn(), unpauseTask: fn(), fetchTaskDetail: fn(), requestSpecRevision: fn(), approvePlan: fn(), rejectPlan: fn(), refineTask: fn(), deleteAiSession: fn(), refineText: fn(), getRefineErrorMessage: (error: Error) => error.message,
  };
});

const base = { id: "session-1", title: "Secure plan", projectId: "project-1", updatedAt: new Date().toISOString(), archived: false, conversationHistory: "[]", thinkingOutput: "" };
function renderSession(session: Record<string, unknown>) { return render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" resumeSessionId="session-1" />); }
const summaryWithRefinements = {
  ...mockSummary,
  description: "Build a **reviewed** recovery workflow with an operator [runbook](https://example.com/runbook).",
  proposedChanges: ["Change the authentication API", "Add durable session recovery"],
  acceptanceCriteria: ["Refresh preserves generation", "The plan is reviewable before questions"],
  suggestedRefinements: ["Security boundaries", "Rollout strategy", "Failure recovery", "Accessibility", "Observability"],
};

describe("PlanningModeModal sequential flow", () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); mockViewportMode.mockReturnValue("desktop"); mockFetchAiSessions.mockResolvedValue([]); mockCreatePlanningDraft.mockResolvedValue({ sessionId: "draft-1", title: "Secure plan" }); mockStartPlanningStreaming.mockResolvedValue({ sessionId: "draft-1" }); mockValidatePlanningSession.mockResolvedValue({ summary: mockSummary, validated: true }); mockCreateTaskFromPlanning.mockResolvedValue({ id: "FN-8442" }); });
  it("persists a draft before generation and immediately shows initial-plan progress", async () => {
    render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" />);
    fireEvent.change(screen.getByLabelText("What do you want to build?"), { target: { value: "Build secure accounts" } });
    fireEvent.click(screen.getByRole("button", { name: "Start Planning" }));
    expect(screen.getByText("Generating initial plan…")).toBeInTheDocument();
    await waitFor(() => expect(mockCreatePlanningDraft).toHaveBeenCalledWith("Build secure accounts", "project-1", undefined));
    await waitFor(() => expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build secure accounts", "project-1", undefined, { clarificationEnabled: true }, "draft-1"));
    expect(localStorage.getItem("kb:project-1:kb-planning-active-session")).toBe("draft-1");
  });
  it("renders plan review after an answered turn without retired interview panes", async () => {
    mockFetchAiSession.mockResolvedValue({ ...base, status: "awaiting_input", currentQuestion: null, result: JSON.stringify(summaryWithRefinements), inputPayload: JSON.stringify({ initialPlan: "Secure accounts" }) });
    renderSession({});
    const planReview = await screen.findByTestId("planning-plan-review");
    expect(planReview).toHaveTextContent("Build authentication system");
    expect(screen.getByTestId("planning-plan-markdown").querySelector("h1")).toHaveTextContent("Build authentication system");
    expect(screen.getByTestId("planning-plan-markdown").querySelector("strong")).toHaveTextContent("reviewed");
    expect(screen.getByRole("link", { name: "runbook" })).toHaveAttribute("href", "https://example.com/runbook");
    expect(screen.getByText("What to change")).toBeInTheDocument();
    expect(screen.getByText("Change the authentication API")).toBeInTheDocument();
    expect(screen.getByText("Acceptance criteria")).toBeInTheDocument();
    expect(screen.getByText("Refresh preserves generation")).toBeInTheDocument();
    expect(screen.queryByTestId("planning-refine-menu")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Security boundaries" })).toBeNull();
    expect(screen.getByRole("button", { name: "Refine" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Proceed with plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sessions" })).toBeInTheDocument();
    const scrollRegion = screen.getByTestId("planning-plan-scroll");
    const actionBar = screen.getByTestId("planning-plan-actions");
    expect(scrollRegion).not.toContainElement(actionBar);
    expect(planReview).toContainElement(actionBar);
    expect(document.querySelector(".planning-running-plan")).toBeNull();
    expect(document.querySelector(".planning-answered-history")).toBeNull();
  });
  it("opens a multi-select refinement menu and sends every selected or custom focus", async () => {
    mockFetchAiSession.mockResolvedValue({ ...base, status: "awaiting_input", currentQuestion: null, result: JSON.stringify(summaryWithRefinements), inputPayload: "{}" });
    mockRespondToPlanning.mockResolvedValue({
      sessionId: "session-1",
      currentQuestion: {
        id: "q-refine",
        type: "single_select",
        question: "Which migration risk should come first?",
        options: [
          { id: "data", label: "Data integrity" },
          { id: "rollout", label: "Rollout safety" },
        ],
      },
      summary: summaryWithRefinements,
    });
    renderSession({});
    fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
    expect(screen.getByRole("dialog", { name: "Choose areas to refine" })).toBeInTheDocument();
    expect(screen.getByText("What should the next question focus on?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Security boundaries" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Observability" }));
    fireEvent.change(screen.getByLabelText("Or describe another focus"), { target: { value: "Migration sequencing" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask next question" }));
    await waitFor(() => expect(mockRespondToPlanning).toHaveBeenCalledWith("session-1", { refine: true, focus: "Security boundaries, Observability, Migration sequencing" }, "project-1"));
    expect(await screen.findByText("Which migration risk should come first?")).toBeInTheDocument();
  });
  it("restores the updating-plan progress state after refresh", async () => {
    mockFetchAiSession.mockResolvedValue({ ...base, status: "generating", currentQuestion: null, result: JSON.stringify(summaryWithRefinements), inputPayload: JSON.stringify({ generationPurpose: "plan_update" }) });
    renderSession({});
    expect(await screen.findByText("Updating plan…")).toBeInTheDocument();
  });
  it("renders exactly one write-your-own choice for normalized select questions", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({
        id: "q-1",
        type: "single_select",
        question: "What should come next?",
        options: [
          { id: "security", label: "Security" },
          { id: "rollout", label: "Rollout" },
          { id: "other", label: "Other (write your own)", isOther: true },
        ],
      }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    renderSession({});
    expect(await screen.findByText("What should come next?")).toBeInTheDocument();
    expect(screen.getAllByText("Other (write your own)")).toHaveLength(1);
  });
  it("keeps detailed plan review and refinement choices available on mobile", async () => {
    mockViewportMode.mockReturnValue("mobile");
    mockFetchAiSession.mockResolvedValue({ ...base, status: "awaiting_input", currentQuestion: null, result: JSON.stringify(summaryWithRefinements), inputPayload: "{}" });
    renderSession({});
    expect(await screen.findByText("What to change")).toBeInTheDocument();
    expect(screen.getByText("Acceptance criteria")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Security boundaries" })).toBeNull();
    const actionBar = screen.getByTestId("planning-plan-actions");
    expect(screen.getByTestId("planning-plan-scroll")).not.toContainElement(actionBar);
    expect(actionBar).toContainElement(screen.getByRole("button", { name: "Refine" }));
    expect(actionBar).toContainElement(screen.getByRole("button", { name: "Proceed with plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Refine" }));
    expect(screen.getByRole("dialog", { name: "Choose areas to refine" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Security boundaries" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Observability" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose areas to refine" })).toBeNull();
    expect(screen.getByTestId("planning-plan-review")).toBeInTheDocument();
  });
  it("restores a validated unlinked session to create-only retry", async () => {
    mockFetchAiSession.mockResolvedValue({ ...base, status: "complete", currentQuestion: null, result: JSON.stringify(mockSummary), inputPayload: JSON.stringify({ validated: true }) });
    renderSession({});
    expect(await screen.findByTestId("planning-create-retry")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Proceed with plan" })).toBeNull();
  });
});
