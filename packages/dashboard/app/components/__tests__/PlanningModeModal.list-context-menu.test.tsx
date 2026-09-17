// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanningModeModal } from "../PlanningModeModal";
import { mockFetchAiSession, mockFetchAiSessions, mockTasks } from "./PlanningModeModal.test-helpers";
import { LIST_ITEM_LONG_PRESS_DELAY_MS, LIST_ITEM_ROW_ATTRIBUTE } from "../../utils/listItemGesture";

/*
FNXC:PlanningSessionRowActions 2026-09-17-03:18:
FN-486 : les commandes de la ligne Planning passent par le menu contextuel partagé. Ces cas prouvent que le
geste d'ouverture (clic droit, appui long) N'OUVRE PAS la session, que la cible est toujours l'identité de la
LIGNE et non la session sélectionnée, que la suppression conserve son annulation serveur préalable et sa
confirmation, et qu'un Planning gardé monté mais inactif ne laisse survivre ni menu ni minuterie.
*/

const mockCancelPlanning = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDeleteAiSession = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAddToast = vi.hoisted(() => vi.fn());
const mockViewportMode = vi.hoisted(() => vi.fn(() => "desktop" as "desktop" | "tablet" | "mobile"));

vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => ({ addToast: mockAddToast, removeToast: vi.fn(), toasts: [] }), useToast: () => ({ addToast: mockAddToast, removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useViewportMode", () => ({ MOBILE_MEDIA_QUERY: "(max-width: 768px)", isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => mockViewportMode(), isMobileViewport: () => mockViewportMode() === "mobile", isTabletTouchViewport: (mode?: string) => mode === "tablet", useViewportMode: () => mockViewportMode() }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));
vi.mock("../../api", () => {
  const fn = vi.fn;
  return {
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    updatePlanningSessionTitle: fn().mockResolvedValue({ success: true }),
    cancelPlanning: (...args: unknown[]) => mockCancelPlanning(...args),
    deleteAiSession: (...args: unknown[]) => mockDeleteAiSession(...args),
    respondToPlanning: fn(), validatePlanningSession: fn(), createTaskFromPlanning: fn(),
    fetchSettings: fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
    fetchGlobalSettings: fn().mockResolvedValue({}), fetchModels: fn().mockResolvedValue([]),
    fetchWorkflowSteps: fn().mockResolvedValue([]), fetchBoardWorkflows: fn().mockResolvedValue({ workflows: [] }),
    startPlanning: fn(), startPlanningStreaming: fn(), createPlanningDraft: fn(), connectPlanningStream: fn(),
    rewindPlanningSession: fn(), retryPlanningSession: fn(), stopPlanningGeneration: fn(),
    updatePlanningSessionDraft: fn(), startPlanningBreakdown: fn(), createTasksFromPlanning: fn(),
    parseConversationHistory: (raw: string) => JSON.parse(raw || "[]"),
    acquireSessionLock: fn(), releaseSessionLock: fn(), forceAcquireSessionLock: fn(),
    uploadAttachment: fn(), deleteAttachment: fn(), updateTask: fn(), pauseTask: fn(), unpauseTask: fn(),
    fetchTaskDetail: fn(), requestSpecRevision: fn(), approvePlan: fn(), rejectPlan: fn(), refineTask: fn(),
    archiveAiSession: fn(), unarchiveAiSession: fn(), refineText: fn(),
    getRefineErrorMessage: (error: Error) => error.message,
  };
});

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    title: "First session",
    projectId: "project-1",
    type: "planning",
    status: "complete",
    updatedAt: "2026-09-17T03:18:00.000Z",
    archived: false,
    conversationHistory: "[]",
    thinkingOutput: "",
    ...overrides,
  };
}

function renderPlanning(props: Record<string, unknown> = {}) {
  return render(
    <PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" {...props} />,
  );
}

