// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanningDrawer } from "../MobileDrawer";
import { MainContentDrawer } from "../dashboard/MainContent";
import { PlanningModeModal } from "../PlanningModeModal";
import { MissionManager } from "../MissionManager";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { mockFetchAiSession, mockFetchAiSessions, mockTasks } from "./PlanningModeModal.test-helpers";
import { LIST_ITEM_LONG_PRESS_DELAY_MS } from "../../utils/listItemGesture";

/*
FNXC:MobileDrawerGesture 2026-09-17-03:18:
FN-486 — REPRODUCTION du symptôme d'origine, sur les VRAIS composants montés dans leurs vrais ponts de
tiroir. Avant ce correctif, tirer vers le bas depuis une ligne Planning ou Missions déjà au sommet ne
fermait pas le tiroir, parce que `isEligibleStart` refusait tout `button`/`[role='button']` — alors qu'un
message Mailbox ordinaire, rendu en `div`, passait. Ces cas exercent la voie tactile native complète
(touchstart/touchmove/touchend) et prouvent aussi que les trois gestes restent exclusifs : défilement natif,
fermeture unique, et menu par appui long, sans mutation ni sélection accidentelle.
*/

const mockViewportMode = vi.hoisted(() => vi.fn(() => "mobile" as "desktop" | "tablet" | "mobile"));
const mockFetchMissions = vi.hoisted(() => vi.fn());
const mockFetchMission = vi.hoisted(() => vi.fn());
const mockFetchMissionsHealth = vi.hoisted(() => vi.fn());
const mockFetchMissionInterviewDrafts = vi.hoisted(() => vi.fn());
const mockDeleteAiSession = vi.hoisted(() => vi.fn());
const mockDeleteMission = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useViewportMode", () => ({ MOBILE_MEDIA_QUERY: "(max-width: 768px)", isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => mockViewportMode(), isMobileViewport: () => mockViewportMode() === "mobile", isTabletTouchViewport: (mode?: string) => mode === "tablet", useViewportMode: () => mockViewportMode() }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));
vi.mock("../MissionInterviewModal", () => ({ MissionInterviewModal: () => null }));
vi.mock("../MilestoneSliceInterviewModal", () => ({ MilestoneSliceInterviewModal: () => null }));
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  const fn = vi.fn;
  return {
    ...actual,
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    deleteAiSession: (...args: unknown[]) => mockDeleteAiSession(...args),
    cancelPlanning: fn().mockResolvedValue(undefined),
    updatePlanningSessionTitle: fn().mockResolvedValue({ success: true }),
    fetchMissions: (...args: unknown[]) => mockFetchMissions(...args),
    fetchMission: (...args: unknown[]) => mockFetchMission(...args),
    fetchMissionsHealth: (...args: unknown[]) => mockFetchMissionsHealth(...args),
    fetchMissionInterviewDrafts: (...args: unknown[]) => mockFetchMissionInterviewDrafts(...args),
    deleteMission: (...args: unknown[]) => mockDeleteMission(...args),
    fetchSettings: fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
    fetchGlobalSettings: fn().mockResolvedValue({}),
    fetchModels: fn().mockResolvedValue([]),
    fetchWorkflowSteps: fn().mockResolvedValue([]),
    fetchBoardWorkflows: fn().mockResolvedValue({ workflows: [] }),
  };
});

const stamps = { createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" };
const session = { id: "session-1", title: "Session tiroir", projectId: "project-1", type: "planning", status: "complete", archived: false, conversationHistory: "[]", thinkingOutput: "", ...stamps };
const mission = { id: "M-1", title: "Mission tiroir", description: "", status: "active", interviewState: "completed", ...stamps, milestones: [], summary: { totalMilestones: 0, totalFeatures: 0, completedMilestones: 0, completedFeatures: 0, progressPercent: 0 } };

/** Émet un geste tactile natif complet sur la cible, exactement comme la voie non passive du hook. */
function touch(target: EventTarget, type: "touchstart" | "touchmove" | "touchend", x: number, y: number, identifier = 3): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  const point = { identifier, clientX: x, clientY: y, target } as Touch;
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : [point] },
    changedTouches: { value: [point] },
  });
  target.dispatchEvent(event);
  return event;
}

