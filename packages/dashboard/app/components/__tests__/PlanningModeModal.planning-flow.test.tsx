import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlanningModeModal, resetPlanningAutoRetryAttemptsForTests } from "../PlanningModeModal";
import { mockCreatePlanningDraft, mockFetchAiSession, mockFetchAiSessions, mockRespondToPlanning, mockRetryPlanningSession, mockStartPlanningStreaming, mockStopPlanningGeneration, mockValidatePlanningSession, mockCreateTaskFromPlanning, mockTasks, mockSummary } from "./PlanningModeModal.test-helpers";

const mockViewportMode = vi.hoisted(() => vi.fn(() => "desktop" as "desktop" | "tablet" | "mobile"));
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
    startPlanning: fn(), startPlanningStreaming: (...args: unknown[]) => mockStartPlanningStreaming(...args), createPlanningDraft: (...args: unknown[]) => mockCreatePlanningDraft(...args), connectPlanningStream: (...args: unknown[]) => mockConnectPlanningStream(...args), rewindPlanningSession: fn(), retryPlanningSession: (...args: unknown[]) => mockRetryPlanningSession(...args), cancelPlanning: fn(), stopPlanningGeneration: (...args: unknown[]) => mockStopPlanningGeneration(...args), updatePlanningSessionDraft: fn(), updatePlanningSessionTitle: fn(), startPlanningBreakdown: fn(), createTasksFromPlanning: fn(), parseConversationHistory: (raw: string) => JSON.parse(raw || "[]"), acquireSessionLock: fn(), releaseSessionLock: fn(), forceAcquireSessionLock: fn(), uploadAttachment: fn(), deleteAttachment: fn(), updateTask: fn(), pauseTask: fn(), unpauseTask: fn(), fetchTaskDetail: fn(), requestSpecRevision: fn(), approvePlan: fn(), rejectPlan: fn(), refineTask: fn(), deleteAiSession: fn(), refineText: fn(), getRefineErrorMessage: (error: Error) => error.message,
  };
});

