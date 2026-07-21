import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlanningModeModal } from "../PlanningModeModal";
import { mockCreatePlanningDraft, mockFetchAiSession, mockFetchAiSessions, mockRespondToPlanning, mockStartPlanningStreaming, mockValidatePlanningSession, mockCreateTaskFromPlanning, mockTasks, mockSummary } from "./PlanningModeModal.test-helpers";

const mockViewportMode = vi.hoisted(() => vi.fn(() => "desktop" as "desktop" | "mobile"));
const mockConnectPlanningStream = vi.hoisted(() => vi.fn());
const mockPlanningSse = vi.hoisted(() => ({ events: null as Record<string, (event: MessageEvent) => void> | null }));

vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useViewportMode", () => ({ MOBILE_MEDIA_QUERY: "(max-width: 768px)", isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => mockViewportMode(), isMobileViewport: () => mockViewportMode() === "mobile", useViewportMode: () => mockViewportMode() }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, options: { events: Record<string, (event: MessageEvent) => void> }) => {
    mockPlanningSse.events = options.events;
    return () => undefined;
  }),
}));
vi.mock("../../api", () => {
  const fn = vi.fn;
  return {
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args), fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    respondToPlanning: (...args: unknown[]) => mockRespondToPlanning(...args), validatePlanningSession: (...args: unknown[]) => mockValidatePlanningSession(...args), createTaskFromPlanning: (...args: unknown[]) => mockCreateTaskFromPlanning(...args),
    fetchSettings: fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }), fetchGlobalSettings: fn().mockResolvedValue({}), fetchModels: fn().mockResolvedValue([]), fetchWorkflowSteps: fn().mockResolvedValue([]), fetchBoardWorkflows: fn().mockResolvedValue({ workflows: [] }),
    startPlanning: fn(), startPlanningStreaming: (...args: unknown[]) => mockStartPlanningStreaming(...args), createPlanningDraft: (...args: unknown[]) => mockCreatePlanningDraft(...args), connectPlanningStream: (...args: unknown[]) => mockConnectPlanningStream(...args), rewindPlanningSession: fn(), retryPlanningSession: fn(), cancelPlanning: fn(), stopPlanningGeneration: fn(), updatePlanningSessionDraft: fn(), updatePlanningSessionTitle: fn(), startPlanningBreakdown: fn(), createTasksFromPlanning: fn(), parseConversationHistory: (raw: string) => JSON.parse(raw || "[]"), acquireSessionLock: fn(), releaseSessionLock: fn(), forceAcquireSessionLock: fn(), uploadAttachment: fn(), deleteAttachment: fn(), updateTask: fn(), pauseTask: fn(), unpauseTask: fn(), fetchTaskDetail: fn(), requestSpecRevision: fn(), approvePlan: fn(), rejectPlan: fn(), refineTask: fn(), deleteAiSession: fn(), refineText: fn(), getRefineErrorMessage: (error: Error) => error.message,
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
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); mockPlanningSse.events = null; mockViewportMode.mockReturnValue("desktop"); mockFetchAiSessions.mockResolvedValue([]); mockCreatePlanningDraft.mockResolvedValue({ sessionId: "draft-1", title: "Secure plan" }); mockStartPlanningStreaming.mockResolvedValue({ sessionId: "draft-1" }); mockValidatePlanningSession.mockResolvedValue({ summary: mockSummary, validated: true }); mockCreateTaskFromPlanning.mockResolvedValue({ id: "FN-8442" }); });
  it("persists a draft before generation and immediately shows initial-plan progress", async () => {
    render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" />);
    fireEvent.change(screen.getByLabelText("What do you want to build?"), { target: { value: "Build secure accounts" } });
    fireEvent.click(screen.getByRole("button", { name: "Start Planning" }));
    expect(screen.getByText("Generating initial plan…")).toBeInTheDocument();
    await waitFor(() => expect(mockCreatePlanningDraft).toHaveBeenCalledWith("Build secure accounts", "project-1", undefined));
    await waitFor(() => expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build secure accounts", "project-1", undefined, { clarificationEnabled: true }, "draft-1"));
    expect(localStorage.getItem("kb:project-1:kb-planning-active-session")).toBe("draft-1");
  });
  it("keeps the plan visible beside the active question", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-1", type: "single_select", question: "Which outcome matters most?", options: [{ id: "secure", label: "Secure defaults" }, { id: "fast", label: "Fast delivery" }] }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: JSON.stringify({ initialPlan: "Secure accounts" }),
    });
    renderSession({});
    const workspace = await screen.findByTestId("planning-workspace");
    expect(workspace).toHaveTextContent("Build authentication system");
    expect(workspace).toHaveTextContent("Which outcome matters most?");
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
    expect(screen.getByTestId("planning-plan-pane")).toContainElement(actionBar);
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    expect(document.querySelector(".planning-answered-history")).toBeNull();
    expect(mockConnectPlanningStream).not.toHaveBeenCalled();
  });

  it("rehydrates a restored idle session when another tab advances its question", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-old", type: "text", question: "Old question?" }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    renderSession({});
    expect(await screen.findByText("Old question?")).toBeInTheDocument();

    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
      currentQuestion: JSON.stringify({ id: "q-new", type: "text", question: "New question?" }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    mockPlanningSse.events?.["ai_session:updated"]?.(new MessageEvent("ai_session:updated", {
      data: JSON.stringify({ ...base, type: "planning", status: "awaiting_input" }),
    }));

    expect(await screen.findByText("New question?")).toBeInTheDocument();
    expect(screen.queryByText("Old question?")).toBeNull();
    expect(mockConnectPlanningStream).not.toHaveBeenCalled();
  });

  it("opens question, answer, and collapsed AI reasoning history beside Sessions", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-current", type: "text", question: "What should happen next?" }),
      result: JSON.stringify(summaryWithRefinements),
      conversationHistory: JSON.stringify([{
        question: {
          id: "q-history",
          type: "single_select",
          question: "Which outcome matters most?",
          options: [{ id: "secure", label: "Secure defaults" }],
        },
        response: { "q-history": "secure" },
        thinkingOutput: "I updated the plan to prioritize secure defaults.",
      }]),
      inputPayload: "{}",
    });
    renderSession({});

    const sessionsButton = await screen.findByRole("button", { name: "Sessions" });
    const historyButton = screen.getByRole("button", { name: "History" });
    expect(sessionsButton.parentElement).toContainElement(historyButton);
    fireEvent.click(historyButton);

    expect(screen.getByRole("region", { name: "Question and answer history" })).toBeInTheDocument();
    expect(screen.getByText("Which outcome matters most?")).toBeInTheDocument();
    expect(screen.getByText("Secure defaults")).toBeInTheDocument();

    const thinkingToggle = screen.getByRole("button", { name: "Show AI thinking" });
    expect(thinkingToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("I updated the plan to prioritize secure defaults.")).toBeNull();

    fireEvent.click(thinkingToggle);
    expect(screen.getByRole("button", { name: "Hide AI thinking" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("I updated the plan to prioritize secure defaults.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close history" }));
    expect(screen.queryByRole("region", { name: "Question and answer history" })).toBeNull();
    await waitFor(() => expect(historyButton).toHaveFocus());
  });

  it("creates the task directly and offers task and session-list handoffs", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-1", type: "text", question: "Anything else?" }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    const onClose = vi.fn();
    const onTaskCreated = vi.fn();
    const onViewTask = vi.fn();
    render(<PlanningModeModal isOpen onClose={onClose} onTaskCreated={onTaskCreated} onTasksCreated={vi.fn()} onViewTask={onViewTask} tasks={mockTasks} projectId="project-1" resumeSessionId="session-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Proceed with plan" }));

    await waitFor(() => expect(mockValidatePlanningSession).toHaveBeenCalledWith("session-1", "project-1"));
    await waitFor(() => expect(mockCreateTaskFromPlanning).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ title: mockSummary.title }),
      "project-1",
      {},
    ));
    expect(screen.queryByRole("heading", { name: "Review your plan" })).toBeNull();
    expect(await screen.findByTestId("planning-task-created")).toHaveTextContent("FN-8442");
    expect(onTaskCreated).toHaveBeenCalledWith({ id: "FN-8442" });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "View task" }));
    expect(onViewTask).toHaveBeenCalledWith({ id: "FN-8442" });

    fireEvent.click(screen.getByRole("button", { name: "Return to sessions" }));
    expect(await screen.findByRole("complementary", { name: "Planning sessions" })).toBeInTheDocument();
  });

  it("automatically resolves an in-progress create claim without showing retry UI", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-1", type: "text", question: "Anything else?" }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    mockCreateTaskFromPlanning
      .mockRejectedValueOnce(Object.assign(new Error("Planning task creation is already in progress"), { status: 409 }))
      .mockResolvedValueOnce({ id: "FN-8442" });

    renderSession({});
    fireEvent.click(await screen.findByRole("button", { name: "Proceed with plan" }));

    expect(await screen.findByTestId("planning-task-created")).toHaveTextContent("FN-8442");
    expect(mockCreateTaskFromPlanning).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("planning-create-retry")).toBeNull();
  });

  it("keeps both created-task handoffs reachable on mobile", async () => {
    mockViewportMode.mockReturnValue("mobile");
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-1", type: "text", question: "Anything else?" }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    const onViewTask = vi.fn();
    render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} onViewTask={onViewTask} tasks={mockTasks} projectId="project-1" resumeSessionId="session-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Proceed with plan" }));

    expect(await screen.findByRole("button", { name: "View task" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Return to sessions" })).toBeEnabled();
  });

  it("restores a linked task into the created-task handoff", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "complete",
      currentQuestion: null,
      result: JSON.stringify(mockSummary),
      inputPayload: JSON.stringify({ validated: true, createdTaskId: "FN-001" }),
    });
    const onTaskCreated = vi.fn();
    const onViewTask = vi.fn();
    render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={onTaskCreated} onTasksCreated={vi.fn()} onViewTask={onViewTask} tasks={mockTasks} projectId="project-1" resumeSessionId="session-1" />);

    expect(await screen.findByTestId("planning-task-created")).toHaveTextContent("FN-001");
    await waitFor(() => expect(onTaskCreated).toHaveBeenCalledWith(mockTasks[0]));
    expect(screen.getByRole("button", { name: "View task" })).toBeEnabled();
  });

  it("waits for a restored linked task before enabling its task handoff", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "complete",
      currentQuestion: null,
      result: JSON.stringify(mockSummary),
      inputPayload: JSON.stringify({ validated: true, createdTaskId: "FN-LATER" }),
    });
    const onTaskCreated = vi.fn();
    render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={onTaskCreated} onTasksCreated={vi.fn()} onViewTask={vi.fn()} tasks={[]} projectId="project-1" resumeSessionId="session-1" />);

    expect(await screen.findByTestId("planning-task-created")).toHaveTextContent("FN-LATER");
    expect(screen.getByRole("button", { name: "View task" })).toBeDisabled();
    expect(onTaskCreated).not.toHaveBeenCalled();
  });

  it("uses full-view Questions and Plan preview tabs on mobile", async () => {
    mockViewportMode.mockReturnValue("mobile");
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-mobile", type: "text", question: "What should mobile prioritize?" }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    renderSession({});

    const workspace = await screen.findByTestId("planning-workspace");
    // The viewport-mode hook is mocked without changing jsdom's CSS media viewport.
    const questionsTab = screen.getByRole("tab", { name: "Questions", hidden: true });
    const planTab = screen.getByRole("tab", { name: "Plan preview", hidden: true });
    expect(questionsTab).toHaveAttribute("aria-selected", "true");
    expect(workspace).toHaveClass("planning-workspace--mobile-tab-question");

    fireEvent.click(planTab);
    expect(planTab).toHaveAttribute("aria-selected", "true");
    expect(questionsTab).toHaveAttribute("aria-selected", "false");
    expect(workspace).toHaveClass("planning-workspace--mobile-tab-plan");
    expect(screen.getByTestId("planning-plan-pane")).toHaveTextContent("Build authentication system");

    fireEvent.click(screen.getByRole("button", { name: "History", hidden: true }));
    expect(screen.getByRole("region", { name: "Question and answer history" })).toBeInTheDocument();
    expect(screen.getByText("No history yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close history" }));
  });

  it("keeps both panes visible under a generating-plan overlay after Next", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-1", type: "single_select", question: "Which outcome matters most?", options: [{ id: "secure", label: "Secure defaults" }, { id: "fast", label: "Fast delivery" }] }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    mockRespondToPlanning.mockReturnValue(new Promise(() => undefined));
    renderSession({});
    fireEvent.click(await screen.findByLabelText("Secure defaults"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const workspace = screen.getByTestId("planning-workspace");
    expect(workspace).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Generating plan…")).toBeInTheDocument();
    expect(screen.getByTestId("planning-plan-pane")).toHaveTextContent("Build authentication system");
    expect(screen.getByTestId("planning-question-pane")).toHaveTextContent("Which outcome matters most?");
  });
  it("opens a freeform refinement prompt and uses it for the plan and next questions", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-current", type: "single_select", question: "What should the plan prioritize?", options: [{ id: "security", label: "Security" }, { id: "speed", label: "Speed" }] }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
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
    expect(screen.getByTestId("planning-plan-pane")).toHaveTextContent("Build authentication system");
    expect(screen.getByTestId("planning-question-pane")).toHaveTextContent("What should the plan prioritize?");
    expect(screen.getByRole("dialog", { name: "Refine plan and questions" })).toBeInTheDocument();
    expect(screen.getByText("Refine the plan and next questions")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByLabelText("Refinement instructions")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Refinement instructions"), { target: { value: "Discard this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Refine" }));
    expect(screen.getByLabelText("Refinement instructions")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Refinement instructions"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Apply refinement" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Refinement instructions"), { target: { value: "Add migration sequencing and ask about rollout risks." } });
    fireEvent.click(screen.getByRole("button", { name: "Apply refinement" }));
    await waitFor(() => expect(mockRespondToPlanning).toHaveBeenCalledWith("session-1", { refine: true, focus: "Add migration sequencing and ask about rollout risks." }, "project-1"));
    expect(await screen.findByText("Which migration risk should come first?")).toBeInTheDocument();
  });
  it("restores the updating-plan progress state after refresh", async () => {
    mockFetchAiSession.mockResolvedValue({ ...base, status: "generating", currentQuestion: null, result: JSON.stringify(summaryWithRefinements), inputPayload: JSON.stringify({ generationPurpose: "plan_update" }) });
    renderSession({});
    expect(await screen.findByText("Generating plan…")).toBeInTheDocument();
    await waitFor(() => expect(mockConnectPlanningStream).toHaveBeenCalledTimes(1));
    expect(mockConnectPlanningStream).toHaveBeenCalledWith("session-1", "project-1", expect.any(Object));
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
  it("keeps detailed plan review and freeform refinement available on mobile", async () => {
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
    expect(screen.getByRole("dialog", { name: "Refine plan and questions" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Refinement instructions" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Refine plan and questions" })).toBeNull();
    expect(screen.getByTestId("planning-plan-review")).toBeInTheDocument();
  });
  it("restores a validated unlinked session to create-only retry", async () => {
    mockFetchAiSession.mockResolvedValue({ ...base, status: "complete", currentQuestion: null, result: JSON.stringify(mockSummary), inputPayload: JSON.stringify({ validated: true }) });
    renderSession({});
    expect(await screen.findByTestId("planning-create-retry")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Proceed with plan" })).toBeNull();
  });
});
