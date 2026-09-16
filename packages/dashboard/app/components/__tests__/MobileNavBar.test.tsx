import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fetchScripts } from "../../api";
import { createMobileNavGeometryStyle, MobileNavBar } from "../MobileNavBar";
import { MOBILE_MEDIA_QUERY } from "../../hooks/useViewportMode";
import { NavigationHistoryProvider, useNavigationHistory } from "../../hooks/useNavigationHistory";
import { readAppFile } from "../../test/cssFixture";

const mobileNavBarLayeringCss = readAppFile("components/MobileNavBar.css");

/*
 * FN-467 : la pill est pilotée par le réglage projet d'accès rapide, donc chaque destination du registre peut basculer
 * entre l'onglet direct et le menu. Ces tables permettent d'asserter la répartition sur le DOM rendu.
 */
const MORE_TEST_IDS: Record<string, string> = {
  "command-center": "mobile-more-item-command-center",
  tasks: "mobile-more-item-tasks",
  agents: "mobile-more-item-agents",
  missions: "mobile-more-item-missions",
  chat: "mobile-more-item-chat",
  mailbox: "mobile-more-item-mailbox",
  planning: "mobile-more-item-planning",
  activity: "mobile-more-item-activity",
  git: "mobile-more-item-git",
  files: "mobile-more-item-files",
  workflows: "mobile-more-item-workflow",
  automation: "mobile-more-item-schedules",
  "github-import": "mobile-more-item-github",
  usage: "mobile-more-item-usage",
  projects: "mobile-more-item-projects",
  notes: "mobile-more-item-notes",
  whiteboard: "mobile-more-item-whiteboard",
  secrets: "mobile-more-item-secrets",
  settings: "mobile-more-item-settings",
  skills: "mobile-more-item-skills",
  insights: "mobile-more-item-insights",
  memory: "mobile-more-item-memory",
  research: "mobile-more-item-research",
  evals: "mobile-more-item-evals",
  ideation: "mobile-more-item-ideation",
  goals: "mobile-more-item-goals",
  "dev-server": "mobile-more-item-dev-server",
};
const REGISTRY_ITEMS = Object.keys(MORE_TEST_IDS);

function tabTestIds(container: HTMLElement): (string | undefined)[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".mobile-nav-bar--native > .mobile-nav-tab")).map((tab) => tab.dataset.testid);
}

function pill(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".mobile-nav-bar--native")!;
}

vi.mock("../../api", () => ({
  fetchScripts: vi.fn(),
}));

const initialClientHeightDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, "clientHeight");

function mockViewport(mode: "mobile" | "desktop") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mode === "mobile" && (query === MOBILE_MEDIA_QUERY || query.includes("max-width: 768px")),
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
  onOpenUsage: vi.fn(),
  onViewAllProjects: vi.fn(),
  onRunScript: vi.fn(),
  projectId: "project-1",
});

function OfficialMobileShell(props: Partial<React.ComponentProps<typeof MobileNavBar>> = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <MobileNavBar {...createDefaultProps()} {...props} navigationMenuOpen={menuOpen} onUiMenuOpenChange={setMenuOpen} />;
}

const COMPONENT_GEOMETRY = {
  layoutViewportHeight: 844,
  visualViewportHeight: 504,
  viewportOffsetTop: 40,
  systemOffset: 16,
  floatingGap: 8,
  pillHeight: 44,
  popoverGap: 4,
  safeTopInset: 12,
  minimumItemHeight: 36,
} as const;

function readRenderedLength(element: HTMLElement, property: string): number {
  const value = element.style.getPropertyValue(property);
  if (!/^-?\d+(?:\.\d+)?px$/.test(value)) {
    throw new Error(`Expected a concrete ${property} on ${element.className}, received ${JSON.stringify(value)}.`);
  }
  return Number.parseFloat(value);
}

