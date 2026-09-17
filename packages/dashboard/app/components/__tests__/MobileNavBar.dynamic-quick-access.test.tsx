/**
 * FN-468 — Accès rapide dynamique de la pill de navigation.
 *
 * L'opérateur demande que la pill « fasse apparaître au fur et à mesure qu'il y a de l'espace » des raccourcis
 * supplémentaires, sans jamais être surchargée et sans qu'une destination soit rendue deux fois. Ces cas pilotent la
 * largeur mesurée explicitement (jsdom ne calcule aucune géométrie) et couvrent l'énumération de surfaces du plan :
 * largeur absente, largeur étroite, largeur tablette, très grande largeur, destination indisponible, badges, union
 * rangée/menu et hauteur publiée.
 */

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { fetchScripts } from "../../api";
import {
  computeMobileNavDirectDestinationCount,
  MAX_MOBILE_NAV_DIRECT_DESTINATIONS,
  MOBILE_NAV_DIRECT_SLOT_FALLBACK_WIDTH,
  MOBILE_NAV_DYNAMIC_PROMOTION_ORDER,
  MobileNavBar,
} from "../MobileNavBar";
import { MOBILE_MEDIA_QUERY, TABLET_MEDIA_QUERY } from "../../hooks/useViewportMode";

vi.mock("../../api", () => ({ fetchScripts: vi.fn() }));

const SLOT_WIDTH = MOBILE_NAV_DIRECT_SLOT_FALLBACK_WIDTH;

function mockViewport(mode: "mobile" | "tablet" | "desktop") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mode === "tablet"
        ? query === TABLET_MEDIA_QUERY
        : mode === "mobile" && (query === MOBILE_MEDIA_QUERY || query.includes("max-width: 768px")),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

/**
 * jsdom renvoie une largeur nulle pour tout élément. Cette assiette installe une largeur de pill mesurable et
 * déclenche le `ResizeObserver` déjà installé par le composant — aucun second observateur n'est introduit.
 */
const resizeObserverCallbacks = new Set<ResizeObserverCallback>();

class TestResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverCallbacks.add(this.callback);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    resizeObserverCallbacks.delete(this.callback);
  }
}

let pillWidth = 0;

function setPillWidth(width: number): void {
  act(() => {
    pillWidth = width;
    for (const callback of [...resizeObserverCallbacks]) {
      callback([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    }
  });
}

function createDefaultProps() {
  return {
    view: "board" as const,
    onChangeView: vi.fn(),
    footerVisible: false,
    onOpenSettings: vi.fn(),
    onOpenActivityLog: vi.fn(),
    onOpenMailbox: vi.fn(),
    onOpenGitManager: vi.fn(),
    onOpenWorkflowEditor: vi.fn(),
    onOpenSchedules: vi.fn(),
    onOpenScripts: vi.fn(),
    onToggleTerminal: vi.fn(),
    onOpenFiles: vi.fn(),
    onOpenGitHubImport: vi.fn(),
    onOpenPlanning: vi.fn(),
    onResumePlanning: vi.fn(),
    activePlanningSessionCount: 0,
    onOpenUsage: vi.fn(),
    onViewAllProjects: vi.fn(),
    onRunScript: vi.fn(),
    projectId: "project-1",
  };
}

function PillShell(props: Partial<React.ComponentProps<typeof MobileNavBar>> = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <MobileNavBar {...createDefaultProps()} {...props} navigationMenuOpen={menuOpen} onUiMenuOpenChange={setMenuOpen} />;
}

function directItems(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".mobile-nav-bar--native > .mobile-nav-tab"),
    (tab) => (tab.dataset.testid ?? "").replace("mobile-nav-tab-", ""),
  );
}

/*
 * Deux entrées de menu portent un identifiant de test historique différent de leur identifiant de destination
 * (`workflows` → `workflow`, `automation` → `schedules`). La normalisation vit ici, dans le test, pour ne pas
 * toucher aux identifiants publics sur lesquels d'autres suites s'appuient.
 */
const MENU_TEST_ID_ALIASES: Record<string, string> = { workflow: "workflows", schedules: "automation", github: "github-import" };

function menuItems(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".mobile-more-item"), (item) => {
    const suffix = (item.dataset.testid ?? "").replace("mobile-more-item-", "");
    return MENU_TEST_ID_ALIASES[suffix] ?? suffix;
  });
}