function panel(testId: string): HTMLElement {
  const node = screen.getByTestId(testId).querySelector(".mobile-drawer__panel") as HTMLElement;
  vi.spyOn(node, "getBoundingClientRect").mockReturnValue({ height: 400 } as DOMRect);
  return node;
}

/** Tire vers le bas depuis la cible, au-delà du seuil de distance du tiroir. */
function dragDown(target: Element, distance = 140) {
  touch(target, "touchstart", 0, 10);
  touch(document, "touchmove", 0, 10 + distance);
  touch(document, "touchend", 0, 10 + distance);
}

function renderPlanningDrawer(onClose: () => void) {
  return render(
    <PlanningDrawer open title="Planning" onClose={onClose}>
      <PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" presentation="embedded" />
    </PlanningDrawer>,
  );
}

function renderMissionsDrawer(onClose: () => void) {
  return render(
    <ConfirmDialogProvider>
      <MainContentDrawer taskView="missions" open title="Missions" onClose={onClose}>
        <MissionManager isInline isOpen onClose={vi.fn()} addToast={vi.fn()} projectId="project-1" />
      </MainContentDrawer>
    </ConfirmDialogProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockViewportMode.mockReturnValue("mobile");
  document.documentElement.setAttribute("data-mobile-drawers", "true");
  mockFetchAiSession.mockResolvedValue(null);
  mockFetchAiSessions.mockResolvedValue([session]);
  mockDeleteAiSession.mockResolvedValue(undefined);
  mockFetchMissions.mockResolvedValue([mission]);
  mockFetchMission.mockResolvedValue(mission);
  mockFetchMissionsHealth.mockResolvedValue({});
  mockFetchMissionInterviewDrafts.mockResolvedValue([]);
  mockDeleteMission.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-mobile-drawers");
  vi.restoreAllMocks();
});

