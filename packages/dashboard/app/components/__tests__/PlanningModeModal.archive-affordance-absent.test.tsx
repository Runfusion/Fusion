// @vitest-environment jsdom

/*
FNXC:PlanningMode 2026-09-16-15:50:
FN-465 retire l'archivage des sessions de planification de l'interface opérateur. Contrôle négatif :
ni bascule « Show archived »/« Hide archived », ni conteneur de filtres résiduel, ni bouton
Archiver/Désarchiver par ligne (y compris sur une session terminée, seul cas qui l'exposait), sur
desktop comme sur mobile, avec une liste vide comme peuplée. Prouve aussi que la liste ne demande
plus jamais la collection archivée et qu'une session archivée résiduelle reste masquée.
*/

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanningModeModal } from "../PlanningModeModal";
import { mockFetchAiSession, mockFetchAiSessions, mockTasks } from "./PlanningModeModal.test-helpers";

const mockArchiveAiSession = vi.hoisted(() => vi.fn());
const mockUnarchiveAiSession = vi.hoisted(() => vi.fn());
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
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    updatePlanningSessionTitle: fn(),
    respondToPlanning: fn(), validatePlanningSession: fn(), createTaskFromPlanning: fn(),
    fetchSettings: fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
    fetchGlobalSettings: fn().mockResolvedValue({}), fetchModels: fn().mockResolvedValue([]),
    fetchWorkflowSteps: fn().mockResolvedValue([]), fetchBoardWorkflows: fn().mockResolvedValue({ workflows: [] }),
    startPlanning: fn(), startPlanningStreaming: fn(), createPlanningDraft: fn(), connectPlanningStream: fn(),
    rewindPlanningSession: fn(), retryPlanningSession: fn(), cancelPlanning: fn(), stopPlanningGeneration: fn(),
    updatePlanningSessionDraft: fn(), startPlanningBreakdown: fn(), createTasksFromPlanning: fn(),
    summarizePlanningDraftTitle: fn(), updateGlobalSettings: fn(),
    parseConversationHistory: (raw: string) => JSON.parse(raw || "[]"),
    acquireSessionLock: fn(), releaseSessionLock: fn(), forceAcquireSessionLock: fn(),
    uploadAttachment: fn(), deleteAttachment: fn(), updateTask: fn(), pauseTask: fn(), unpauseTask: fn(),
    fetchTaskDetail: fn(), requestSpecRevision: fn(), approvePlan: fn(), rejectPlan: fn(), refineTask: fn(),
    deleteAiSession: fn(),
    archiveAiSession: (...args: unknown[]) => mockArchiveAiSession(...args),
    unarchiveAiSession: (...args: unknown[]) => mockUnarchiveAiSession(...args),
    refineText: fn(),
    getRefineErrorMessage: (error: Error) => error.message,
  };
});

const updatedAt = "2026-09-16T15:50:00.000Z";

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    title: "Completed session",
    projectId: "project-1",
    type: "planning",
    // A terminal session is the only row that ever exposed the archive control.
    status: "complete",
    updatedAt,
    archived: false,
    conversationHistory: "[]",
    thinkingOutput: "",
    ...overrides,
  };
}

function renderPlanning() {
  return render(
    <PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" />,
  );
}

function expectNoArchiveAffordance() {
  expect(document.querySelector(".planning-sidebar-filter")).toBeNull();
  expect(document.querySelector(".planning-sidebar-item-archive")).toBeNull();
  expect(document.querySelector(".planning-sidebar-toggle-archived-link")).toBeNull();
  for (const button of screen.queryAllByRole("button")) {
    const accessibleName = `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${button.textContent ?? ""}`;
    expect(accessibleName).not.toMatch(/archiv/i);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockViewportMode.mockReturnValue("desktop");
  mockFetchAiSession.mockResolvedValue(null);
  mockFetchAiSessions.mockResolvedValue([session()]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PlanningModeModal archive affordance removal (FN-465)", () => {
  it("renders no archive toggle and no archive filter bar on desktop", async () => {
    renderPlanning();
    await screen.findByText("Completed session");

    expect(screen.queryByRole("button", { name: "Show archived" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide archived" })).toBeNull();
    expectNoArchiveAffordance();
  });

  it("offers no per-row archive control and keeps an archived session hidden", async () => {
    mockFetchAiSessions.mockResolvedValue([
      session(),
      session({ id: "session-archived", title: "Archived session", archived: true }),
    ]);
    renderPlanning();

    /*
    FNXC:PlanningSessionRowActions 2026-09-17-03:18:
    FN-486 : Renommer et Supprimer restent offerts, mais par le menu contextuel de la ligne. Le contrôle
    NÉGATIF de FN-465 est intact : aucune commande d'archivage, ni en ligne ni dans ce menu.
    */
    const row = (await screen.findByText("Completed session")).closest(".planning-sidebar-item") as HTMLElement;
    fireEvent.contextMenu(row.querySelector(".planning-sidebar-item-button") as HTMLElement, { clientX: 10, clientY: 10 });
    const menu = screen.getByTestId("planning-session-context-menu");
    expect(within(menu).getByTestId("planning-session-menu-rename")).toBeInTheDocument();
    expect(within(menu).getByTestId("planning-session-menu-delete")).toBeInTheDocument();
    expect(within(menu).queryByText(/archive/i)).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Archived session")).toBeNull();
    expectNoArchiveAffordance();
  });

  it("renders no archive affordance on mobile", async () => {
    mockViewportMode.mockReturnValue("mobile");
    renderPlanning();
    await screen.findByText("Completed session");

    expectNoArchiveAffordance();
  });

  it("requests the session list without archived rows and never calls the archive API", async () => {
    renderPlanning();
    await waitFor(() => expect(mockFetchAiSessions).toHaveBeenCalled());

    for (const call of mockFetchAiSessions.mock.calls) {
      expect((call[1] as { includeArchived?: boolean } | undefined)?.includeArchived).toBe(false);
    }
    expect(mockArchiveAiSession).not.toHaveBeenCalled();
    expect(mockUnarchiveAiSession).not.toHaveBeenCalled();
  });

  it("leaves no empty action shell when the list is empty", async () => {
    mockFetchAiSessions.mockResolvedValue([]);
    renderPlanning();
    await screen.findByText("No saved sessions yet. Start one on the right to see it here.");

    expect(document.querySelectorAll(".planning-sidebar-item-actions")).toHaveLength(0);
    expectNoArchiveAffordance();
  });
});
