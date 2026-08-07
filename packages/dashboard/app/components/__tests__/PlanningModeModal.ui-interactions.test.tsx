// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readAppFile } from "../../test/cssFixture";
import { PlanningModeModal, QuestionForm, resetPlanningAutoRetryAttemptsForTests } from "../PlanningModeModal";
import {
  mockCreatePlanningDraft,
  mockFetchAiSession,
  mockFetchAiSessions,
  mockRespondToPlanning,
  mockRetryPlanningSession,
  mockStartPlanningStreaming,
  mockStopPlanningGeneration,
  mockValidatePlanningSession,
  mockCreateTaskFromPlanning,
  mockTasks,
  mockSummary,
} from "./PlanningModeModal.test-helpers";

const mockViewportMode = vi.hoisted(() => vi.fn(() => "desktop" as "desktop" | "tablet" | "mobile"));

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
    startPlanning: fn(), startPlanningStreaming: (...args: unknown[]) => mockStartPlanningStreaming(...args), createPlanningDraft: (...args: unknown[]) => mockCreatePlanningDraft(...args), connectPlanningStream: fn(), rewindPlanningSession: fn(), retryPlanningSession: (...args: unknown[]) => mockRetryPlanningSession(...args), cancelPlanning: fn(), stopPlanningGeneration: (...args: unknown[]) => mockStopPlanningGeneration(...args), updatePlanningSessionDraft: fn(), updatePlanningSessionTitle: fn(), startPlanningBreakdown: fn(), createTasksFromPlanning: fn(), parseConversationHistory: (raw: string) => JSON.parse(raw || "[]"), acquireSessionLock: fn(), releaseSessionLock: fn(), forceAcquireSessionLock: fn(), uploadAttachment: fn(), deleteAttachment: fn(), updateTask: fn(), pauseTask: fn(), unpauseTask: fn(), fetchTaskDetail: fn(), requestSpecRevision: fn(), approvePlan: fn(), rejectPlan: fn(), refineTask: fn(), deleteAiSession: fn(), archiveAiSession: fn(), unarchiveAiSession: fn(), refineText: fn(), getRefineErrorMessage: (error: Error) => error.message,
  };
});

const sessionBase = { id: "session-1", title: "Secure plan", projectId: "project-1", updatedAt: new Date().toISOString(), archived: false, conversationHistory: "[]", thinkingOutput: "" };
const summaryWithRefinements = { ...mockSummary, suggestedRefinements: ["Security boundaries", "Rollout strategy"] };
function renderSession() {
  return render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" resumeSessionId="session-1" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPlanningAutoRetryAttemptsForTests();
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
  resetPlanningAutoRetryAttemptsForTests();
  vi.restoreAllMocks();
});