describe("Les lignes de liste ne confisquent plus la fermeture du tiroir", () => {
  it.each([
    ["le texte de la ligne", (root: HTMLElement) => within(root).getByText("Session tiroir")],
    ["l'espace de la ligne", (root: HTMLElement) => root.querySelector(".planning-sidebar-item-button") as HTMLElement],
    ["le pictogramme de statut", (root: HTMLElement) => root.querySelector(".planning-sidebar-item-button svg") as HTMLElement],
  ])("ferme le tiroir Planning exactement une fois depuis %s", async (_label, pick) => {
    const onClose = vi.fn();
    renderPlanningDrawer(onClose);
    const root = await screen.findByTestId("mobile-drawer-planning");
    await within(root).findByText("Session tiroir");
    panel("mobile-drawer-planning");

    dragDown(pick(root));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("planning-session-context-menu")).toBeNull();
    expect(mockFetchAiSession).not.toHaveBeenCalled();
    expect(mockDeleteAiSession).not.toHaveBeenCalled();
  });

  it("ferme le tiroir Missions exactement une fois depuis une ligne de mission", async () => {
    const onClose = vi.fn();
    renderMissionsDrawer(onClose);
    const root = await screen.findByTestId("mobile-drawer-main-content");
    await within(root).findByText("Mission tiroir");
    panel("mobile-drawer-main-content");

    dragDown(within(root).getByText("Mission tiroir"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("mission-row-context-menu")).toBeNull();
    expect(mockFetchMission).not.toHaveBeenCalled();
    expect(mockDeleteMission).not.toHaveBeenCalled();
  });

  it("laisse le geste natif au contenu déjà défilé et le récupère au geste suivant", async () => {
    const onClose = vi.fn();
    renderPlanningDrawer(onClose);
    const root = await screen.findByTestId("mobile-drawer-planning");
    await within(root).findByText("Session tiroir");
    panel("mobile-drawer-planning");
    const row = within(root).getByText("Session tiroir");
    const scroller = row.closest(".planning-sidebar-list") as HTMLElement;

    scroller.scrollTop = 12;
    dragDown(row);
    expect(onClose).not.toHaveBeenCalled();

    scroller.scrollTop = 0;
    dragDown(row);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /* Un tap simple et un mouvement montant restent natifs ; seul un tiré descendant peut fermer. */
  it.each([
    ["montant", -160],
    ["nul (tap simple)", 0],
  ])("ne ferme pas sur un mouvement %s", async (_label, delta) => {
    const onClose = vi.fn();
    renderPlanningDrawer(onClose);
    const root = await screen.findByTestId("mobile-drawer-planning");
    await within(root).findByText("Session tiroir");
    panel("mobile-drawer-planning");

    const row = within(root).getByText("Session tiroir");
    touch(row, "touchstart", 0, 200);
    touch(document, "touchmove", 0, 200 + delta);
    touch(document, "touchend", 0, 200 + delta);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("laisse le champ de renommage entièrement natif sous une ligne qualifiée", async () => {
    const onClose = vi.fn();
    renderPlanningDrawer(onClose);
    const root = await screen.findByTestId("mobile-drawer-planning");
    await within(root).findByText("Session tiroir");
    panel("mobile-drawer-planning");

    fireEvent.contextMenu(root.querySelector(".planning-sidebar-item-button") as HTMLElement, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("planning-session-menu-rename"));
    const input = screen.getByRole("textbox", { name: "Rename session" });

    dragDown(input);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Appui long et fermeture sont deux ordonnancements exclusifs", () => {
  it("ouvre un menu seul, sans fermeture ni sélection, puis exécute l'action une seule fois", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onClose = vi.fn();
      renderMissionsDrawer(onClose);
      const root = await screen.findByTestId("mobile-drawer-main-content");
      await within(root).findByText("Mission tiroir");
      panel("mobile-drawer-main-content");
      const row = within(root).getByText("Mission tiroir").closest(".mission-list__item") as HTMLElement;

      fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 9, isPrimary: true, clientX: 12, clientY: 12 });
      act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS); });
      const menu = screen.getByTestId("mission-row-context-menu");
      expect(onClose).not.toHaveBeenCalled();
      expect(mockFetchMission).not.toHaveBeenCalled();

      fireEvent.pointerUp(row, { pointerType: "touch", pointerId: 9 });
      fireEvent.click(row);
      expect(mockFetchMission).not.toHaveBeenCalled();

      fireEvent.click(within(menu).getByTestId("mission-menu-stop-M-1"));
      await waitFor(() => expect(screen.queryByTestId("mission-row-context-menu")).toBeNull());
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("annule l'appui long dès que le geste de fermeture prend la main", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onClose = vi.fn();
      renderMissionsDrawer(onClose);
      const root = await screen.findByTestId("mobile-drawer-main-content");
      await within(root).findByText("Mission tiroir");
      panel("mobile-drawer-main-content");
      const row = within(root).getByText("Mission tiroir").closest(".mission-list__item") as HTMLElement;

      fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 4, isPrimary: true, clientX: 0, clientY: 10 });
      touch(row, "touchstart", 0, 10);
      fireEvent.pointerMove(row, { pointerType: "touch", pointerId: 4, clientX: 0, clientY: 150 });
      touch(document, "touchmove", 0, 150);
      act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS * 2); });
      expect(screen.queryByTestId("mission-row-context-menu")).toBeNull();

      touch(document, "touchend", 0, 150);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ne laisse survivre ni menu ni minuterie quand le tiroir se ferme", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender } = render(
        <ConfirmDialogProvider>
          <MainContentDrawer taskView="missions" open title="Missions" onClose={vi.fn()}>
            <MissionManager isInline isOpen onClose={vi.fn()} addToast={vi.fn()} projectId="project-1" />
          </MainContentDrawer>
        </ConfirmDialogProvider>,
      );
      const root = await screen.findByTestId("mobile-drawer-main-content");
      await within(root).findByText("Mission tiroir");
      const row = within(root).getByText("Mission tiroir").closest(".mission-list__item") as HTMLElement;
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
      expect(screen.getByTestId("mission-row-context-menu")).toBeInTheDocument();

      rerender(
        <ConfirmDialogProvider>
          <MainContentDrawer taskView="missions" open={false} title="Missions" onClose={vi.fn()}>
            <MissionManager isInline isOpen={false} onClose={vi.fn()} addToast={vi.fn()} projectId="project-1" />
          </MainContentDrawer>
        </ConfirmDialogProvider>,
      );
      await waitFor(() => expect(screen.queryByTestId("mission-row-context-menu")).toBeNull());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
