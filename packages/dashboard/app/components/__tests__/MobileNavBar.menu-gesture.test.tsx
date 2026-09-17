import { useCallback, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { fetchScripts } from "../../api";
import { MobileNavBar } from "../MobileNavBar";
import { MOBILE_MEDIA_QUERY, TABLET_MEDIA_QUERY } from "../../hooks/useViewportMode";
import { FOOTER_SWIPE_MIN_DISTANCE } from "../../hooks/useFooterSwipeUpGesture";
import { readAppFile } from "../../test/cssFixture";

const mobileNavBarCss = readAppFile("components/MobileNavBar.css");

/*
FNXC:MobileNavGesture 2026-09-17-16:53:
FN-511 : le glissement vers le haut du pied de page mobile n'ouvre plus le Chat (devenu une destination ordinaire des
cinq créneaux configurables) mais le MENU de navigation, et seulement sous l'option projet `mobileNavMenuSwipeGesture`.
Ces cas pilotent de VRAIS événements tactiles sur `.mobile-nav-bar--native` et couvrent l'énumération de surfaces :
hamburger présent/absent, geste armé/désarmé, absence de coquille et d'attribut ARIA orphelin, présentation en tiroir,
et clavier logiciel ouvert.
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
 * Coquille contrôlée : `navigationMenuOpen` est possédé par App en production, donc reproduit ici par un état local. Le
 * callback doit être STABLE (comme en production) : `MobileNavBar` referme toute surface transitoire quand l'identité de
 * son propriétaire d'état change, donc une fonction recréée à chaque rendu refermerait le menu immédiatement.
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

function pill(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".mobile-nav-bar--native")!;
}

function dispatchTouch(target: EventTarget, type: "touchstart" | "touchmove" | "touchend", x: number, y: number, timeStamp: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  const touch = { identifier: 7, clientX: x, clientY: y, target } as Touch;
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : [touch] },
    changedTouches: { value: [touch] },
    timeStamp: { value: timeStamp },
  });
  target.dispatchEvent(event);
}

/*
 * Glissement ascendant franc : la distance dépasse `FOOTER_SWIPE_MIN_DISTANCE`, sans dépendre de la vitesse. Le geste
 * déclenche une mise à jour d'état React possedée par l'hôte, donc les événements sont émis dans `act`.
 */
function swipeUp(surface: Element): void {
  const distance = FOOTER_SWIPE_MIN_DISTANCE + 40;
  act(() => {
    dispatchTouch(surface, "touchstart", 40, 300, 0);
    dispatchTouch(document, "touchmove", 40, 300 - distance, 400);
    dispatchTouch(document, "touchend", 40, 300 - distance, 400);
  });
}

function swipeDown(surface: Element): void {
  act(() => {
    dispatchTouch(surface, "touchstart", 40, 200, 0);
    dispatchTouch(document, "touchmove", 40, 200 + FOOTER_SWIPE_MIN_DISTANCE + 40, 400);
    dispatchTouch(document, "touchend", 40, 200 + FOOTER_SWIPE_MIN_DISTANCE + 40, 400);
  });
}

function swipeSideways(surface: Element): void {
  act(() => {
    dispatchTouch(surface, "touchstart", 40, 300, 0);
    dispatchTouch(document, "touchmove", 240, 280, 400);
    dispatchTouch(document, "touchend", 240, 280, 400);
  });
}

describe("MobileNavBar ouvre le menu de navigation par un glissement du pied de page", () => {
  beforeEach(() => {
    mockViewport("mobile");
    vi.mocked(fetchScripts).mockReset();
    vi.mocked(fetchScripts).mockResolvedValue({});
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
  });
  afterEach(() => {
    document.documentElement.style.removeProperty("--mobile-nav-pill-left");
    document.documentElement.style.removeProperty("--mobile-nav-pill-width");
  });

  /* (a) option désactivée : le hamburger existe et le geste est désarmé — il n'ouvre NI le Chat NI le menu. */
  it("garde le hamburger et désarme le geste quand l'option est désactivée", () => {
    const onMenuOpenChange = vi.fn();
    const onChangeView = vi.fn();
    const { container } = render(<MobileShell onChangeView={onChangeView} onMenuOpenChange={onMenuOpenChange} />);

    expect(screen.getByTestId("mobile-menu-trigger")).toBeInTheDocument();
    swipeUp(pill(container));

    /* Le composant peut synchroniser une fermeture (`false`) ; la preuve est qu'aucune OUVERTURE n'est demandée. */
    expect(onMenuOpenChange).not.toHaveBeenCalledWith(true);
    expect(onChangeView).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu", { name: "Navigate" })).toBeNull();
  });

  /* (b) option activée : aucun hamburger, aucun attribut ARIA orphelin, et le glissement ascendant ouvre le menu. */
  it("masque le hamburger et ouvre le menu par un glissement ascendant quand l'option est activée", () => {
    const onMenuOpenChange = vi.fn();
    const onChangeView = vi.fn();
    const { container } = render(<MobileShell menuGestureEnabled onChangeView={onChangeView} onMenuOpenChange={onMenuOpenChange} />);

    expect(screen.queryByTestId("mobile-menu-trigger")).toBeNull();
    expect(container.querySelector(".mobile-menu-trigger")).toBeNull();
    expect(document.querySelectorAll('[aria-controls="mobile-navigation-popover"]')).toHaveLength(0);
    expect(pill(container).querySelectorAll("[aria-expanded]")).toHaveLength(0);
    expect(screen.queryByLabelText("Open navigation menu")).toBeNull();

    swipeUp(pill(container));

    expect(onMenuOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("menu", { name: "Navigate" })).toBeInTheDocument();
    /* Le geste n'est pas une navigation : il ouvre seulement la surface de menu. */
    expect(onChangeView).not.toHaveBeenCalled();
  });

  /* (c) un glissement descendant ou horizontalement dominant n'ouvre rien. */
  it("n'ouvre rien pour un glissement descendant ou horizontalement dominant", () => {
    const onMenuOpenChange = vi.fn();
    const down = render(<MobileShell menuGestureEnabled onMenuOpenChange={onMenuOpenChange} />);
    swipeDown(pill(down.container));
    expect(onMenuOpenChange).not.toHaveBeenCalledWith(true);
    down.unmount();

    const sideways = render(<MobileShell menuGestureEnabled onMenuOpenChange={onMenuOpenChange} />);
    swipeSideways(pill(sideways.container));
    expect(onMenuOpenChange).not.toHaveBeenCalledWith(true);
    expect(screen.queryByRole("menu", { name: "Navigate" })).toBeNull();
  });

  /* (d) menu déjà ouvert → geste désarmé (il ne peut pas réouvrir ni relancer le propriétaire d'état). */
  it("désarme le geste quand le menu est déjà ouvert", () => {
    const onUiMenuOpenChange = vi.fn();
    const { container } = render(<MobileNavBar {...createDefaultProps()} menuGestureEnabled navigationMenuOpen onUiMenuOpenChange={onUiMenuOpenChange} />);
    expect(screen.getByRole("menu", { name: "Navigate" })).toBeInTheDocument();

    swipeUp(pill(container));

    expect(onUiMenuOpenChange).not.toHaveBeenCalledWith(true);
  });

  /* (e) présentation en tiroir de la largeur du pied de page, uniquement en mode geste, et par jetons de design. */
  it("présente le menu comme un tiroir de la largeur du pied de page en mode geste", () => {
    const { container, unmount } = render(<MobileShell menuGestureEnabled />);
    swipeUp(pill(container));
    const drawer = screen.getByRole("menu", { name: "Navigate" });
    expect(drawer).toHaveClass("mobile-navigation-popover");
    expect(drawer).toHaveClass("mobile-navigation-popover--footer-drawer");
    unmount();

    const withTrigger = render(<MobileShell />);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.getByRole("menu", { name: "Navigate" })).not.toHaveClass("mobile-navigation-popover--footer-drawer");
    withTrigger.unmount();

    const drawerRule = mobileNavBarCss.match(/\.mobile-navigation-popover--footer-drawer\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(drawerRule).toMatch(/left:\s*var\(--mobile-nav-pill-left,\s*var\(--space-md\)\)/);
    expect(drawerRule).toMatch(/width:\s*var\(--mobile-nav-pill-width/);
    /* Aucun pixel, hex ou rgba() codé en dur : le tiroir n'utilise que des jetons et la géométrie mesurée publiée. */
    expect(drawerRule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(drawerRule).not.toMatch(/rgba?\(/);
    expect(drawerRule.replace(/var\([^)]*\)/g, "")).not.toMatch(/\b[1-9]\d*px\b/);
  });

  /*
   * (f) clavier logiciel ouvert : la pill reste montée et ancrée au bas de l'écran (FN-463), donc le tiroir reste ancré
   * au pied de page par la même chaîne de géométrie et ne se monte pas au-dessus du clavier.
   */
  it("garde la pill montée et le tiroir ancré au pied de page quand le clavier est ouvert", () => {
    const { container } = render(<MobileShell menuGestureEnabled keyboardOpen keyboardMetrics={{ keyboardOverlap: 320, viewportHeight: 504, viewportOffsetTop: 0 }} />);
    const nav = pill(container);
    expect(nav).toBeInTheDocument();
    expect(nav).toHaveClass("mobile-nav-bar--keyboard-open");

    swipeUp(nav);
    const drawer = screen.getByRole("menu", { name: "Navigate" });
    expect(drawer).toHaveClass("mobile-navigation-popover--footer-drawer");
    expect(drawer.style.getPropertyValue("--mobile-nav-popover-bottom")).toBe("calc(var(--mobile-nav-pill-bottom) + var(--mobile-nav-pill-height) + var(--space-xs))");
    expect(nav.style.getPropertyValue("--mobile-nav-pill-bottom")).toBe("calc(var(--mobile-nav-system-offset) + var(--mobile-nav-floating-gap))");
  });

  /* Le hook reste STRICTEMENT tactile : un glissement à la souris n'ouvre jamais le menu. */
  it("ignore un glissement à la souris ou au trackpad", () => {
    const onMenuOpenChange = vi.fn();
    const { container } = render(<MobileShell menuGestureEnabled onMenuOpenChange={onMenuOpenChange} />);
    const surface = pill(container);
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 40, clientY: 300, button: 0, isPrimary: true, pointerType: "mouse" });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 40, clientY: 180, pointerType: "mouse" });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 40, clientY: 180, pointerType: "mouse" });
    expect(onMenuOpenChange).not.toHaveBeenCalledWith(true);
  });

  /* Non-régression : un tap normal sur un onglet navigue toujours, même en mode geste. */
  it("laisse un tap normal sur un onglet naviguer en mode geste", () => {
    const onChangeView = vi.fn();
    render(<MobileShell menuGestureEnabled onChangeView={onChangeView} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-missions"));
    expect(onChangeView).toHaveBeenCalledWith("missions");
  });

  /* Le geste n'ouvre PLUS le Chat, sur aucune répartition : ni comme onglet direct, ni depuis le menu. */
  it("n'ouvre jamais le Chat par le geste", () => {
    const onChangeView = vi.fn();
    const withChatTab = render(<MobileShell menuGestureEnabled onChangeView={onChangeView} />);
    expect(screen.getByTestId("mobile-nav-tab-chat")).toBeInTheDocument();
    swipeUp(pill(withChatTab.container));
    expect(onChangeView).not.toHaveBeenCalledWith("chat");
    withChatTab.unmount();

    const withChatInMenu = render(<MobileShell menuGestureEnabled onChangeView={onChangeView} quickAccessItems={["command-center", "tasks", "missions", "mailbox", "planning"]} />);
    swipeUp(pill(withChatInMenu.container));
    expect(onChangeView).not.toHaveBeenCalledWith("chat");
  });
});
