import { useCallback, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fetchScripts } from "../../api";
import { MobileNavBar } from "../MobileNavBar";
import { MOBILE_MEDIA_QUERY, TABLET_MEDIA_QUERY } from "../../hooks/useViewportMode";
import { LIST_ITEM_ROW_ATTRIBUTE, LIST_ITEM_ROW_SELECTOR } from "../../utils/listItemGesture";

/*
FNXC:MobileNavGesture 2026-09-18-00:54:
FN-520 : la liste de navigation mobile ouverte et déjà tout en haut se ferme désormais en la tirant vers le bas,
exactement comme les tiroirs du shell. Ces cas pilotent de VRAIS événements tactiles et pointeur pour prouver les
deux moitiés indissociables de l'invariant : la fermeture depuis le sommet, ET la préservation stricte du défilement
intérieur quand la liste est déjà défilée. Une suite verte sans ces deux preuves ne vaut pas acceptation.
*/

vi.mock("../../api", () => ({ fetchScripts: vi.fn() }));

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

const createDefaultProps = () => ({
  view: "board" as const,
  onChangeView: vi.fn(),
  footerVisible: false,
  onOpenSettings: vi.fn(),
  onOpenActivityLog: vi.fn(),
  onOpenGitManager: vi.fn(),
  onOpenWorkflowEditor: vi.fn(),
  onOpenSchedules: vi.fn(),
  onOpenScripts: vi.fn(),
  onToggleTerminal: vi.fn(),
  onOpenFiles: vi.fn(),
  onOpenGitHubImport: vi.fn(),
  onOpenPlanning: vi.fn(),
  onResumePlanning: vi.fn(),
  onOpenUsage: vi.fn(),
  onViewAllProjects: vi.fn(),
  onRunScript: vi.fn(),
  projectId: "project-1",
});

/*
 * Coquille contrôlée, reprise du harnais FN-511 : `navigationMenuOpen` est possédé par App en production, donc
 * reproduit ici par un état local avec un callback STABLE — une identité recréée à chaque rendu refermerait le menu.
 */
function MobileShell(props: Partial<React.ComponentProps<typeof MobileNavBar>> & { onMenuOpenChange?: (open: boolean) => void } = {}) {
  const { onMenuOpenChange, ...rest } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const observerRef = useRef(onMenuOpenChange);
  observerRef.current = onMenuOpenChange;
  const handleMenuOpenChange = useCallback((open: boolean) => {
    observerRef.current?.(open);
    setMenuOpen(open);
  }, []);
  return <MobileNavBar
    {...createDefaultProps()}
    {...rest}
    navigationMenuOpen={menuOpen}
    onUiMenuOpenChange={handleMenuOpenChange}
  />;
}

function dispatchTouch(target: EventTarget, type: "touchstart" | "touchmove" | "touchend" | "touchcancel", x: number, y: number, timeStamp: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  const touch = { identifier: 7, clientX: x, clientY: y, target } as Touch;
  Object.defineProperties(event, {
    touches: { value: type === "touchstart" || type === "touchmove" ? [touch] : [] },
    changedTouches: { value: [touch] },
    timeStamp: { value: timeStamp },
  });
  target.dispatchEvent(event);
  return event;
}

function menuSurface(): HTMLElement {
  return screen.getByRole("menu", { name: "Navigate" });
}

function queryMenuSurface(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".mobile-navigation-popover");
}

/**
 * En jsdom la hauteur d'un panneau vaut `0`, donc le critère de DISTANCE (`offset >= hauteur * 0.25`) serait
 * satisfait par n'importe quel micro-glissement et le cas « glissement trop court » passerait au vert par accident.
 * On simule donc une hauteur de panneau réaliste avant tout scénario de seuil.
 */
function stubPanelHeight(height: number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 360, bottom: height, width: 360, height,
    toJSON: () => ({}),
  } as DOMRect);
}

/** Ouvre le menu par le hamburger (option de geste désactivée). */
function openByTrigger(): void {
  act(() => { screen.getByTestId("mobile-menu-trigger").click(); });
}