/*
FNXC:MobilePillPopover 2026-09-13-10:03:
Scripts-state coverage resolves the pill and popover independently from the complete geometry style emitted by MobileNavBar. No rectangle is injected; a missing sibling lift therefore moves only the popover and makes the numerical non-overlap check fail.
*/
function resolveRenderedPopover(nav: HTMLElement, popover: HTMLElement) {
  const navViewportTop = readRenderedLength(nav, "--mobile-nav-viewport-offset-top");
  const popoverViewportTop = readRenderedLength(popover, "--mobile-nav-viewport-offset-top");
  const expectedStyle = createMobileNavGeometryStyle(navViewportTop);
  for (const property of [
    "--mobile-nav-floating-gap",
    "--mobile-nav-viewport-offset-top",
    "--mobile-nav-pill-bottom",
    "--mobile-nav-popover-bottom",
  ] as const) {
    expect(nav.style.getPropertyValue(property)).toBe(expectedStyle[property]);
    expect(popover.style.getPropertyValue(property)).toBe(expectedStyle[property]);
  }
  expect(popoverViewportTop).toBe(navViewportTop);

  const pillBottom = COMPONENT_GEOMETRY.layoutViewportHeight
    - COMPONENT_GEOMETRY.systemOffset
    - COMPONENT_GEOMETRY.floatingGap;
  const pillTop = pillBottom - COMPONENT_GEOMETRY.pillHeight;
  const popoverBottom = COMPONENT_GEOMETRY.layoutViewportHeight
    - COMPONENT_GEOMETRY.systemOffset
    - COMPONENT_GEOMETRY.floatingGap
    - COMPONENT_GEOMETRY.pillHeight
    - COMPONENT_GEOMETRY.popoverGap;
  const popoverMaxHeight = popoverBottom - popoverViewportTop - COMPONENT_GEOMETRY.safeTopInset;
  const items = Array.from(popover.querySelectorAll<HTMLElement>(".mobile-more-item"));
  const lastItem = items.at(-1);
  if (!lastItem) throw new Error("The production popover must contain a final navigation destination.");
  const contentHeight = items.length * COMPONENT_GEOMETRY.minimumItemHeight;
  const renderedPopoverHeight = Math.min(contentHeight, popoverMaxHeight);
  const popoverTop = popoverBottom - renderedPopoverHeight;
  const terminalScrollTop = Math.max(0, contentHeight - renderedPopoverHeight);
  const terminalItemBottom = popoverTop + contentHeight - terminalScrollTop;

  return {
    lastItem,
    pill: { top: pillTop, bottom: pillBottom },
    popover: { top: popoverTop, bottom: popoverBottom, maxHeight: popoverMaxHeight },
    viewportOffsetTop: popoverViewportTop,
    terminalItemBottom,
    terminalScrollTop,
  };
}