/*
 * FN-495 : la rangée de base vaut désormais QUATRE destinations plus « Plus ». Le cinquième créneau du pied de page
 * appartient au Chat, qui n'est pas configurable : `mailbox` quitte le défaut et redevient une entrée du menu.
 */
const BASE_ROW = ["command-center", "tasks", "planning", "missions"];

describe("MobileNavBar dynamic quick access", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    mockViewport("mobile");
    vi.mocked(fetchScripts).mockReset();
    vi.mocked(fetchScripts).mockResolvedValue({});
    pillWidth = 0;
    resizeObserverCallbacks.clear();
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
      const width = this.classList.contains("mobile-nav-bar") ? pillWidth : 0;
      return { width, height: 44, top: 0, left: 0, right: width, bottom: 44, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    document.documentElement.style.removeProperty("--mobile-nav-height");
    document.documentElement.style.removeProperty("--mobile-nav-pill-height");
  });

  // Cas (m) : largeur mesurée nulle ou non finie → exactement la rangée de base plus le déclencheur.
  it("renders exactly the resolved quick-access row when no width is measured", () => {
    const { container, unmount } = render(<PillShell />);

    expect(directItems()).toEqual(BASE_ROW);
    expect(screen.getByTestId("mobile-menu-trigger")).toBeDefined();
    const pill = container.querySelector<HTMLElement>(".mobile-nav-bar--native")!;
    expect(pill.lastElementChild).toBe(screen.getByTestId("mobile-menu-trigger"));
    // MobileNavBar reste le seul producteur d'onglets de pill.
    expect(document.querySelectorAll(".mobile-nav-tab").length).toBe(BASE_ROW.length);
    unmount();

    // Une largeur non finie est traitée comme une absence de mesure.
    render(<PillShell />);
    setPillWidth(Number.NaN);
    expect(directItems()).toEqual(BASE_ROW);
  });

  /*
  Cas (n) : à 375px la rangée reste la rangée de base ; après élargissement à 1000px puis retour à 375px, elle
  revient exactement à la rangée de base, sans bouton orphelin, le déclencheur restant dernier enfant.
  */
  it("expands with the available width and returns to the base row when it shrinks back", () => {
    const { container } = render(<PillShell />);
    setPillWidth(375);
    expect(directItems()).toEqual(BASE_ROW);

    setPillWidth(1000);
    const expanded = directItems();
    expect(expanded.length).toBeGreaterThan(BASE_ROW.length);
    expect(expanded.slice(0, BASE_ROW.length)).toEqual(BASE_ROW);

    setPillWidth(375);
    expect(directItems()).toEqual(BASE_ROW);
    const pill = container.querySelector<HTMLElement>(".mobile-nav-bar--native")!;
    expect(pill.lastElementChild).toBe(screen.getByTestId("mobile-menu-trigger"));
    expect(Array.from(pill.children).filter((child) => !child.textContent && !child.querySelector("svg"))).toHaveLength(0);
  });

  // Cas (o) : la rangée persistée réordonnée est conservée telle quelle, les extras arrivent APRÈS, dans l'ordre de promotion.
  it("keeps the persisted order first and appends promoted destinations in the documented order", () => {
    render(<PillShell quickAccessItems={["mailbox", "planning"]} />);
    setPillWidth(1000);

    const rendered = directItems();
    expect(rendered.slice(0, 2)).toEqual(["mailbox", "planning"]);
    const extras = rendered.slice(2);
    const expectedExtras = MOBILE_NAV_DYNAMIC_PROMOTION_ORDER
      .filter((item) => !["mailbox", "planning"].includes(item))
      .slice(0, extras.length);
    expect(extras).toEqual(expectedExtras);
  });

  // Cas (p) : le plafond « ne pas surcharger le menu flottant » est respecté même à très grande largeur.
  it("never exceeds the direct-destination ceiling at very large widths", () => {
    render(<PillShell />);
    setPillWidth(10000);
    expect(directItems().length).toBe(MAX_MOBILE_NAV_DIRECT_DESTINATIONS);
  });

  // Cas (q) : une destination promue mais indisponible est ignorée, sans bouton vide ni aria-label orphelin.
  it("skips a promoted destination whose experimental flag is disabled", () => {
    render(<PillShell experimentalFeatures={{ insights: false, memoryView: false, researchView: false, evalsView: false, goalsView: false, devServerView: false, whiteboardView: false }} />);
    setPillWidth(10000);

    const rendered = directItems();
    expect(rendered).not.toContain("insights");
    expect(rendered).not.toContain("memory");
    expect(rendered.every((item) => item.length > 0)).toBe(true);
    const tabs = Array.from(document.querySelectorAll<HTMLElement>(".mobile-nav-bar--native > .mobile-nav-tab"));
    expect(tabs.every((tab) => (tab.getAttribute("aria-label") ?? "").length > 0 && tab.querySelector("svg"))).toBe(true);
    expect(menuItems()).not.toContain("insights");
  });

  // Cas (r) : badges et pastilles restent rendus à l'identique dans la rangée élargie.
  it("keeps badges and status dots in the expanded row", () => {
    render(<PillShell mailboxUnreadCount={4} mailboxPendingApprovalCount={2} planningNeedsInput activePlanningSessionCount={3} view="board" />);
    setPillWidth(1000);

    const mailboxTab = screen.getByTestId("mobile-nav-tab-mailbox");
    expect(mailboxTab.querySelector(".mobile-nav-tab-badge")?.textContent).toBe("4");
    expect(mailboxTab.querySelector(".status-dot")).not.toBeNull();
    const planningTab = screen.getByTestId("mobile-nav-tab-planning");
    expect(planningTab.querySelector(".mobile-nav-tab-badge")?.textContent).toBe("3");
    expect(planningTab.querySelector(".status-dot")).not.toBeNull();
  });

  /*
  Cas (s) : à trois largeurs, l'union « rangée directe ∪ menu » couvre toutes les destinations disponibles, leur
  intersection est vide, et l'état actif du déclencheur suit la répartition.
  */
  it("splits every available destination between the row and the menu without overlap", () => {
    render(<PillShell view="notes" />);

    for (const width of [375, 1000, 1400]) {
      setPillWidth(width);
      fireEvent.click(screen.getByTestId("mobile-menu-trigger"));

      const direct = directItems();
      const menu = menuItems();
      expect(direct.filter((item) => menu.includes(item)), `overlap@${width}`).toEqual([]);
      /*
       * L'union couvre toutes les destinations disponibles : chaque destination de base et chaque candidat de
       * promotion est atteignable exactement une fois, dans la rangée OU dans le menu.
       */
      for (const item of [...BASE_ROW, ...MOBILE_NAV_DYNAMIC_PROMOTION_ORDER]) {
        expect(direct.includes(item) || menu.includes(item), `${item} reachable@${width}`).toBe(true);
      }
      /* L'état actif suit la répartition : la vue active ne porte `--active` que lorsqu'elle est dans la rangée. */
      const notesIsDirect = direct.includes("notes");
      if (notesIsDirect) {
        expect(screen.getByTestId("mobile-nav-tab-notes").className, `direct active@${width}`).toContain("mobile-nav-tab--active");
      } else {
        expect(document.querySelector(".mobile-nav-tab--active"), `no direct active@${width}`).toBeNull();
        expect(menu, `notes in menu@${width}`).toContain("notes");
      }

      fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    }
  });

  // Cas (t) : la hauteur publiée reste cohérente quand le nombre d'onglets change.
  it("keeps the published navigation height consistent as the tab count changes", () => {
    render(<PillShell />);
    setPillWidth(375);
    const narrowHeight = document.documentElement.style.getPropertyValue("--mobile-nav-height");
    expect(narrowHeight).not.toBe("");

    setPillWidth(1400);
    expect(directItems().length).toBeGreaterThan(BASE_ROW.length);
    expect(document.documentElement.style.getPropertyValue("--mobile-nav-height")).toBe(narrowHeight);
    expect(document.documentElement.style.getPropertyValue("--mobile-nav-pill-height")).not.toBe("");
  });

  /*
   * FN-480 cas (c) : le premier candidat de l'ordre de promotion reste `tasks`, mais sur mobile ce slot rend et route
   * **List** (le Board étant la surface de fond permanente). La promotion doit donc produire un onglet qui ouvre la
   * liste, jamais le Board.
   */
  it("promotes the quick-access `tasks` slot as a List shortcut", () => {
    const props = createDefaultProps();
    render(<PillShell {...props} quickAccessItems={["mailbox", "planning"]} />);
    setPillWidth(1000);

    expect(MOBILE_NAV_DYNAMIC_PROMOTION_ORDER[0]).toBe("tasks");
    const promoted = screen.getByTestId("mobile-nav-tab-tasks");
    expect(directItems()).toContain("tasks");
    expect(promoted).toHaveAttribute("aria-label", "List");

    fireEvent.click(promoted);
    expect(props.onChangeView).toHaveBeenCalledWith("list");
    expect(props.onChangeView).not.toHaveBeenCalledWith("board");
  });

  it("expands the row on tablet widths too", () => {
    mockViewport("tablet");
    render(<PillShell />);
    setPillWidth(1000);
    expect(directItems().length).toBeGreaterThan(BASE_ROW.length);
  });

  /*
  FNXC:HeaderNavigationOwnership 2026-09-17-02:14:
  FN-481 : le filtre de propriété du Header précède le comptage et la troncature, donc une destination possédée en
  haut ne consomme aucun créneau à aucune largeur mesurée — y compris aux largeurs où elle serait normalement
  promue. jsdom ne calcule aucune géométrie : ces cas pilotent explicitement la largeur de la pill.
  */
  it.each([0, 375, 1000, 1400])("n'offre jamais une destination possédée par le Header à la largeur %i", (width) => {
    mockViewport("tablet");
    const owned = ["usage", "projects", "notes", "activity"];
    render(<PillShell headerOwnedItems={owned} />);
    if (width > 0) setPillWidth(width);

    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    const direct = directItems();
    const menu = menuItems();
    for (const item of owned) {
      expect(direct, `rangée@${width}`).not.toContain(item);
      expect(menu, `menu@${width}`).not.toContain(item);
    }
    /* Toutes les autres destinations restent atteignables exactement une fois. */
    for (const item of [...BASE_ROW, ...MOBILE_NAV_DYNAMIC_PROMOTION_ORDER].filter((item) => !owned.includes(item))) {
      expect(direct.includes(item) || menu.includes(item), `${item}@${width}`).toBe(true);
    }
    expect(direct.filter((item) => menu.includes(item))).toEqual([]);
  });

  it("promeut une destination supplémentaire à la place d'un accès retiré, sans dépasser le plafond", () => {
    render(<PillShell headerOwnedItems={["usage", "projects", "notes", "activity"]} />);
    setPillWidth(1400);

    const direct = directItems();
    expect(direct.length).toBeLessThanOrEqual(MAX_MOBILE_NAV_DIRECT_DESTINATIONS);
    expect(direct.slice(0, BASE_ROW.length)).toEqual(BASE_ROW);
    for (const item of ["usage", "projects", "notes", "activity"]) {
      expect(direct).not.toContain(item);
    }
  });
});