/** Ouvre le menu par le glissement ascendant du pied de page (option de geste activée). */
function openByFooterSwipe(container: HTMLElement): void {
  const nav = container.querySelector<HTMLElement>(".mobile-nav-bar--native")!;
  act(() => {
    dispatchTouch(nav, "touchstart", 40, 300, 0);
    dispatchTouch(document, "touchmove", 40, 180, 400);
    dispatchTouch(document, "touchend", 40, 180, 400);
  });
}

interface DragResult {
  moveDefaultPrevented: boolean;
  transformDuringDrag: string;
}

/**
 * Glissement tactile réel depuis une ligne du menu. Les mises à jour d'état React déclenchées par la fermeture
 * sont émises dans `act`, et le `transform` est lu PENDANT le glissement (le hook nettoie avant le callback).
 */
function dragFrom(row: Element, deltaY: number, { deltaX = 0, durationMs = 400, end = "touchend" as "touchend" | "touchcancel" } = {}): DragResult {
  const startY = 200;
  const startX = 40;
  let moveDefaultPrevented = false;
  let transformDuringDrag = "";
  act(() => {
    dispatchTouch(row, "touchstart", startX, startY, 0);
    const move = dispatchTouch(document, "touchmove", startX + deltaX, startY + deltaY, durationMs);
    moveDefaultPrevented = move.defaultPrevented;
    transformDuringDrag = queryMenuSurface()?.style.transform ?? "";
    dispatchTouch(document, end, startX + deltaX, startY + deltaY, durationMs);
  });
  return { moveDefaultPrevented, transformDuringDrag };
}