describe("MobileNavBar official mobile shell", () => {
  beforeEach(() => {
    mockViewport("mobile");
    vi.mocked(fetchScripts).mockReset();
    vi.mocked(fetchScripts).mockResolvedValue({});
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 844 });
  });
  afterEach(() => {
    document.documentElement.style.removeProperty("--mobile-nav-height");
    document.documentElement.style.removeProperty("--mobile-nav-pill-height");
    if (initialClientHeightDescriptor) {
      Object.defineProperty(document.documentElement, "clientHeight", initialClientHeightDescriptor);
    } else {
      delete (document.documentElement as { clientHeight?: number }).clientHeight;
    }
  });

  /*
  FNXC:PopoverLayering 2026-09-15-09:31:
  FN-413: the phone More menu must outrank every dashboard-managed window while open. The proof has two halves:
  the surface is a SIBLING of `.mobile-nav-bar` (so nothing traps it in the bar's stacking context) and its declared
  layer derives from the live `--fusion-max-z` ceiling rather than the legacy 90/91 pair.
  */
  // (f)
  it("keeps the official pill popover outside the nav bar and above the live window ceiling", () => {
    const { container } = render(<OfficialMobileShell />);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));

    const popover = screen.getByRole("menu", { name: "Navigate" });
    expect(popover).toHaveClass("mobile-navigation-popover");
    const navBar = container.querySelector<HTMLElement>(".mobile-nav-bar")!;
    expect(navBar.contains(popover)).toBe(false);

    const rule = mobileNavBarLayeringCss.match(/\.mobile-navigation-popover\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(rule).toMatch(/z-index:\s*calc\(var\(--fusion-max-z\)\s*\+\s*3\)/);
  });

  // (g) legacy sheet variant: unreachable at runtime today (officialDesignEnabled is a constant true),
  // so its contract is pinned on the stylesheet plus the sibling structure of the markup branch.
  it("keeps the legacy sheet variant and its backdrop on the ceiling-derived scale", () => {
    const sheetRule = mobileNavBarLayeringCss.match(/\.mobile-more-sheet\s*\{([^}]*)\}/s)?.[1] ?? "";
    const backdropRule = mobileNavBarLayeringCss.match(/\.mobile-more-sheet-backdrop\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(sheetRule).toMatch(/z-index:\s*calc\(var\(--fusion-max-z\)\s*\+\s*3\)/);
    expect(backdropRule).toMatch(/z-index:\s*calc\(var\(--fusion-max-z\)\s*\+\s*2\)/);

    // The sheet, its backdrop and the pill popover are rendered as siblings of <nav>, never inside it.
    const source = readAppFile("components/MobileNavBar.tsx");
    const afterNav = source.slice(source.indexOf("</nav>"));
    expect(afterNav).toContain("mobile-more-sheet-backdrop");
    expect(afterNav).toContain("mobile-navigation-popover");
    expect(afterNav).toContain("mobile-more-sheet");
  });

  /*
   * FN-467 : la pill n'énumère plus quatre destinations figées. Elle rend jusqu'à CINQ destinations résolues depuis le
   * réglage projet d'accès rapide, dans l'ordre persisté, le hamburger restant toujours le dernier enfant. Le cas (d)
   * remplace l'ancien contrat à quatre onglets (qui excluait Board et incluait Chat, non promouvable en réglages).
   */
  // (d) reproduction du symptôme : sur la base, la sélection projet par défaut ne produisait que 4 onglets sans Board ni Missions.
  it("rend les cinq destinations par défaut quand aucune sélection n'est fournie", () => {
    const { container } = render(<OfficialMobileShell />);
    expect(tabTestIds(container)).toEqual([
      "mobile-nav-tab-command-center",
      "mobile-nav-tab-tasks",
      "mobile-nav-tab-planning",
      "mobile-nav-tab-missions",
      "mobile-nav-tab-mailbox",
    ]);
    expect(tabTestIds(container)).toHaveLength(5);
    expect(container.querySelector(".mobile-nav-bar")).toHaveClass("mobile-nav-bar--native");
    expect(pill(container).lastElementChild).toBe(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.queryByTestId("mobile-nav-tab-more")).toBeNull();
  });

  // (e) sélection vide → même repli que l'absence de sélection.
  it("revient au défaut quand la sélection persistée est vide", () => {
    const { container } = render(<OfficialMobileShell quickAccessItems={[]} />);
    expect(tabTestIds(container)).toEqual([
      "mobile-nav-tab-command-center",
      "mobile-nav-tab-tasks",
      "mobile-nav-tab-planning",
      "mobile-nav-tab-missions",
      "mobile-nav-tab-mailbox",
    ]);
  });

  // (f) sélection peuplée et réordonnée → exactement ces destinations, dans cet ordre.
  it("respecte l'ordre exact d'une sélection personnalisée", () => {
    const { container } = render(<OfficialMobileShell quickAccessItems={["mailbox", "missions", "tasks"]} />);
    expect(tabTestIds(container)).toEqual([
      "mobile-nav-tab-mailbox",
      "mobile-nav-tab-missions",
      "mobile-nav-tab-tasks",
    ]);
    expect(pill(container).lastElementChild).toBe(screen.getByTestId("mobile-menu-trigger"));
  });

  // (g) doublons, identifiant inconnu et dépassement du plafond de cinq.
  it("déduplique, rejette l'inconnu et plafonne la rangée à cinq destinations", () => {
    const { container } = render(<OfficialMobileShell quickAccessItems={["tasks", "tasks", "nope", "mailbox", "planning", "missions", "command-center", "agents"]} />);
    expect(tabTestIds(container)).toEqual([
      "mobile-nav-tab-tasks",
      "mobile-nav-tab-mailbox",
      "mobile-nav-tab-planning",
      "mobile-nav-tab-missions",
      "mobile-nav-tab-command-center",
    ]);
    expect(screen.queryByTestId("mobile-nav-tab-agents")).toBeNull();
    expect(pill(container).lastElementChild).toBe(screen.getByTestId("mobile-menu-trigger"));
  });

  // (h) sélection entièrement gatée off → aucune coquille de bouton, le hamburger reste seul.
  it("ne laisse aucune coquille d'onglet quand la sélection est entièrement gatée off", () => {
    const { container } = render(<OfficialMobileShell quickAccessItems={["memory"]} experimentalFeatures={{}} />);
    expect(tabTestIds(container)).toEqual([]);
    expect(pill(container).children).toHaveLength(1);
    expect(pill(container).firstElementChild).toBe(screen.getByTestId("mobile-menu-trigger"));
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.getByTestId("mobile-more-item-command-center")).toBeInTheDocument();
  });

  // (l) paysage téléphone : la répartition ne dépend pas de la largeur.
  it("rend la même rangée sur un téléphone en paysage", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 844 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 390 });
    const { container } = render(<OfficialMobileShell />);
    expect(tabTestIds(container)).toEqual([
      "mobile-nav-tab-command-center",
      "mobile-nav-tab-tasks",
      "mobile-nav-tab-planning",
      "mobile-nav-tab-missions",
      "mobile-nav-tab-mailbox",
    ]);
  });

  /*
   * FN-467 cas (j) : une rangée configurable peut renvoyer N'IMPORTE quelle destination dans le menu. Les quatre entrées
   * qui ignoraient jusqu'ici l'argument `surface` doivent donc naviguer ET refermer le popover, conformément à
   * FNXC:NativeShell 2026-09-09-22:40.
   */
  it.each([
    ["command-center", "mobile-more-item-command-center", "command-center"],
    ["tasks", "mobile-more-item-tasks", "board"],
    ["chat", "mobile-more-item-chat", "chat"],
    ["mailbox", "mobile-more-item-mailbox", "mailbox"],
  ])("navigue et referme le menu pour %s rendu dans la surface overflow", (_item, moreTestId, expectedView) => {
    const props = createDefaultProps();
    render(<OfficialMobileShell {...props} quickAccessItems={["planning", "missions"]} />);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.getByRole("menu", { name: "Navigate" })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(moreTestId));
    expect(props.onChangeView).toHaveBeenCalledWith(expectedView);
    expect(screen.queryByRole("menu", { name: "Navigate" })).toBeNull();
  });

  /*
   * FN-467 cas (k) : chaque destination disponible apparaît dans EXACTEMENT une surface. L'union onglets ∪ menu reste
   * constante quelle que soit la sélection, et l'intersection est toujours vide.
   */
  it("couvre toutes les destinations disponibles sans jamais en dupliquer une", () => {
    const unions: string[][] = [];
    for (const selection of [undefined, ["mailbox", "missions", "tasks"], ["agents", "files", "git", "workflows", "goals"]]) {
      const view = render(<OfficialMobileShell quickAccessItems={selection} />);
      fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
      const tabs = REGISTRY_ITEMS.filter((item) => screen.queryByTestId(`mobile-nav-tab-${item}`) !== null);
      const menu = REGISTRY_ITEMS.filter((item) => screen.queryByTestId(MORE_TEST_IDS[item]) !== null);
      expect(tabs.filter((item) => menu.includes(item))).toEqual([]);
      expect(tabs.length).toBeGreaterThan(0);
      unions.push([...tabs, ...menu].sort());
      view.unmount();
    }
    expect(unions[1]).toEqual(unions[0]);
    expect(unions[2]).toEqual(unions[0]);
  });

  /*
   * FN-467 cas (k) : l'état actif suit la nouvelle répartition. La pill officielle ne marque l'état actif que sur ses
   * onglets (le hamburger n'a jamais porté `mobile-nav-tab--active`, cette classe appartient à la variante héritée),
   * donc l'invariant observable est : la destination courante est marquée une fois quand elle est un onglet, et aucune
   * n'est marquée quand elle a basculé dans le menu.
   */
  it("marque la destination active seulement quand elle est rendue comme onglet", () => {
    const asTab = render(<OfficialMobileShell view="agents" quickAccessItems={["agents"]} />);
    expect(screen.getByTestId("mobile-nav-tab-agents")).toHaveAttribute("aria-current", "page");
    expect(document.querySelectorAll('.mobile-nav-tab[aria-current="page"]')).toHaveLength(1);
    asTab.unmount();

    render(<OfficialMobileShell view="agents" quickAccessItems={["tasks"]} />);
    expect(screen.queryByTestId("mobile-nav-tab-agents")).toBeNull();
    expect(document.querySelectorAll('.mobile-nav-tab[aria-current="page"]')).toHaveLength(0);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.getByTestId("mobile-more-item-agents")).toBeInTheDocument();
  });

  it("opens the single navigation menu, routes List, and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    render(<OfficialMobileShell {...props} />);
    const trigger = screen.getByTestId("mobile-menu-trigger");
    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "Navigate" })).toHaveClass("mobile-navigation-popover");
    fireEvent.click(screen.getByTestId("mobile-more-item-list"));
    expect(props.onChangeView).toHaveBeenCalledWith("list");

    await user.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Navigate" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it.each(["empty", "loading", "populated"] as const)("keeps %s Scripts content inside the production-resolved popover above the pill", async (scriptsState) => {
    if (scriptsState === "loading") {
      vi.mocked(fetchScripts).mockReturnValue(new Promise(() => undefined));
    } else if (scriptsState === "populated") {
      vi.mocked(fetchScripts).mockResolvedValue([
        { name: "build", command: "pnpm build" },
        { name: "verify", command: "pnpm verify:fast", description: "Verify changes" },
      ]);
    }

    const { container } = render(<OfficialMobileShell keyboardOpen keyboardMetrics={{ keyboardOverlap: 300, viewportHeight: COMPONENT_GEOMETRY.visualViewportHeight, viewportOffsetTop: COMPONENT_GEOMETRY.viewportOffsetTop }} />);
    const trigger = screen.getByTestId("mobile-menu-trigger");
    expect(trigger).toHaveAttribute("aria-controls", "mobile-navigation-popover");
    fireEvent.click(trigger);
    const popover = screen.getByRole("menu", { name: "Navigate" });
    fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));

    if (scriptsState === "loading") {
      await waitFor(() => expect(screen.getByTestId("mobile-more-scripts-loading")).toBeInTheDocument());
    } else if (scriptsState === "populated") {
      await waitFor(() => expect(screen.getByTestId("mobile-more-script-item-verify")).toBeInTheDocument());
    } else {
      await waitFor(() => expect(screen.getByText("No scripts — add one…")).toBeInTheDocument());
    }

    const geometry = resolveRenderedPopover(container.querySelector<HTMLElement>(".mobile-nav-bar")!, popover);
    /*
    FNXC:MobilePillKeyboard 2026-09-16-16:27:
    FN-463 removed the keyboard lift, so the pill's bottom anchor is the layout-viewport placement alone even while
    an input owns the keyboard. The popover therefore keeps its exclusive boundary one --space-xs above the pill
    without any viewport-derived displacement.
    */
    expect(geometry.viewportOffsetTop).toBe(COMPONENT_GEOMETRY.viewportOffsetTop);
    expect(geometry.pill.bottom).toBe(
      COMPONENT_GEOMETRY.layoutViewportHeight - COMPONENT_GEOMETRY.systemOffset - COMPONENT_GEOMETRY.floatingGap,
    );
    expect(geometry.pill.top).toBeGreaterThanOrEqual(COMPONENT_GEOMETRY.viewportOffsetTop);
    expect(geometry.popover.top).toBeGreaterThanOrEqual(COMPONENT_GEOMETRY.viewportOffsetTop + COMPONENT_GEOMETRY.safeTopInset);
    expect(geometry.popover.bottom).toBeLessThan(geometry.pill.top);
    expect(geometry.pill.top - geometry.popover.bottom).toBe(COMPONENT_GEOMETRY.popoverGap);
    expect(geometry.popover.maxHeight).toBeGreaterThan(0);
    expect(geometry.terminalScrollTop).toBeGreaterThanOrEqual(0);
    expect(geometry.terminalItemBottom).toBeLessThanOrEqual(geometry.popover.bottom);
    expect(geometry.lastItem).toBe(screen.getByTestId("mobile-more-item-settings"));
    expect(popover).toHaveAttribute("id", "mobile-navigation-popover");
    expect(container.querySelector(".mobile-more-sheet-backdrop")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps Whiteboard absent until its independent flag is enabled", () => {
    const disabled = render(<OfficialMobileShell experimentalFeatures={{}} />);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.queryByTestId("mobile-more-item-whiteboard")).toBeNull();
    disabled.unmount();

    render(<OfficialMobileShell experimentalFeatures={{ whiteboardView: true }} />);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.getByTestId("mobile-more-item-whiteboard")).toHaveTextContent("Alpha");
  });

  /*
   * (i) FN-467 : Chat n'est plus un onglet par défaut (il n'est pas promouvable en réglages), donc sa pastille vit
   * désormais dans le menu. Les compteurs Mailbox et Planning restent rendus sur leurs onglets comme avant.
   */
  it("preserves unread and planning indicators on official destinations", () => {
    render(<OfficialMobileShell chatHasUnreadResponse mailboxUnreadCount={3} mailboxPendingApprovalCount={1} planningNeedsInput />);
    expect(screen.getByLabelText("Pending approvals")).toHaveClass("status-dot");
    expect(screen.getByLabelText("Planning needs your input")).toHaveClass("status-dot");
    expect(screen.getByText("3")).toHaveClass("mobile-nav-tab-badge");

    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.getByLabelText("Unread chat response")).toHaveClass("status-dot");
  });

  it("hides for modal, keyboard-independent hidden state, and non-mobile viewports", () => {
    const view = render(<OfficialMobileShell modalOpen />);
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
    view.rerender(<OfficialMobileShell hidden />);
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
    view.unmount();
    mockViewport("desktop");
    render(<OfficialMobileShell />);
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
  });

  /* FN-467 : Chat n'est plus promouvable en onglet direct, la preuve de routage unique porte donc sur une destination sélectionnable. */
  it("routes direct destinations exactly once", () => {
    const props = createDefaultProps();
    render(<OfficialMobileShell {...props} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-command-center"));
    expect(props.onChangeView).toHaveBeenCalledTimes(1);
    expect(props.onChangeView).toHaveBeenCalledWith("command-center");
  });
});