describe("PlanningModeModal sequential layout", () => {
  it("uses one persistent responsive plan-and-question workspace", () => {
    const css = readAppFile("components/PlanningModeModal.css");
    expect(css).not.toMatch(/planning-compact-pane-switcher|planning-answered-history/);
    expect(css).toContain("planning-workspace");
    expect(css).toContain('grid-template-areas: "question plan"');
    expect(css).toContain("planning-summary-actions");
  });

  it("captures selections only from the rendered plan and provides accessible comment controls", () => {
    const component = readAppFile("components/PlanningModeModal.tsx");
    expect(component).toContain("planDocumentRef.current");
    expect(component).toContain("root.contains(selection.anchorNode)");
    expect(component).toContain("root.contains(selection.focusNode)");
    expect(component).toContain('document.addEventListener("selectionchange", capturePlanSelection)');
    expect(component).toContain("selection.isCollapsed");
    expect(component).toContain("Add comment to selection");
    /*
    FNXC:PlanningComments 2026-07-25-10:20:
    Exactly one Add-comment trigger, in the plan action rail. The --document / --mobile variant pair
    rendered two buttons and must not come back.
    */
    expect(component).not.toContain("planning-add-comment--document");
    expect(component).not.toContain("planning-add-comment--mobile");
    expect(component.match(/className="btn planning-add-comment"/g)).toHaveLength(1);
    expect(component).toContain("addCommentTriggerRef");
    // FNXC:PlanningComments 2026-07-25-10:20: the control appears once the drag-selection is done, not per selectionchange.
    expect(component).toContain("planSelectionDragActiveRef");
    expect(component).toContain('document.addEventListener("pointerup", handlePointerRelease)');
    expect(component).toContain("contextualComments");
    expect(component).toContain("setContextualComments([])");
    // FNXC:PlanningComments 2026-07-24-06:20: prevent blur on pointerdown; commit on click.
    expect(component).toContain("handleMobileKeyboardActionPointerDown");
    expect(component).toContain("onPointerDown={handleMobileKeyboardActionPointerDown}");
    expect(component).toContain("onClick={handleAddContextualComment}");
    // FNXC:PlanningComments 2026-07-24-06:30: freeze quote on open so selection collapse cannot unmount the editor.
    expect(component).toContain("openCommentEditor");
    expect(component).toContain("openCommentQuote");
    expect(component).toContain("pendingOpenCommentQuoteRef");
  });

  it("renders four normalized choices plus one Other without duplicate rows", () => {
    const onSubmit = vi.fn();
    render(<QuestionForm
      question={{
        id: "direction",
        type: "single_select",
        question: "Which direction should we take?",
        options: [
          { id: "speed", label: "Ship quickly", description: "Deliver a focused version.", pros: ["Fast"], cons: ["Narrow"] },
          { id: "reliable", label: "Prioritize reliability", description: "Build safeguards first.", pros: ["Safe"], cons: ["Slow"] },
          { id: "scope", label: "Reduce scope", description: "Deliver the essentials only.", pros: ["Small"], cons: ["Later"] },
          { id: "learn", label: "Investigate first", description: "Research before deciding.", pros: ["Informed"], cons: ["Delayed"] },
          { id: "speed", label: "Duplicate ID", description: "Must not render.", pros: [""], cons: [""] },
          { id: "other", label: "Duplicate Other", isOther: true },
        ],
      }}
      onSubmit={onSubmit}
    />);

    for (const label of ["Ship quickly", "Prioritize reliability", "Reduce scope", "Investigate first", "Other (write your own)"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.queryByText("Duplicate ID")).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    fireEvent.click(screen.getByRole("radio", { name: /reduce scope/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    expect(onSubmit).toHaveBeenCalledWith({ direction: "scope" });
  });

  /*
  FNXC:PlanningMode 2026-08-07-03:23:
  Model guidance normally asks for 3–5 substantive alternatives but is not a render cap.
  Exercise the live modal through its desktop/mobile viewport seam so every returned option and
  the single synthetic Other path remain actionable for operators.
  */
  it.each(["desktop", "mobile"] as const)("keeps five substantive choices and one Other usable on %s", async (viewport) => {
    mockViewportMode.mockReturnValue(viewport);
    mockFetchAiSession.mockResolvedValue({
      ...sessionBase,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({
        id: "q-five-options",
        type: "single_select",
        question: "Which delivery direction should we take?",
        options: [
          { id: "one", label: "First direction", description: "Start with the smallest change.", pros: ["Focused"], cons: ["Narrow"] },
          { id: "two", label: "Second direction", description: "Add safeguards first.", pros: ["Safe"], cons: ["Slower"] },
          { id: "three", label: "Third direction", description: "Research the shared surface.", pros: ["Informed"], cons: ["Delayed"] },
          { id: "four", label: "Fourth direction", description: "Stage the work gradually.", pros: ["Controlled"], cons: ["More steps"] },
          { id: "five", label: "Fifth direction", description: "Deliver the full outcome now.", pros: ["Complete"], cons: ["Broader"] },
        ],
      }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });
    mockRespondToPlanning.mockResolvedValue({ summary: summaryWithRefinements, currentQuestion: null });

    renderSession();
    await screen.findByText("Which delivery direction should we take?");
    for (const label of ["First direction", "Second direction", "Third direction", "Fourth direction", "Fifth direction", "Other (write your own)"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("radio")).toHaveLength(6);

    if (viewport === "desktop") {
      fireEvent.click(screen.getByRole("radio", { name: /fifth direction/i }));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      await waitFor(() => expect(mockRespondToPlanning).toHaveBeenCalledWith("session-1", { "q-five-options": "five" }, "project-1"));
      return;
    }

    fireEvent.click(screen.getByRole("radio", { name: /other \(write your own\)/i }));
    fireEvent.change(screen.getByTestId("planning-other-input"), { target: { value: "Use an operator-defined direction" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mockRespondToPlanning).toHaveBeenCalledWith("session-1", { _other: "Use an operator-defined direction" }, "project-1"));
  });

  it("renders every greater-than-five choice while deduplicating model-authored Other entries", async () => {
    mockFetchAiSession.mockResolvedValue({
      ...sessionBase,
      status: "awaiting_input",
      currentQuestion: JSON.stringify({
        id: "q-six-options",
        type: "single_select",
        question: "Which option set should remain available?",
        options: [
          { id: "one", label: "One" }, { id: "two", label: "Two" }, { id: "three", label: "Three" },
          { id: "four", label: "Four" }, { id: "five", label: "Five" }, { id: "six", label: "Six" },
          { id: "other", label: "Model Other", isOther: true }, { id: "other-again", label: "Another Other", isOther: true },
        ],
      }),
      result: JSON.stringify(summaryWithRefinements),
      inputPayload: "{}",
    });

    renderSession();
    await screen.findByText("Which option set should remain available?");
    for (const label of ["One", "Two", "Three", "Four", "Five", "Six", "Other (write your own)"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("radio")).toHaveLength(7);
    expect(screen.getAllByText("Other (write your own)")).toHaveLength(1);
  });

  it("keeps plan actions in a non-scrolling sibling footer with equal mobile columns", () => {
    const css = readAppFile("components/PlanningModeModal.css");
    expect(css).toMatch(/\.planning-actions\s*\{[^}]*flex-shrink\s*:\s*0\s*;/);
    expect(css).toMatch(/\.planning-plan-actions\s*\{[^}]*justify-content\s*:\s*flex-end\s*;[^}]*gap\s*:\s*var\(--space-lg\)\s*;[^}]*padding\s*:\s*var\(--space-md\) var\(--space-xl\) var\(--space-sm\)\s*;/);
    expect(css).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.planning-plan-actions\s*\{[^}]*display\s*:\s*grid\s*;[^}]*grid-template-columns\s*:\s*repeat\(2, minmax\(0, 1fr\)\)\s*;[^}]*gap\s*:\s*var\(--space-md\)\s*;[^}]*calc\(var\(--space-sm\) \+ env\(safe-area-inset-bottom\)\)/);
    expect(css).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.planning-plan-actions \.btn\s*\{[^}]*width\s*:\s*100%\s*;/);
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.planning-plan-actions\s*\{[^}]*gap\s*:\s*var\(--space-md\)\s*;[^}]*calc\(var\(--space-sm\) \+ env\(safe-area-inset-bottom\)\)/);
    // FNXC:PlanningComments 2026-07-25-10:20: one trigger everywhere — no breakpoint hides or duplicates it.
    expect(css).not.toMatch(/planning-add-comment--(document|mobile)/);
    expect(css).toMatch(/\.planning-add-comment\s*\{[^}]*display\s*:\s*inline-flex\s*;/);
    expect(css).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.planning-plan-actions \.btn\.planning-add-comment\s*\{[^}]*display\s*:\s*flex\s*;[^}]*grid-column\s*:\s*1\s*\/\s*-1\s*;/);
    expect(css).not.toMatch(/@media \(max-width: 768px\)[\s\S]*?\.planning-plan-actions \.btn\.planning-add-comment\s*\{[^}]*position\s*:\s*fixed\s*;/);
    expect(css).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.planning-comment-editor\s*\{[^}]*position\s*:\s*fixed\s*;/);
  });
});