describe("MobileNavBar ferme la liste de navigation en la tirant vers le bas depuis son sommet", () => {
  beforeEach(() => {
    mockViewport("mobile");
    vi.mocked(fetchScripts).mockReset();
    vi.mocked(fetchScripts).mockResolvedValue({});
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    /*
     * jsdom planifie `requestAnimationFrame` sur une minuterie, donc la peinture du suivi n'aurait pas encore eu lieu
     * au moment où le cas lit le `transform`. On l'exécute donc de façon synchrone pour observer l'état réel du geste.
     */
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /*
   * (1) REPRODUCTION DU SYMPTÔME et sa disparition : menu ouvert par le hamburger, surface à `scrollTop === 0`,
   * glissement descendant depuis une entrée. Avant correction le `touchmove` n'était pas annulé, aucun `transform`
   * n'était appliqué et le menu restait ouvert — le geste « défilait dans le vide ».
   */
  it("ferme le menu ouvert par le hamburger quand on le tire vers le bas depuis son sommet", () => {
    const onMenuOpenChange = vi.fn();
    render(<MobileShell onMenuOpenChange={onMenuOpenChange} />);
    openByTrigger();
    const surface = menuSurface();
    expect(surface.scrollTop).toBe(0);
    stubPanelHeight(400);
    /* Le montage synchronise déjà une fermeture (`false`) : on ne conserve que les appels PROVOQUÉS par le geste. */
    onMenuOpenChange.mockClear();

    const { moveDefaultPrevented, transformDuringDrag } = dragFrom(screen.getByTestId("mobile-more-item-agents"), 140);

    expect(moveDefaultPrevented).toBe(true);
    expect(transformDuringDrag).toContain("translate3d(0, 140px, 0)");
    expect(queryMenuSurface()).toBeNull();
    expect(screen.queryByRole("menu", { name: "Navigate" })).toBeNull();
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
  });

  /* (2) Même fermeture quand le menu a été ouvert par le glissement ascendant du pied de page (mode tiroir). */
  it("ferme le menu ouvert par le glissement du pied de page", () => {
    const onMenuOpenChange = vi.fn();
    const { container } = render(<MobileShell menuGestureEnabled onMenuOpenChange={onMenuOpenChange} />);
    openByFooterSwipe(container);
    const surface = menuSurface();
    expect(surface).toHaveClass("mobile-navigation-popover--footer-drawer");
    stubPanelHeight(400);
    onMenuOpenChange.mockClear();

    const { moveDefaultPrevented } = dragFrom(screen.getByTestId("mobile-more-item-agents"), 140);

    expect(moveDefaultPrevented).toBe(true);
    expect(queryMenuSurface()).toBeNull();
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
  });

  /* (3) Gabarits : la tablette monte la pill et ferme comme le téléphone ; l'ordinateur ne monte aucune surface. */
  it("ferme aussi en gabarit tablette et ne monte rien en gabarit ordinateur", () => {
    mockViewport("tablet");
    const tablet = render(<MobileShell />);
    openByTrigger();
    expect(menuSurface()).toBeInTheDocument();
    stubPanelHeight(400);
    expect(dragFrom(screen.getByTestId("mobile-more-item-agents"), 140).moveDefaultPrevented).toBe(true);
    expect(queryMenuSurface()).toBeNull();
    tablet.unmount();

    vi.restoreAllMocks();
    mockViewport("desktop");
    const { container } = render(<MobileShell />);
    expect(container.querySelector(".mobile-nav-bar--native")).toBeNull();
    expect(queryMenuSurface()).toBeNull();
  });

  /* (4) Clavier logiciel ouvert : le geste reste fonctionnel et l'ancrage géométrique n'est pas déplacé. */
  it("reste fonctionnel quand le clavier logiciel est ouvert, sans déplacer l'ancrage", () => {
    render(<MobileShell keyboardOpen keyboardMetrics={{ keyboardOverlap: 320, viewportHeight: 504, viewportOffsetTop: 0 }} />);
    openByTrigger();
    const anchorBefore = menuSurface().style.getPropertyValue("--mobile-nav-popover-bottom");
    expect(anchorBefore).not.toBe("");
    stubPanelHeight(400);

    const { moveDefaultPrevented } = dragFrom(screen.getByTestId("mobile-more-item-agents"), 140);

    expect(moveDefaultPrevented).toBe(true);
    expect(queryMenuSurface()).toBeNull();

    openByTrigger();
    expect(menuSurface().style.getPropertyValue("--mobile-nav-popover-bottom")).toBe(anchorBefore);
  });

  /* (5) CONTRE-PREUVE : une liste déjà défilée garde son défilement natif — le correctif ne confisque rien. */
  it("laisse une liste déjà défilée défiler normalement", () => {
    const onMenuOpenChange = vi.fn();
    render(<MobileShell onMenuOpenChange={onMenuOpenChange} />);
    openByTrigger();
    const surface = menuSurface();
    Object.defineProperty(surface, "scrollTop", { configurable: true, value: 120 });
    stubPanelHeight(400);
    /* Le montage synchronise déjà une fermeture (`false`) ; seule une fermeture PROVOQUÉE par le geste compte ici. */
    onMenuOpenChange.mockClear();

    const { moveDefaultPrevented, transformDuringDrag } = dragFrom(screen.getByTestId("mobile-more-item-agents"), 140);

    expect(moveDefaultPrevented).toBe(false);
    expect(transformDuringDrag).toBe("");
    expect(queryMenuSurface()).not.toBeNull();
    expect(onMenuOpenChange).not.toHaveBeenCalledWith(false);
  });

  /* (6) Sous-menu Scripts déplié : la fermeture reste possible depuis une ligne de script, au sommet. */
  it("ferme depuis une ligne de script quand le sous-menu est déplié", async () => {
    vi.mocked(fetchScripts).mockResolvedValue({ build: "pnpm build" });
    render(<MobileShell />);
    openByTrigger();
    fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));
    await waitFor(() => expect(screen.getByTestId("mobile-more-script-item-build")).toBeInTheDocument());
    stubPanelHeight(400);

    const { moveDefaultPrevented } = dragFrom(screen.getByTestId("mobile-more-script-item-build"), 140);

    expect(moveDefaultPrevented).toBe(true);
    expect(queryMenuSurface()).toBeNull();
  });

  /* (7) Glissement ascendant, horizontalement dominant, ou descendant trop court ET trop lent : rien ne se ferme. */
  it.each([
    ["ascendant", { deltaY: -140, deltaX: 0, durationMs: 400 }],
    ["horizontalement dominant", { deltaY: 30, deltaX: 200, durationMs: 400 }],
    ["trop court et trop lent", { deltaY: 40, deltaX: 0, durationMs: 400 }],
  ])("ne ferme pas pour un glissement %s", (_label, { deltaY, deltaX, durationMs }) => {
    const onMenuOpenChange = vi.fn();
    render(<MobileShell onMenuOpenChange={onMenuOpenChange} />);
    openByTrigger();
    stubPanelHeight(400);
    onMenuOpenChange.mockClear();

    dragFrom(screen.getByTestId("mobile-more-item-agents"), deltaY, { deltaX, durationMs });

    expect(queryMenuSurface()).not.toBeNull();
    expect(queryMenuSurface()?.style.transform ?? "").toBe("");
    expect(onMenuOpenChange).not.toHaveBeenCalledWith(false);
  });

  /* (8) Chemin pointeur/souris : les props étalées sur la surface ferment aussi le menu. */
  it("ferme le menu par le chemin pointeur", () => {
    const onMenuOpenChange = vi.fn();
    render(<MobileShell onMenuOpenChange={onMenuOpenChange} />);
    openByTrigger();
    const surface = menuSurface();
    stubPanelHeight(400);
    const row = screen.getByTestId("mobile-more-item-agents");

    act(() => {
      /* Le contact démarre sur la LIGNE ; l'événement remonte jusqu'aux props étalées sur la surface. */
      fireEvent.pointerDown(row, { pointerId: 3, clientX: 40, clientY: 200, button: 0, isPrimary: true, pointerType: "mouse" });
      fireEvent.pointerMove(surface, { pointerId: 3, clientX: 40, clientY: 340, pointerType: "mouse" });
      fireEvent.pointerUp(surface, { pointerId: 3, clientX: 40, clientY: 340, pointerType: "mouse" });
    });

    expect(queryMenuSurface()).toBeNull();
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
  });

  /* (9) Un appui simple sur une entrée navigue toujours et referme le menu par le chemin existant. */
  it("laisse un appui simple naviguer et refermer le menu", () => {
    const onChangeView = vi.fn();
    render(<MobileShell onChangeView={onChangeView} />);
    openByTrigger();
    const surface = menuSurface();
    const row = screen.getByTestId("mobile-more-item-agents");

    act(() => {
      fireEvent.pointerDown(row, { pointerId: 4, clientX: 40, clientY: 200, button: 0, isPrimary: true, pointerType: "mouse" });
      fireEvent.pointerUp(surface, { pointerId: 4, clientX: 40, clientY: 200, pointerType: "mouse" });
      row.click();
    });

    expect(onChangeView).toHaveBeenCalledWith("agents");
    expect(queryMenuSurface()).toBeNull();
  });

  /* (10) Menu fermé : aucune surface, aucun effet de bord, et le geste d'ouverture reste désarmé une fois ouvert. */
  it("n'a aucun effet quand le menu est fermé et n'entre jamais en conflit avec le geste d'ouverture", () => {
    const onMenuOpenChange = vi.fn();
    const { container } = render(<MobileShell menuGestureEnabled onMenuOpenChange={onMenuOpenChange} />);
    expect(queryMenuSurface()).toBeNull();
    onMenuOpenChange.mockClear();

    const idleMove = new Event("touchmove", { bubbles: true, cancelable: true });
    act(() => { document.dispatchEvent(idleMove); });
    expect(idleMove.defaultPrevented).toBe(false);
    expect(onMenuOpenChange).not.toHaveBeenCalledWith(false);

    openByFooterSwipe(container);
    expect(menuSurface()).toBeInTheDocument();
    onMenuOpenChange.mockClear();
    /* Le geste d'OUVERTURE est armé uniquement `!isMenuOpen` : il ne peut pas rouvrir ni relancer le propriétaire. */
    openByFooterSwipe(container);
    expect(onMenuOpenChange).not.toHaveBeenCalledWith(true);
  });

  /* (11) Liste réduite par la propriété du Header : le geste reste éligible depuis une zone non interactive. */
  it("reste éligible depuis le titre quand le Header possède des destinations", () => {
    render(<MobileShell headerOwnedItems={["agents", "missions", "notes", "secrets"]} />);
    openByTrigger();
    const surface = menuSurface();
    expect(surface.querySelector('[data-testid="mobile-more-item-agents"]')).toBeNull();
    const title = surface.querySelector<HTMLElement>(".mobile-more-sheet-title")!;
    stubPanelHeight(400);

    const { moveDefaultPrevented } = dragFrom(title, 140);

    expect(moveDefaultPrevented).toBe(true);
    expect(queryMenuSurface()).toBeNull();
  });

  /* (13) Aucune coquille résiduelle : ni `transform`, ni `will-change`, ni `overscroll-behavior` en ligne après coup. */
  it("ne laisse aucun style résiduel après une fermeture par geste ni à la réouverture", () => {
    render(<MobileShell />);
    openByTrigger();
    stubPanelHeight(400);
    dragFrom(screen.getByTestId("mobile-more-item-agents"), 140);
    expect(queryMenuSurface()).toBeNull();

    openByTrigger();
    const reopened = menuSurface();
    expect(reopened.style.transform).toBe("");
    expect(reopened.style.getPropertyValue("will-change")).toBe("");
    expect(reopened.style.getPropertyValue("overscroll-behavior")).toBe("");

    /* Un glissement annulé (`touchcancel`) nettoie aussi entièrement, sans fermer. */
    dragFrom(screen.getByTestId("mobile-more-item-agents"), 140, { end: "touchcancel" });
    const stillOpen = menuSurface();
    expect(stillOpen.style.transform).toBe("");
    expect(stillOpen.style.getPropertyValue("will-change")).toBe("");
    expect(stillOpen.style.getPropertyValue("overscroll-behavior")).toBe("");
  });

  /*
   * (12) Qualification des lignes : toute ligne `.mobile-more-item` de la surface est un point de départ légitime,
   * et le contrat partagé `listItemGesture` n'est ni élargi ni réécrit pour y parvenir.
   */
  it("qualifie chaque ligne du menu comme point de départ, sans toucher au contrat partagé", () => {
    render(<MobileShell />);
    openByTrigger();
    const surface = menuSurface();

    const rows = Array.from(surface.querySelectorAll<HTMLElement>(".mobile-more-item"));
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      expect(row.matches(LIST_ITEM_ROW_SELECTOR)).toBe(true);
      /* La ligne reste un bouton accessible : aucune sémantique retirée pour faire passer le geste. */
      expect(row.tagName).toBe("BUTTON");
      expect(row.getAttribute("data-testid")).toBeTruthy();
    }

    /* Contrat partagé inchangé : mêmes nom d'attribut et sélecteur que ceux utilisés par les tiroirs. */
    expect(LIST_ITEM_ROW_ATTRIBUTE).toBe("data-drawer-dismiss-row");
    expect(LIST_ITEM_ROW_SELECTOR).toBe("[data-drawer-dismiss-row]");
  });

  /* (14) Le chevron des scripts et le contenu injecté de connexion restent NON qualifiés : le geste n'y démarre pas. */
  it("laisse le chevron des scripts et le contrôle de connexion hors du geste", () => {
    render(<MobileShell shellConnectionControl={<button type="button" data-testid="shell-connection-button">Connect</button>} />);
    openByTrigger();
    const surface = menuSurface();

    const chevron = screen.getByTestId("mobile-more-terminal-split-toggle");
    expect(chevron.matches(LIST_ITEM_ROW_SELECTOR)).toBe(false);
    const injected = screen.getByTestId("shell-connection-button");
    expect(injected.matches(LIST_ITEM_ROW_SELECTOR)).toBe(false);
    expect(surface.querySelector('[data-testid="mobile-more-shell-connection"]')?.matches(LIST_ITEM_ROW_SELECTOR)).toBe(false);

    /* Les onglets de la barre ne sont pas dans la surface de menu et ne sont pas qualifiés non plus. */
    expect(screen.getByTestId("mobile-nav-tab-missions").matches(LIST_ITEM_ROW_SELECTOR)).toBe(false);

    stubPanelHeight(400);
    const fromChevron = dragFrom(chevron, 160);
    expect(fromChevron.moveDefaultPrevented).toBe(false);
    expect(queryMenuSurface()).not.toBeNull();

    const fromInjected = dragFrom(injected, 160);
    expect(fromInjected.moveDefaultPrevented).toBe(false);
    expect(queryMenuSurface()).not.toBeNull();
  });
});