/*
FNXC:MobileNav 2026-09-14-19:51:
Scrolling the mobile navigation popover then tapping an entry must open that entry. The opening focus affordance is
emitted once per open and with `preventScroll`, because a repeated or scrolling focus() returns the `overflow-y: auto`
surface to scrollTop 0 and moves the list under the finger between touchstart and click. The spy below reproduces that
browser behavior: a focus() without `preventScroll` resets the enclosing popover's scroll position.
*/
type RecordedFocus = { target: HTMLElement; options?: FocusOptions };

const originalFocus = HTMLElement.prototype.focus;

function installFocusRecorder(recorded: RecordedFocus[]) {
  return vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function focusMock(
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    recorded.push({ target: this, options });
    if (!options?.preventScroll) {
      const scrollable = this.closest<HTMLElement>(".mobile-navigation-popover");
      if (scrollable) scrollable.scrollTop = 0;
    }
    originalFocus.call(this, options);
  });
}

function menuFocusCalls(recorded: RecordedFocus[]) {
  return recorded.filter((entry) => entry.target.closest(".mobile-navigation-popover") !== null);
}

function exposeScrollPosition(element: HTMLElement, value: number) {
  let scrollTop = value;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (next: number) => { scrollTop = next; },
  });
}

/*
FNXC:MobileNav 2026-09-14-19:51:
This shell reproduces App's mount exactly: `useNavigationHistory` feeds a NavigationHistoryProvider, so every parent
re-render used to hand the popover a new context identity. Props are supplied by the caller so a re-render does not
fabricate new handler identities of its own.
*/
function NavigationHistoryShell({
  navProps,
  mailboxUnreadCount,
  withProvider = true,
}: {
  navProps: Partial<React.ComponentProps<typeof MobileNavBar>>;
  mailboxUnreadCount?: number;
  withProvider?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigationHistory = useNavigationHistory({ enabled: true });
  const bar = (
    <MobileNavBar
      {...(navProps as React.ComponentProps<typeof MobileNavBar>)}
      mailboxUnreadCount={mailboxUnreadCount}
      navigationMenuOpen={menuOpen}
      onUiMenuOpenChange={setMenuOpen}
    />
  );
  if (!withProvider) return bar;
  const { pushNav, replaceCurrent, removeNav, promoteNav } = navigationHistory;
  return (
    <NavigationHistoryProvider value={{ pushNav, replaceCurrent, removeNav, promoteNav }}>
      {bar}
    </NavigationHistoryProvider>
  );
}

describe("MobileNavBar navigation popover keeps its scroll position", () => {
  let recordedFocus: RecordedFocus[];
  let focusSpy: ReturnType<typeof installFocusRecorder>;

  beforeEach(() => {
    mockViewport("mobile");
    vi.mocked(fetchScripts).mockReset();
    vi.mocked(fetchScripts).mockResolvedValue({});
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 844 });
    recordedFocus = [];
    focusSpy = installFocusRecorder(recordedFocus);
  });

  afterEach(() => {
    focusSpy.mockRestore();
    document.documentElement.style.removeProperty("--mobile-nav-height");
    document.documentElement.style.removeProperty("--mobile-nav-pill-height");
    if (initialClientHeightDescriptor) {
      Object.defineProperty(document.documentElement, "clientHeight", initialClientHeightDescriptor);
    } else {
      delete (document.documentElement as { clientHeight?: number }).clientHeight;
    }
  });

  it("focuses the first entry once per open, with preventScroll, across parent re-renders that change the navigation-history identity", () => {
    const navProps = createDefaultProps();
    const view = render(<NavigationHistoryShell navProps={navProps} mailboxUnreadCount={0} />);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));

    const popover = screen.getByRole("menu", { name: "Navigate" });
    exposeScrollPosition(popover, 180);

    view.rerender(<NavigationHistoryShell navProps={navProps} mailboxUnreadCount={1} />);
    view.rerender(<NavigationHistoryShell navProps={navProps} mailboxUnreadCount={2} />);

    const calls = menuFocusCalls(recordedFocus);
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toEqual({ preventScroll: true });
    expect(popover.scrollTop).toBe(180);
  });

  it("opens the destination tapped after scrolling instead of resetting the popover", () => {
    const navProps = createDefaultProps();
    const view = render(<NavigationHistoryShell navProps={navProps} mailboxUnreadCount={0} />);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));

    const popover = screen.getByRole("menu", { name: "Navigate" });
    exposeScrollPosition(popover, 180);
    view.rerender(<NavigationHistoryShell navProps={navProps} mailboxUnreadCount={1} />);

    expect(popover.scrollTop).toBe(180);
    fireEvent.click(screen.getByTestId("mobile-more-item-settings"));

    expect(navProps.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "Navigate" })).toBeNull();
  });

  it("re-arms the opening focus so every open focuses exactly once", () => {
    const navProps = createDefaultProps();
    render(<NavigationHistoryShell navProps={navProps} />);
    const trigger = screen.getByTestId("mobile-menu-trigger");

    fireEvent.click(trigger);
    expect(menuFocusCalls(recordedFocus)).toHaveLength(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Navigate" })).toBeNull();

    fireEvent.click(trigger);
    const calls = menuFocusCalls(recordedFocus);
    expect(calls).toHaveLength(2);
    expect(calls.map((entry) => entry.options)).toEqual([{ preventScroll: true }, { preventScroll: true }]);
  });

  it("focuses once for a reduced destination set", () => {
    const navProps = { ...createDefaultProps(), showSkillsTab: false, experimentalFeatures: {} };
    const view = render(<NavigationHistoryShell navProps={navProps} mailboxUnreadCount={0} />);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.queryByTestId("mobile-more-item-whiteboard")).toBeNull();

    view.rerender(<NavigationHistoryShell navProps={navProps} mailboxUnreadCount={4} />);

    expect(menuFocusCalls(recordedFocus)).toHaveLength(1);
  });

  it("focuses once and routes the tapped destination without a navigation-history provider", () => {
    const navProps = createDefaultProps();
    const view = render(<NavigationHistoryShell navProps={navProps} withProvider={false} mailboxUnreadCount={0} />);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));

    const popover = screen.getByRole("menu", { name: "Navigate" });
    exposeScrollPosition(popover, 96);
    view.rerender(<NavigationHistoryShell navProps={navProps} withProvider={false} mailboxUnreadCount={5} />);

    expect(menuFocusCalls(recordedFocus)).toHaveLength(1);
    expect(popover.scrollTop).toBe(96);
    fireEvent.click(screen.getByTestId("mobile-more-item-list"));
    expect(navProps.onChangeView).toHaveBeenCalledWith("list");
  });

  it("mounts no popover and emits no focus on desktop", () => {
    mockViewport("desktop");
    const navProps = createDefaultProps();
    render(<NavigationHistoryShell navProps={navProps} />);

    expect(screen.queryByRole("menu", { name: "Navigate" })).toBeNull();
    expect(screen.queryByTestId("mobile-menu-trigger")).toBeNull();
    expect(recordedFocus).toHaveLength(0);
  });
});