const base = { id: "session-1", title: "Secure plan", projectId: "project-1", updatedAt: new Date().toISOString(), archived: false, conversationHistory: "[]", thinkingOutput: "" };
function renderSession(sessionId = "session-1") { return render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" resumeSessionId={sessionId} />); }
const summaryWithRefinements = {
  ...mockSummary,
  description: "Build a **reviewed** recovery workflow with an operator [runbook](https://example.com/runbook).",
  proposedChanges: ["Change the authentication API", "Add durable session recovery"],
  acceptanceCriteria: ["Refresh preserves generation", "The plan is reviewable before questions"],
  suggestedRefinements: ["Security boundaries", "Rollout strategy", "Failure recovery", "Accessibility", "Observability"],
};

describe("PlanningModeModal sequential flow", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    resetPlanningAutoRetryAttemptsForTests();
    localStorage.clear();
    mockPlanningSse.events = null;
    mockViewportMode.mockReturnValue("desktop");
    mockFetchAiSessions.mockResolvedValue([]);
    mockCreatePlanningDraft.mockResolvedValue({ sessionId: "draft-1", title: "Secure plan" });
    mockStartPlanningStreaming.mockResolvedValue({ sessionId: "draft-1" });
    mockRetryPlanningSession.mockResolvedValue({ success: true });
    mockStopPlanningGeneration.mockResolvedValue({ success: true });
    mockValidatePlanningSession.mockResolvedValue({ summary: mockSummary, validated: true });
    mockCreateTaskFromPlanning.mockResolvedValue({ id: "FN-8442" });
  });

  afterEach(() => {
    cleanup();
    mockPlanningSse.events = null;
    localStorage.clear();
    resetPlanningAutoRetryAttemptsForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /*
  FNXC:PlanningRetry 2026-07-21-10:00:
  Returning to Planning must recover every failed generation surface instead of rendering a
  terminal error: both a row already persisted as error and a resumed generating stream that
  subsequently reports its durable error dispatch the existing retry endpoint automatically.
  */
  it("automatically retries a persisted error when returning to Planning", async () => {
    const sessionId = "persisted-error-session";
    mockFetchAiSession.mockResolvedValue({
      ...base,
      id: sessionId,
      status: "error",
      error: "The planning stream was interrupted",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });

    renderSession(sessionId);

    await waitFor(() => expect(mockRetryPlanningSession).toHaveBeenCalledWith(sessionId, "project-1"));
    expect(screen.queryByText("The planning stream was interrupted")).toBeNull();
  });

  it("automatically retries a stream error after returning to a generating session", async () => {
    const sessionId = "resumed-stream-error-session";
    mockFetchAiSession.mockResolvedValue({
      ...base,
      id: sessionId,
      status: "generating",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: JSON.stringify({ generationPurpose: "plan_update" }),
    });
    renderSession(sessionId);
    await waitFor(() => expect(mockConnectPlanningStream).toHaveBeenCalledTimes(1));

    mockFetchAiSession.mockResolvedValue({
      ...base,
      id: sessionId,
      status: "error",
      error: "The resumed stream failed",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    mockConnectPlanningStream.mock.calls[0]?.[2]?.onError?.("The resumed stream failed");

    await waitFor(() => expect(mockRetryPlanningSession).toHaveBeenCalledWith(sessionId, "project-1"));
    expect(screen.queryByText("The resumed stream failed")).toBeNull();
  });

  it("retries all bounded attempts before surfacing a returned stream error", async () => {
    const sessionId = "bounded-retry-session";
    mockFetchAiSession.mockResolvedValue({
      ...base,
      id: sessionId,
      status: "error",
      error: "The planning stream was interrupted",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    mockRetryPlanningSession.mockRejectedValue(new Error("Temporary retry outage"));

    renderSession(sessionId);

    await waitFor(() => expect(mockRetryPlanningSession).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Temporary retry outage")).toBeInTheDocument();

    mockConnectPlanningStream.mock.calls.at(-1)?.[2]?.onError?.("Late terminal stream error");
    await act(async () => Promise.resolve());
    expect(mockRetryPlanningSession).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Late terminal stream error")).toBeInTheDocument();
  });

  it("coalesces overlapping stream errors into one retry request", async () => {
    const sessionId = "coalesced-retry-session";
    let resolveRetry!: (value: { success: true }) => void;
    mockRetryPlanningSession.mockReturnValue(new Promise((resolve) => {
      resolveRetry = resolve;
    }));
    mockFetchAiSession.mockResolvedValue({
      ...base,
      id: sessionId,
      status: "error",
      error: "The planning stream was interrupted",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    renderSession(sessionId);
    await waitFor(() => expect(mockRetryPlanningSession).toHaveBeenCalledTimes(1));

    mockConnectPlanningStream.mock.calls[0]?.[2]?.onError?.("Duplicate stream error");
    await act(async () => Promise.resolve());
    expect(mockRetryPlanningSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRetry({ success: true });
      await Promise.resolve();
    });

    // Settlement releases the first owner. A later, distinct error may acquire the next
    // bounded attempt; only the duplicate report while the promise was pending is coalesced.
    mockConnectPlanningStream.mock.calls.at(-1)?.[2]?.onError?.("Later stream error");
    await waitFor(() => expect(mockRetryPlanningSession).toHaveBeenCalledTimes(2));
  });

  it("ignores a stale errored load after a newer session is selected", async () => {
    const resolvers = new Map<string, (session: Record<string, unknown>) => void>();
    mockFetchAiSession.mockImplementation((sessionId: string) => new Promise((resolve) => {
      resolvers.set(sessionId, resolve);
    }));
    const props = { isOpen: true, onClose: vi.fn(), onTaskCreated: vi.fn(), onTasksCreated: vi.fn(), tasks: mockTasks, projectId: "project-1" };
    const { rerender } = render(<PlanningModeModal {...props} resumeSessionId="session-a" />);
    await waitFor(() => expect(resolvers.has("session-a")).toBe(true));

    rerender(<PlanningModeModal {...props} resumeSessionId="session-b" />);
    await waitFor(() => expect(resolvers.has("session-b")).toBe(true));
    resolvers.get("session-b")?.({
      ...base,
      id: "session-b",
      status: "error",
      error: "Session B stream failed",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    await waitFor(() => expect(mockRetryPlanningSession).toHaveBeenCalledWith("session-b", "project-1"));

    resolvers.get("session-a")?.({
      ...base,
      id: "session-a",
      status: "error",
      error: "Session A stream failed",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    await act(async () => Promise.resolve());

    expect(mockRetryPlanningSession).not.toHaveBeenCalledWith("session-a", "project-1");
  });

  it("keeps a stale retry completion from taking ownership from the newer session", async () => {
    let resolveSessionARetry!: (value: { success: true }) => void;
    mockRetryPlanningSession.mockImplementation((sessionId: string) => sessionId === "session-a"
      ? new Promise((resolve) => {
          resolveSessionARetry = resolve;
        })
      : Promise.resolve({ success: true }));
    mockFetchAiSession.mockImplementation(async (sessionId: string) => ({
      ...base,
      id: sessionId,
      status: "error",
      error: `${sessionId} stream failed`,
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    }));
    const props = { isOpen: true, onClose: vi.fn(), onTaskCreated: vi.fn(), onTasksCreated: vi.fn(), tasks: mockTasks, projectId: "project-1" };
    const { rerender } = render(<PlanningModeModal {...props} resumeSessionId="session-a" />);
    await waitFor(() => expect(mockRetryPlanningSession).toHaveBeenCalledWith("session-a", "project-1"));

    rerender(<PlanningModeModal {...props} resumeSessionId="session-b" />);
    await waitFor(() => expect(mockRetryPlanningSession).toHaveBeenCalledWith("session-b", "project-1"));
    const connectionCountForB = mockConnectPlanningStream.mock.calls.filter(([sessionId]) => sessionId === "session-b").length;

    resolveSessionARetry({ success: true });
    await act(async () => Promise.resolve());

    expect(mockConnectPlanningStream.mock.calls.at(-1)?.[0]).toBe("session-b");
    expect(mockConnectPlanningStream.mock.calls.filter(([sessionId]) => sessionId === "session-b")).toHaveLength(connectionCountForB);
    expect(screen.queryByText("session-a stream failed")).toBeNull();
  });

  it("automatically retries a resumed error discovered by the loading poll", async () => {
    const sessionId = "polled-error-session";
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    mockFetchAiSession.mockResolvedValue({
      ...base,
      id: sessionId,
      status: "generating",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: JSON.stringify({ generationPurpose: "plan_update" }),
    });
    renderSession(sessionId);
    await waitFor(() => expect(mockConnectPlanningStream).toHaveBeenCalledTimes(1));

    const poll = intervalSpy.mock.calls.find(([, delay]) => delay === 8000)?.[0];
    expect(poll).toBeTypeOf("function");
    mockFetchAiSession.mockResolvedValue({
      ...base,
      id: sessionId,
      status: "error",
      error: "Poll observed stream error",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    await act(async () => {
      await (poll as () => Promise<void>)();
    });

    expect(mockRetryPlanningSession).toHaveBeenCalledWith(sessionId, "project-1");
    expect(screen.queryByText("Poll observed stream error")).toBeNull();
    intervalSpy.mockRestore();
  });
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
    renderSession();
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
    expect(screen.queryByRole("button", { name: "Sessions" })).toBeNull();
    const scrollRegion = screen.getByTestId("planning-plan-scroll");
    const actionBar = screen.getByTestId("planning-plan-actions");
    expect(scrollRegion).not.toContainElement(actionBar);
    expect(screen.getByTestId("planning-plan-pane")).toContainElement(actionBar);
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    expect(document.querySelector(".planning-answered-history")).toBeNull();
    expect(mockConnectPlanningStream).not.toHaveBeenCalled();
  });

  it("batches contextual plan comments in selection order and keeps the normal plan actions", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-1", type: "text", question: "Anything else?" }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    mockRespondToPlanning.mockResolvedValue({ summary: summaryWithRefinements, currentQuestion: null });
    renderSession();
    const documentNode = await screen.findByTestId("planning-plan-markdown");
    const selectQuote = (quote: string) => {
      act(() => {
        const walker = document.createTreeWalker(documentNode, NodeFilter.SHOW_TEXT);
        let textNode: Node | null = walker.nextNode();
        while (textNode && !textNode.textContent?.includes(quote)) textNode = walker.nextNode();
        expect(textNode).not.toBeNull();
        const range = document.createRange();
        range.selectNodeContents(textNode!);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        fireEvent.mouseUp(documentNode);
      });
    };
    selectQuote("Build authentication system");
    const actionBar = screen.getByTestId("planning-plan-actions");
    const documentTrigger = document.querySelector(".planning-add-comment--document");
    const mobileTrigger = document.querySelector(".planning-add-comment--mobile");
    expect(documentTrigger).toBeInstanceOf(HTMLElement);
    expect(mobileTrigger).toBeInstanceOf(HTMLElement);
    expect(documentTrigger?.closest(".planning-plan-document")).toContainElement(documentTrigger as HTMLElement);
    expect(actionBar).toContainElement(mobileTrigger as HTMLElement);
    const openTrigger = screen.getByRole("button", { name: "Add comment to selection" });
    fireEvent.pointerDown(openTrigger);
    // FNXC:PlanningComments 2026-07-24-06:30: selection collapse before click must not drop the frozen open quote.
    act(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    fireEvent.click(openTrigger);
    expect(screen.getByTestId("planning-comment-editor")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    /*
    FNXC:PlanningComments 2026-07-23-17:05:
    Opening the composer moves the native selection into the suggestion field. Cancel leaves
    that selection collapsed, so the trigger dismisses with the selection instead of staying
    sticky after the selection is done. Re-select to comment again.
    */
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add comment to selection" })).toBeNull());
    await waitFor(() => expect(screen.queryByTestId("planning-comment-editor")).toBeNull());

    selectQuote("Build authentication system");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add comment to selection" }));
    fireEvent.click(screen.getByRole("button", { name: "Add comment to selection" }));
    const suggestionInput = screen.getByLabelText("Suggestion");
    fireEvent.change(suggestionInput, { target: { value: "Explain the audit path." } });
    // Editor selections are not plan selections: the frozen open quote must remain the Markdown text.
    act(() => {
      suggestionInput.setSelectionRange(0, suggestionInput.value.length);
      fireEvent.mouseUp(suggestionInput);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(screen.getByLabelText("Add plan comment")).toHaveTextContent("Build authentication system");
    expect(screen.getByTestId("planning-comment-editor")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    // Adding a comment clears the selection, so the trigger dismisses with it.
    await waitFor(() => expect(document.querySelector(".planning-add-comment")).toBeNull());
    await waitFor(() => expect(screen.queryByTestId("planning-comment-editor")).toBeNull());
    expect(screen.getByTestId("planning-comment-tray")).toHaveTextContent("Explain the audit path.");
    expect(screen.getByRole("button", { name: "Refine" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proceed with plan" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Submit comments" }));
    await waitFor(() => expect(mockRespondToPlanning).toHaveBeenCalledWith("session-1", {
      contextualComments: [{ quote: expect.stringContaining("Build authentication system"), suggestion: "Explain the audit path." }],
    }, "project-1"));
  });

  it("dismisses the selection comment trigger when the plan selection collapses", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-1", type: "text", question: "Anything else?" }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    renderSession();
    const documentNode = await screen.findByTestId("planning-plan-markdown");
    const walker = document.createTreeWalker(documentNode, NodeFilter.SHOW_TEXT);
    let textNode: Node | null = walker.nextNode();
    while (textNode && !textNode.textContent?.includes("Build authentication system")) textNode = walker.nextNode();
    expect(textNode).not.toBeNull();
    act(() => {
      const range = document.createRange();
      range.selectNodeContents(textNode!);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(await screen.findByRole("button", { name: "Add comment to selection" })).toBeInTheDocument();

    act(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add comment to selection" })).toBeNull());
  });

  it("rehydrates a restored idle session when another tab advances its question", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-old", type: "text", question: "Old question?" }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    renderSession();
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

  it("opens question, answer, and collapsed AI reasoning history without a Sessions toggle", async () => {
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
    renderSession();

    const historyButton = await screen.findByRole("button", { name: "History" });
    expect(screen.queryByRole("button", { name: "Sessions" })).toBeNull();
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

  /*
  FNXC:PlanningSessionBack 2026-07-21-11:15:
  Session detail navigation has one invariant across desktop and compact layouts: Back is the
  only route to the saved-session list. The former Sessions toggle must not survive as a second
  affordance, and list mode must not retain an orphaned Back target.
  */
  it.each(["desktop", "tablet", "mobile"] as const)("uses only Back to return to sessions on %s", async (viewport) => {
    mockViewportMode.mockReturnValue(viewport);
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-current", type: "text", question: "What should happen next?" }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });

    renderSession();

    const backButton = await screen.findByRole("button", { name: "Back to sessions" });
    const modalBody = document.querySelector(".planning-modal-body");
    expect(screen.queryByRole("button", { name: "Sessions" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("region", { name: "Question and answer history" })).toBeInTheDocument();
    fireEvent.click(backButton);

    expect(modalBody).toHaveClass("planning-modal-body--show-list");
    expect(screen.queryByRole("button", { name: "Back to sessions" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Question and answer history" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Planning sessions" })).toBeInTheDocument();
  });

  it.each(["desktop", "tablet", "mobile"] as const)("keeps Back available from a new-session draft with saved sessions on %s", async (viewport) => {
    mockViewportMode.mockReturnValue(viewport);
    mockFetchAiSessions.mockResolvedValue([{
      ...base,
      type: "planning",
      status: "awaiting_input",
      preview: "Saved plan",
    }]);

    render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" />);

    if (viewport !== "desktop") {
      fireEvent.click(await screen.findByRole("button", { name: "New session" }));
    }
    expect(await screen.findByRole("button", { name: "Back to sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sessions" })).toBeNull();
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

    await waitFor(() => expect(mockCreateTaskFromPlanning).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ title: mockSummary.title }),
      "project-1",
      {},
    ));
    expect(mockValidatePlanningSession).not.toHaveBeenCalled();
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

    renderSession();
    /*
    FNXC:PlanningMode 2026-07-23-23:30:
    Settle pending hydration commits and click a freshly-queried node: clicking the button
    reference returned by findByRole raced late hydration re-renders on loaded CI shards
    (full-suite run 30069944059), dispatching on a detached node so the create never fired and
    the view stayed on plan review. Same detached-node class as the Stop/Refine race (5a5796bca).
    */
    await screen.findByRole("button", { name: "Proceed with plan" });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Proceed with plan" }));

    await waitFor(() => expect(mockCreateTaskFromPlanning).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("planning-task-created")).toHaveTextContent("FN-8442");
    expect(screen.queryByTestId("planning-create-retry")).toBeNull();
  });

  it("settles a delayed active-create claim before a fresh session can own the next flow", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-1", type: "text", question: "Anything else?" }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    mockCreateTaskFromPlanning
      .mockRejectedValueOnce(Object.assign(new Error("Planning task creation is already in progress"), { status: 409 }))
      .mockRejectedValueOnce(Object.assign(new Error("Planning task creation is already in progress"), { status: 409 }))
      .mockResolvedValueOnce({ id: "FN-8442" });

    const { rerender } = renderSession();
    // FNXC:PlanningMode 2026-07-23-23:30: settle hydration then click a fresh node (see detached-node note above).
    await screen.findByRole("button", { name: "Proceed with plan" });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Proceed with plan" }));
    vi.useFakeTimers();

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockCreateTaskFromPlanning).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("planning-create-retry")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(screen.getByTestId("planning-task-created")).toHaveTextContent("FN-8442");
    expect(mockCreateTaskFromPlanning).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);

    mockFetchAiSession.mockResolvedValue({
      ...base,
      id: "session-2",
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-2", type: "text", question: "What should happen next?" }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    rerender(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" resumeSessionId="session-2" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetchAiSession).toHaveBeenLastCalledWith("session-2");
    expect(mockCreateTaskFromPlanning).toHaveBeenCalledTimes(3);
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

  /*
  FNXC:PlanningMultiTask 2026-07-24-00:20:
  A session whose task exists resumes to the EDITABLE plan review workspace with a banner
  linking that task — not a terminal created-task handoff — so the plan can keep evolving
  into further tasks. Reopen never re-fires onTaskCreated for a previously created task.
  */
  it("restores a linked task as a plan-review banner with a live View task action", async () => {
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

    expect(await screen.findByTestId("planning-linked-task-note")).toHaveTextContent("FN-001");
    expect(screen.getByTestId("planning-plan-review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proceed with plan" })).toBeInTheDocument();
    expect(onTaskCreated).not.toHaveBeenCalled();
    const viewTask = screen.getByRole("button", { name: "View task" });
    expect(viewTask).toBeEnabled();
    fireEvent.click(viewTask);
    expect(onViewTask).toHaveBeenCalledWith(mockTasks[0]);
  });

  it("disables the linked-task banner action until the restored task is loaded", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "complete",
      currentQuestion: null,
      result: JSON.stringify(mockSummary),
      inputPayload: JSON.stringify({ validated: true, createdTaskId: "FN-LATER" }),
    });
    const onTaskCreated = vi.fn();
    render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={onTaskCreated} onTasksCreated={vi.fn()} onViewTask={vi.fn()} tasks={[]} projectId="project-1" resumeSessionId="session-1" />);

    expect(await screen.findByTestId("planning-linked-task-note")).toHaveTextContent("FN-LATER");
    expect(screen.getByRole("button", { name: "View task" })).toBeDisabled();
    expect(onTaskCreated).not.toHaveBeenCalled();
  });

  /*
  FNXC:PlanningMultiTask 2026-07-24-01:40:
  Review findings: Continue planning must return to the editable plan review with a working
  linked-task banner (resolving the just-created Task object, before the tasks prop refreshes),
  and the banner must never leak across session switches.
  */
  it("Continue planning returns from the task handoff to an editable plan review with a live banner", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "complete",
      currentQuestion: null,
      result: JSON.stringify(mockSummary),
      inputPayload: JSON.stringify({ validated: true }),
    });
    mockCreateTaskFromPlanning.mockResolvedValue(mockTasks[0]);
    // tasks={[]} proves the banner resolves the just-created Task object, not the tasks prop.
    render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} onViewTask={vi.fn()} tasks={[]} projectId="project-1" resumeSessionId="session-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Proceed with plan" }));
    expect(await screen.findByTestId("planning-task-created")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue planning" }));
    expect(await screen.findByTestId("planning-plan-review")).toBeInTheDocument();
    expect(screen.getByTestId("planning-linked-task-note")).toHaveTextContent(mockTasks[0].id);
    expect(screen.getByRole("button", { name: "View task" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Proceed with plan" })).toBeInTheDocument();
  });

  it("clears the linked-task banner when switching to a session without a created task", async () => {
    mockFetchAiSession.mockImplementation(async (sessionId: string) => sessionId === "session-1"
      ? {
          ...base,
          id: "session-1",
          status: "complete",
          currentQuestion: null,
          result: JSON.stringify(mockSummary),
          inputPayload: JSON.stringify({ validated: true, createdTaskId: "FN-001" }),
        }
      : {
          ...base,
          id: "session-2",
          status: "awaiting_input",
          currentQuestion: null,
          result: JSON.stringify(mockSummary),
          inputPayload: "{}",
        });
    const props = { isOpen: true, onClose: vi.fn(), onTaskCreated: vi.fn(), onTasksCreated: vi.fn(), tasks: mockTasks, projectId: "project-1" };
    const { rerender } = render(<PlanningModeModal {...props} resumeSessionId="session-1" />);

    expect(await screen.findByTestId("planning-linked-task-note")).toBeInTheDocument();

    rerender(<PlanningModeModal {...props} resumeSessionId="session-2" />);
    await waitFor(() => expect(screen.queryByTestId("planning-linked-task-note")).toBeNull());
    expect(screen.getByTestId("planning-plan-review")).toBeInTheDocument();
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
    renderSession();

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
    renderSession();
    fireEvent.click(await screen.findByLabelText("Secure defaults"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const workspace = screen.getByTestId("planning-workspace");
    expect(workspace).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Generating plan…")).toBeInTheDocument();
    expect(screen.getByTestId("planning-plan-pane")).toHaveTextContent("Build authentication system");
    expect(screen.getByTestId("planning-question-pane")).toHaveTextContent("Which outcome matters most?");
  });
  it("opens a freeform refinement prompt and uses it for the plan and next questions", async () => {
    mockViewportMode.mockReturnValue("mobile");
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
    renderSession();
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
    const applyButton = screen.getByRole("button", { name: "Apply refinement" });
    expect(fireEvent.pointerDown(applyButton, { pointerType: "touch" })).toBe(false);
    await waitFor(() => expect(mockRespondToPlanning).toHaveBeenCalledWith("session-1", { refine: true, focus: "Add migration sequencing and ask about rollout risks." }, "project-1"));
    expect(await screen.findByText("Which migration risk should come first?")).toBeInTheDocument();
  });
  /*
  FNXC:PlanningMode 2026-07-23-00:00:
  Hydrating a persisted session from the database is not generation. While the fetch is in
  flight the modal must show the neutral session loader; the "Generating…" copy (and its Stop
  affordance) is reserved for sessions the server reports as actually generating.
  */
  it("shows a session loader, not generating copy, while a persisted session hydrates", async () => {
    let resolveFetch!: (session: Record<string, unknown>) => void;
    mockFetchAiSession.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    renderSession();

    expect(await screen.findByTestId("planning-session-loading")).toHaveTextContent("Loading session…");
    expect(screen.queryByText(/Generating/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    resolveFetch({
      ...base,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({ id: "q-1", type: "text", question: "What should the plan prioritize?" }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    expect(await screen.findByText("What should the plan prioritize?")).toBeInTheDocument();
    expect(screen.queryByTestId("planning-session-loading")).toBeNull();
  });
  it("restores the updating-plan progress state after refresh", async () => {
    mockFetchAiSession.mockResolvedValue({ ...base, status: "generating", currentQuestion: null, result: JSON.stringify(summaryWithRefinements), inputPayload: JSON.stringify({ generationPurpose: "plan_update" }) });
    renderSession();
    expect(await screen.findByText("Generating plan…")).toBeInTheDocument();
    await waitFor(() => expect(mockConnectPlanningStream).toHaveBeenCalledTimes(1));
    expect(mockConnectPlanningStream).toHaveBeenCalledWith("session-1", "project-1", expect.any(Object));
  });
  it("keeps elapsed thinking time scoped to each generating session", async () => {
    const now = Date.parse("2026-07-21T08:00:30.000Z");
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    mockFetchAiSession.mockImplementation(async (sessionId: string) => ({
      ...base,
      id: sessionId,
      updatedAt: new Date(now - (sessionId === "session-1" ? 25_000 : 7_000)).toISOString(),
      status: "generating",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: JSON.stringify({
        generationPurpose: "plan_update",
        ...(sessionId === "session-1"
          ? { generationStartedAt: new Date(now - 25_000).toISOString() }
          : {}),
      }),
    }));
    const props = { isOpen: true, onClose: vi.fn(), onTaskCreated: vi.fn(), onTasksCreated: vi.fn(), tasks: mockTasks, projectId: "project-1" };
    const { rerender } = render(<PlanningModeModal {...props} resumeSessionId="session-1" />);

    expect(await screen.findByText("Thinking… (25s)")).toBeInTheDocument();

    rerender(<PlanningModeModal {...props} resumeSessionId="session-2" />);
    expect(await screen.findByText("Thinking… (7s)")).toBeInTheDocument();
    dateNow.mockRestore();
  });
  /*
  FNXC:PlanningThinkingVisibility 2026-07-23-22:45:
  Every generation step must stream thinking/output to the operator. Follow-up turns render
  the workspace loader (summary present), which previously showed only a spinner + elapsed
  time; this pins the streamed thinking pane there too.
  */
  it("streams thinking in the workspace loader during follow-up generations", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "generating",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: JSON.stringify({ generationPurpose: "plan_update", generationStartedAt: new Date().toISOString() }),
    });
    renderSession();

    await waitFor(() => expect(mockConnectPlanningStream).toHaveBeenCalledWith("session-1", "project-1", expect.any(Object)));
    const handlers = mockConnectPlanningStream.mock.calls[0]?.[2];
    act(() => handlers?.onThinking?.("Weighing the tradeoffs between approaches…"));

    expect(await screen.findByText("Weighing the tradeoffs between approaches…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide thinking" }));
    expect(screen.queryByText("Weighing the tradeoffs between approaches…")).toBeNull();
  });
  it("returns to the prior question without an error when generation is stopped", async () => {
    const priorQuestion = { id: "q-prior", type: "text", question: "What should change?" };
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "generating",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      conversationHistory: JSON.stringify([{ question: priorQuestion, response: { "q-prior": "Preserve drafts" } }]),
      inputPayload: JSON.stringify({ generationPurpose: "plan_update", generationStartedAt: new Date().toISOString() }),
    });
    renderSession();

    await waitFor(() => expect(mockConnectPlanningStream).toHaveBeenCalledWith("session-1", "project-1", expect.any(Object)));
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

    await waitFor(() => expect(mockStopPlanningGeneration).toHaveBeenCalledWith("session-1", "project-1"));
    expect(await screen.findByText("What should change?")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByPlaceholderText("Type your answer here...")).toHaveValue("Preserve drafts"));
    expect(screen.queryByText(/Generation stopped by user/i)).toBeNull();

    const stoppedStreamHandlers = mockConnectPlanningStream.mock.calls[0]?.[2];
    mockRespondToPlanning.mockResolvedValue({
      currentQuestion: { id: "q-next", type: "text", question: "What comes next?" },
      summary: summaryWithRefinements,
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mockRespondToPlanning).toHaveBeenCalledWith(
      "session-1",
      { "q-prior": "Preserve drafts" },
      "project-1",
    ));
    expect(await screen.findByText("What comes next?")).toBeInTheDocument();
    expect(mockConnectPlanningStream).toHaveBeenCalledTimes(2);

    stoppedStreamHandlers?.onError?.("Stream error");
    await Promise.resolve();
    expect(mockConnectPlanningStream).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Stream error")).toBeNull();
  });
  it("can restart initial planning after stopping its first generation", async () => {
    render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" />);
    fireEvent.change(screen.getByLabelText("What do you want to build?"), { target: { value: "Build secure accounts" } });
    fireEvent.click(screen.getByRole("button", { name: "Start Planning" }));
    await waitFor(() => expect(mockStartPlanningStreaming).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByLabelText("What do you want to build?")).toHaveValue("Build secure accounts");
    fireEvent.click(screen.getByRole("button", { name: "Start Planning" }));

    await waitFor(() => expect(mockStartPlanningStreaming).toHaveBeenCalledTimes(2));
  });
  it("can refine a stopped initial plan into the first question", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "generating",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: JSON.stringify({ generationPurpose: "initial_plan", generationStartedAt: new Date().toISOString() }),
    });
    mockRespondToPlanning.mockResolvedValue({
      currentQuestion: { id: "q-refined", type: "text", question: "Which refined area comes first?" },
      summary: summaryWithRefinements,
    });
    renderSession();

    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    /*
    FNXC:PlanningMode 2026-07-23-00:00:
    Wait for the stop to settle into plan review before grabbing Refine. Clicking the workspace
    pane's Refine while the stop transition remounts the plan pane dispatches on a detached node
    and the refinement menu never opens.
    */
    await waitFor(() => expect(mockStopPlanningGeneration).toHaveBeenCalledWith("session-1", "project-1"));
    await screen.findByTestId("planning-plan-review");
    fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
    fireEvent.change(screen.getByLabelText("Refinement instructions"), { target: { value: "Focus the next questions on rollout." } });
    fireEvent.click(screen.getByRole("button", { name: "Apply refinement" }));

    await waitFor(() => expect(mockRespondToPlanning).toHaveBeenCalledWith(
      "session-1",
      { refine: true, focus: "Focus the next questions on rollout." },
      "project-1",
    ));
    expect(await screen.findByText("Which refined area comes first?")).toBeInTheDocument();
  });
  it("replaces an active generation when refinement is applied", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      status: "generating",
      currentQuestion: null,
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: JSON.stringify({ generationPurpose: "plan_update", generationStartedAt: new Date().toISOString() }),
    });
    mockRespondToPlanning.mockResolvedValue({
      currentQuestion: { id: "q-replaced", type: "text", question: "What should the replacement prioritize?" },
      summary: summaryWithRefinements,
    });
    renderSession();

    fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
    fireEvent.change(screen.getByLabelText("Refinement instructions"), { target: { value: "Replace the current direction." } });
    fireEvent.click(screen.getByRole("button", { name: "Apply refinement" }));

    await waitFor(() => expect(mockStopPlanningGeneration).toHaveBeenCalledWith("session-1", "project-1"));
    await waitFor(() => expect(mockRespondToPlanning).toHaveBeenCalledWith(
      "session-1",
      { refine: true, focus: "Replace the current direction." },
      "project-1",
    ));
    expect(await screen.findByText("What should the replacement prioritize?")).toBeInTheDocument();
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
    renderSession();
    expect(await screen.findByText("What should come next?")).toBeInTheDocument();
    expect(screen.getAllByText("Other (write your own)")).toHaveLength(1);
  });
  it("keeps detailed plan review and freeform refinement available on mobile", async () => {
    mockViewportMode.mockReturnValue("mobile");
    mockFetchAiSession.mockResolvedValue({ ...base, status: "awaiting_input", currentQuestion: null, result: JSON.stringify(summaryWithRefinements), inputPayload: "{}" });
    renderSession();
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
  /*
  FNXC:PlanningReopenAfterValidate 2026-07-23-23:30:
  A validated session with no created task must resume into the full plan review workspace
  (read, keep editing, Proceed at any time), never a create-only retry card.
  */
  it("restores a validated unlinked session to the full plan review workspace", async () => {
    mockFetchAiSession.mockResolvedValue({ ...base, status: "complete", currentQuestion: null, result: JSON.stringify(mockSummary), inputPayload: JSON.stringify({ validated: true }) });
    renderSession();
    expect(await screen.findByTestId("planning-plan-review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proceed with plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refine" })).toBeInTheDocument();
    expect(screen.queryByTestId("planning-create-retry")).toBeNull();
  });

  it("routes generation retry away from already-validated sessions into plan review", async () => {
    /*
    FNXC:PlanningMode 2026-07-24-05:45:
    Auto/manual generation retry on a finished plan used to echo "already been validated".
    Reject retry and re-fetch the complete row.

    FNXC:PlanningReopenAfterValidate 2026-07-23-23:30:
    The refreshed complete row now lands on plan review so the plan stays editable and
    creatable instead of a create-only retry card.
    */
    mockRetryPlanningSession.mockRejectedValue(new Error("Planning session has already been validated"));
    mockFetchAiSession
      .mockResolvedValueOnce({
        ...base,
        status: "error",
        currentQuestion: null,
        result: JSON.stringify(mockSummary),
        error: "stream failed",
        inputPayload: JSON.stringify({ validated: true }),
      })
      .mockResolvedValue({
        ...base,
        status: "complete",
        currentQuestion: null,
        result: JSON.stringify(mockSummary),
        inputPayload: JSON.stringify({ validated: true }),
      });
    renderSession();
    expect(await screen.findByTestId("planning-plan-review")).toBeInTheDocument();
    expect(screen.queryByText("Planning session has already been validated")).toBeNull();
    expect(mockRetryPlanningSession).toHaveBeenCalled();
  });

  it("restores plan review when awaiting_input has a plan but no current question after retry refresh", async () => {
    mockRetryPlanningSession.mockRejectedValue(new Error("Planning session session-1 is not in an error state"));
    mockFetchAiSession
      .mockResolvedValueOnce({
        ...base,
        status: "error",
        currentQuestion: null,
        result: JSON.stringify(mockSummary),
        error: "stream failed",
        inputPayload: "{}",
      })
      .mockResolvedValue({
        ...base,
        status: "awaiting_input",
        currentQuestion: null,
        result: JSON.stringify(mockSummary),
        inputPayload: "{}",
      });
    renderSession();
    expect(await screen.findByTestId("planning-plan-review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proceed with plan" })).toBeInTheDocument();
  });

  /*
  FNXC:PlanningMode 2026-07-23-00:00:
  The seeded initialPlan handoff must be one-shot. Embedded Planning unmounts on every
  main-content navigation, resetting its in-component auto-start guard; before consumption
  existed, navigating back re-fired auto-start against the still-set modalManager payload and
  created a duplicate planning session while the first one was silently abandoned. The remount
  must instead restore the persisted active session.
  */
  it("consumes the seeded initial plan on auto-start so a navigate-back remount restores the session instead of creating a duplicate", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...base,
      id: "draft-1",
      status: "generating",
      currentQuestion: null,
      result: null,
      inputPayload: "{}",
    });
    const onInitialPlanConsumed = vi.fn();
    const commonProps = {
      isOpen: true,
      onClose: vi.fn(),
      onTaskCreated: vi.fn(),
      onTasksCreated: vi.fn(),
      tasks: mockTasks,
      projectId: "project-1",
    };

    const first = render(
      <PlanningModeModal {...commonProps} initialPlan="Seeded plan from the board" onInitialPlanConsumed={onInitialPlanConsumed} />,
    );
    await waitFor(() => expect(mockStartPlanningStreaming).toHaveBeenCalledTimes(1));
    // Consumption fires with the start itself so the owner clears the payload immediately.
    expect(onInitialPlanConsumed).toHaveBeenCalledTimes(1);

    // Navigate away: the embedded Planning view unmounts entirely.
    first.unmount();

    // Navigate back: the owner cleared the payload, so the remount takes the
    // stored-active-session restore path.
    render(<PlanningModeModal {...commonProps} />);
    await waitFor(() => expect(mockFetchAiSession).toHaveBeenCalledWith("draft-1"));

    // No second session was drafted or started by the remount.
    expect(mockCreatePlanningDraft).toHaveBeenCalledTimes(1);
    expect(mockStartPlanningStreaming).toHaveBeenCalledTimes(1);
  });
});