describe("computeMobileNavDirectDestinationCount", () => {
  const base = { baseCount: 5, maxCount: MAX_MOBILE_NAV_DIRECT_DESTINATIONS };

  it("falls back to the base row for absent, zero, negative, or non-finite widths", () => {
    for (const availableWidth of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(computeMobileNavDirectDestinationCount({ ...base, availableWidth, slotWidth: SLOT_WIDTH })).toBe(5);
    }
    for (const slotWidth of [0, -10, Number.NaN]) {
      expect(computeMobileNavDirectDestinationCount({ ...base, availableWidth: 1000, slotWidth })).toBe(5);
    }
  });

  it("never returns fewer destinations than the base row", () => {
    expect(computeMobileNavDirectDestinationCount({ ...base, availableWidth: 120, slotWidth: SLOT_WIDTH })).toBe(5);
  });

  it("returns the measured capacity minus one slot reserved for the menu trigger", () => {
    // 7 créneaux tiennent, un est réservé au déclencheur → 6 destinations directes.
    expect(computeMobileNavDirectDestinationCount({ ...base, availableWidth: SLOT_WIDTH * 7, slotWidth: SLOT_WIDTH })).toBe(6);
  });

  it("clamps to the ceiling on very wide viewports", () => {
    expect(computeMobileNavDirectDestinationCount({ ...base, availableWidth: SLOT_WIDTH * 100, slotWidth: SLOT_WIDTH }))
      .toBe(MAX_MOBILE_NAV_DIRECT_DESTINATIONS);
  });

  it("keeps a base row larger than the ceiling intact rather than truncating the operator's selection", () => {
    expect(computeMobileNavDirectDestinationCount({ availableWidth: 200, slotWidth: SLOT_WIDTH, baseCount: 9, maxCount: 8 })).toBe(9);
  });
});