async function row(title: string) {
  return (await screen.findByText(title)).closest(".planning-sidebar-item-button") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockViewportMode.mockReturnValue("desktop");
  mockFetchAiSession.mockResolvedValue(null);
  mockCancelPlanning.mockResolvedValue(undefined);
  mockDeleteAiSession.mockResolvedValue(undefined);
  mockFetchAiSessions.mockResolvedValue([
    session(),
    session({ id: "session-2", title: "Second session", status: "generating" }),
    session({ id: "session-3", title: "New planning session", status: "draft", preview: "Draft preview" }),
    session({ id: "session-4", title: "Broken session", status: "error" }),
  ]);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Planning session rows — menu contextuel partagé", () => {
  it("qualifie chaque ligne pour le geste de fermeture du tiroir et n'expose aucun bouton secondaire", async () => {
    renderPlanning();
    for (const title of ["First session", "Second session", "Draft preview", "Broken session"]) {
      const trigger = await row(title);
      expect(trigger.getAttribute(LIST_ITEM_ROW_ATTRIBUTE)).toBe("true");
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    }
    expect(document.querySelector(".planning-sidebar-item-actions")).toBeNull();
  });

  it("ouvre le menu par appui long sans ouvrir la session ni la charger", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPlanning();
      const trigger = await screen.findByText("Second session").then((label) => label.closest(".planning-sidebar-item-button") as HTMLElement);
      fireEvent.pointerDown(trigger, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 15, clientY: 15 });
      act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS); });
      const menu = screen.getByTestId("planning-session-context-menu");
      expect(within(menu).getByTestId("planning-session-menu-rename")).toBeInTheDocument();
      fireEvent.pointerUp(trigger, { pointerType: "touch", pointerId: 1 });
      fireEvent.click(trigger);
      expect(mockFetchAiSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("supprime la session de la LIGNE, en annulant d'abord une génération serveur", async () => {
    renderPlanning();
    const trigger = await row("Second session");
    fireEvent.contextMenu(trigger, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("planning-session-menu-delete"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mockDeleteAiSession).toHaveBeenCalledWith("session-2"));
    expect(mockCancelPlanning).toHaveBeenCalledWith("session-2", "project-1");
    expect(mockDeleteAiSession).toHaveBeenCalledTimes(1);
  });

  it("ne lance aucune annulation serveur pour une session terminale et reste visible sur échec", async () => {
    mockDeleteAiSession.mockRejectedValue(new Error("boom"));
    renderPlanning();
    const trigger = await row("Broken session");
    fireEvent.contextMenu(trigger, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("planning-session-menu-delete"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mockDeleteAiSession).toHaveBeenCalledWith("session-4"));
    expect(mockCancelPlanning).not.toHaveBeenCalled();
    await waitFor(() => expect(mockAddToast).toHaveBeenCalled());
    expect(await screen.findByText("Broken session")).toBeInTheDocument();
  });

  it("un simple geste de fermeture ne supprime ni n'annule rien", async () => {
    renderPlanning();
    const trigger = await row("First session");
    fireEvent.pointerDown(trigger, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(trigger, { pointerType: "touch", pointerId: 1, clientX: 0, clientY: 140 });
    fireEvent.pointerUp(trigger, { pointerType: "touch", pointerId: 1, clientX: 0, clientY: 140 });
    expect(screen.queryByTestId("planning-session-context-menu")).toBeNull();
    expect(mockDeleteAiSession).not.toHaveBeenCalled();
    expect(mockCancelPlanning).not.toHaveBeenCalled();
  });

  it("ne laisse survivre aucun menu lorsque la ligne disparaît de la liste", async () => {
    renderPlanning();
    fireEvent.contextMenu(await row("Second session"), { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("planning-session-context-menu")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("planning-session-menu-delete"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("Second session")).toBeNull());
    expect(screen.queryByTestId("planning-session-context-menu")).toBeNull();
    expect(screen.getByText("First session")).toBeInTheDocument();
  });

  it("n'ouvre aucun menu lorsque Planning est gardé monté mais inactif", async () => {
    renderPlanning({ active: false });
    fireEvent.contextMenu(await row("First session"), { clientX: 10, clientY: 10 });
    expect(screen.queryByTestId("planning-session-context-menu")).toBeNull();
  });
});
