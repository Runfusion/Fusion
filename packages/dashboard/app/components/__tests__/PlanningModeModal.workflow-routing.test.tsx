import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlanningModeModal } from "../PlanningModeModal";
import {
  mockCreatePlanningDraft,
  mockCreateTaskFromPlanning,
  mockFetchAiSession,
  mockFetchAiSessions,
  mockRespondToPlanning,
  mockStartPlanningStreaming,
  mockTasks,
  mockSummary,
  mockValidatePlanningSession,
} from "./PlanningModeModal.test-helpers";

vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useViewportMode", () => ({ MOBILE_MEDIA_QUERY: "(max-width: 768px)", isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => "desktop", isMobileViewport: () => false, isTabletTouchViewport: () => false, useViewportMode: () => "desktop" }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));
vi.mock("../../api", () => {
  const fn = vi.fn;
  return {
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    respondToPlanning: (...args: unknown[]) => mockRespondToPlanning(...args),
    validatePlanningSession: (...args: unknown[]) => mockValidatePlanningSession(...args),
    createTaskFromPlanning: (...args: unknown[]) => mockCreateTaskFromPlanning(...args),
    fetchSettings: fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
    fetchGlobalSettings: fn().mockResolvedValue({}),
    fetchModels: fn().mockResolvedValue([]),
    fetchWorkflowSteps: fn().mockResolvedValue([]),
    fetchBoardWorkflows: fn().mockResolvedValue({ workflows: [] }),
    startPlanning: fn(),
    startPlanningStreaming: (...args: unknown[]) => mockStartPlanningStreaming(...args),
    createPlanningDraft: (...args: unknown[]) => mockCreatePlanningDraft(...args),
    connectPlanningStream: fn(),
    rewindPlanningSession: fn(),
    retryPlanningSession: fn(),
    cancelPlanning: fn(),
    stopPlanningGeneration: fn(),
    updatePlanningSessionDraft: fn(),
    updatePlanningSessionTitle: fn(),
    startPlanningBreakdown: fn(),
    createTasksFromPlanning: fn(),
    parseConversationHistory: (raw: string) => JSON.parse(raw || "[]"),
    acquireSessionLock: fn(),
    releaseSessionLock: fn(),
    forceAcquireSessionLock: fn(),
    uploadAttachment: fn(),
    deleteAttachment: fn(),
    updateTask: fn(),
    pauseTask: fn(),
    unpauseTask: fn(),
    fetchTaskDetail: fn(),
    requestSpecRevision: fn(),
    approvePlan: fn(),
    rejectPlan: fn(),
    refineTask: fn(),
    deleteAiSession: fn(),
    refineText: fn(),
    getRefineErrorMessage: (error: Error) => error.message,
  };
});

const session = {
  id: "session-routing",
  title: "Workflow routing plan",
  projectId: "project-1",
  updatedAt: "2026-08-28T00:00:00.000Z",
  archived: false,
  status: "awaiting_input",
  currentQuestion: JSON.stringify({ id: "q-1", type: "text", question: "Anything else?" }),
  result: JSON.stringify(mockSummary),
  inputPayload: "{}",
  conversationHistory: "[]",
  thinkingOutput: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchAiSession.mockResolvedValue(session);
  mockFetchAiSessions.mockResolvedValue([]);
  mockValidatePlanningSession.mockResolvedValue({ summary: mockSummary, validated: true });
  mockCreateTaskFromPlanning.mockResolvedValue({ id: "FN-ROUTED" });
  mockCreatePlanningDraft.mockResolvedValue({ sessionId: "draft-1", title: "Draft" });
  mockStartPlanningStreaming.mockResolvedValue({ sessionId: "draft-1" });
});

afterEach(() => cleanup());

describe("PlanningModeModal workflow routing", () => {
  it.each([
    { label: "undefined", workflowId: undefined },
    { label: "null", workflowId: null },
    { label: "blank", workflowId: "" },
    { label: "aggregate", workflowId: "__all_workflows__" },
  ])("omits a $label workflow id when creating", async ({ workflowId }) => {
    render(
      <PlanningModeModal
        isOpen
        onClose={vi.fn()}
        onTaskCreated={vi.fn()}
        onTasksCreated={vi.fn()}
        tasks={mockTasks}
        projectId="project-1"
        resumeSessionId="session-routing"
        workflowId={workflowId}
      />,
    );

    await screen.findByRole("button", { name: "Proceed with plan" });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Proceed with plan" }));

    await waitFor(() => expect(mockCreateTaskFromPlanning).toHaveBeenCalled());
    const options = mockCreateTaskFromPlanning.mock.calls.at(-1)?.[3] as Record<string, unknown>;
    expect(options).not.toHaveProperty("workflowId");
  });

  it("forwards a concrete trimmed workflow id when creating", async () => {
    render(
      <PlanningModeModal
        isOpen
        onClose={vi.fn()}
        onTaskCreated={vi.fn()}
        onTasksCreated={vi.fn()}
        tasks={mockTasks}
        projectId="project-1"
        resumeSessionId="session-routing"
        workflowId=" wf-real "
      />,
    );

    await screen.findByRole("button", { name: "Proceed with plan" });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Proceed with plan" }));

    await waitFor(() => expect(mockCreateTaskFromPlanning).toHaveBeenCalled());
    expect(mockCreateTaskFromPlanning.mock.calls.at(-1)?.[3]).toMatchObject({ workflowId: "wf-real" });
  });
});
