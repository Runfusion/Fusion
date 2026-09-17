import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fetchScripts } from "../../api";
import { createMobileNavGeometryStyle, MobileNavBar } from "../MobileNavBar";
import { MOBILE_MEDIA_QUERY, TABLET_MEDIA_QUERY } from "../../hooks/useViewportMode";
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

/* FN-468 : la pill appartient au shell mobile (téléphone ET tablette), d'où le niveau `tablet` ici. */
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
   * FN-467 : la pill n'énumère plus quatre destinations figées ; elle rend les destinations résolues depuis le réglage
   * projet d'accès rapide, dans l'ordre persisté, le hamburger restant toujours le dernier enfant.
   *
   * FN-511 : la rangée vaut CINQ destinations configurables, strictement identiques à celles du pied de page large, et
   * `chat` y est une destination ordinaire : onglet direct quand il est résolu, ligne `mobile-more-item-chat` sinon,
   * jamais les deux. Aucune promotion dynamique liée à la largeur ne subsiste.
   */
  // (d) défaut : cinq onglets, le Chat en dernier, et aucune ligne Chat dupliquée dans le menu.
  it("rend les cinq destinations par défaut avec le Chat en dernier quand aucune sélection n'est fournie", () => {
    const { container } = render(<OfficialMobileShell />);
    expect(tabTestIds(container)).toEqual([
      "mobile-nav-tab-command-center",
      "mobile-nav-tab-tasks",
      "mobile-nav-tab-planning",
      "mobile-nav-tab-missions",
      "mobile-nav-tab-chat",
    ]);
    expect(tabTestIds(container)).toHaveLength(5);
    expect(container.querySelector(".mobile-nav-bar")).toHaveClass("mobile-nav-bar--native");
    expect(pill(container).lastElementChild).toBe(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.queryByTestId("mobile-nav-tab-more")).toBeNull();
    expect(Array.from(pill(container).children).every((child) => (child.getAttribute("aria-label") ?? "").length > 0 && child.querySelector("svg"))).toBe(true);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    // FN-511 : le Chat est déjà un onglet, donc il n'apparaît PAS aussi dans le menu.
    expect(screen.queryByTestId("mobile-more-item-chat")).toBeNull();
    expect(screen.getByTestId("mobile-more-item-mailbox")).toBeInTheDocument();
  });

  // (e) sélection vide → même repli que l'absence de sélection.
  it("revient au défaut quand la sélection persistée est vide", () => {
    const { container } = render(<OfficialMobileShell quickAccessItems={[]} />);
    expect(tabTestIds(container)).toEqual([
      "mobile-nav-tab-command-center",
      "mobile-nav-tab-tasks",
      "mobile-nav-tab-planning",
      "mobile-nav-tab-missions",
      "mobile-nav-tab-chat",
    ]);
  });

  /*
   * FN-511 : NON-RÉGRESSION DE MISE À JOUR. Une valeur persistée de quatre destinations sans `chat` est complétée par
   * le résolveur, donc la pill rend cinq onglets avec le Chat en dernier, sans ligne `mobile-more-item-chat`.
   */
  it("complète une sélection héritée de quatre destinations avec le Chat en dernier onglet", () => {
    const { container } = render(<OfficialMobileShell quickAccessItems={["command-center", "tasks", "planning", "missions"]} />);
    expect(tabTestIds(container)).toEqual([
      "mobile-nav-tab-command-center",
      "mobile-nav-tab-tasks",
      "mobile-nav-tab-planning",
      "mobile-nav-tab-missions",
      "mobile-nav-tab-chat",
    ]);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.queryByTestId("mobile-more-item-chat")).toBeNull();
  });

  /*
   * FN-511 : une sélection EXPLICITE de cinq destinations sans `chat` est rendue telle quelle, et le Chat redevient une
   * ligne du menu — seul moyen de le retirer du pied de page.
   */
  it("rend une sélection explicite de cinq destinations sans Chat et renvoie le Chat dans le menu", () => {
    const { container } = render(<OfficialMobileShell quickAccessItems={["command-center", "tasks", "missions", "mailbox", "planning"]} />);
    expect(tabTestIds(container)).toEqual([
      "mobile-nav-tab-command-center",
      "mobile-nav-tab-tasks",
      "mobile-nav-tab-missions",
      "mobile-nav-tab-mailbox",
      "mobile-nav-tab-planning",
    ]);
    expect(screen.queryByTestId("mobile-nav-tab-chat")).toBeNull();
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.getByTestId("mobile-more-item-chat")).toBeInTheDocument();
  });

  // (f) sélection peuplée et réordonnée → exactement ces destinations, dans cet ordre, puis le complément à cinq.
  it("respecte l'ordre exact d'une sélection personnalisée", () => {
    const { container } = render(<OfficialMobileShell quickAccessItems={["mailbox", "missions", "tasks"]} />);
    expect(tabTestIds(container)).toEqual([
      "mobile-nav-tab-mailbox",
      "mobile-nav-tab-missions",
      "mobile-nav-tab-tasks",
      "mobile-nav-tab-planning",
      "mobile-nav-tab-chat",
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
    expect(screen.queryByTestId("mobile-nav-tab-chat")).toBeNull();
    expect(pill(container).lastElementChild).toBe(screen.getByTestId("mobile-menu-trigger"));
  });

  /*
   * (h) aucune destination rendable → aucune coquille de bouton, le hamburger reste seul. FN-511 : le complément à cinq
   * rend les destinations par défaut toujours disponibles, donc la seule façon de vider la rangée est de rendre chaque
   * destination résolue inéligible — ici par la propriété du Header (FN-481) combinée à un drapeau désactivé.
   */
  it("ne laisse aucune coquille d'onglet quand aucune destination résolue n'est éligible", () => {
    const { container } = render(<OfficialMobileShell quickAccessItems={["memory"]} experimentalFeatures={{}} headerOwnedItems={["command-center", "tasks", "planning", "missions", "chat"]} />);
    expect(tabTestIds(container)).toEqual([]);
    expect(pill(container).children).toHaveLength(1);
    expect(pill(container).firstElementChild).toBe(screen.getByTestId("mobile-menu-trigger"));
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.getByTestId("mobile-more-item-mailbox")).toBeInTheDocument();
  });

  /*
   * (l) FN-511 : la répartition ne dépend PLUS de la largeur mesurée. Un téléphone en paysage, puis une tablette très
   * large, rendent exactement la sélection résolue — aucune destination non configurée n'est promue.
   */
  it("rend la même rangée quelle que soit la largeur, sans promouvoir de destination non configurée", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 844 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 390 });
    const landscape = render(<OfficialMobileShell quickAccessItems={["mailbox", "missions"]} />);
    const narrowRow = tabTestIds(landscape.container);
    expect(narrowRow).toEqual([
      "mobile-nav-tab-mailbox",
      "mobile-nav-tab-missions",
      "mobile-nav-tab-tasks",
      "mobile-nav-tab-planning",
      "mobile-nav-tab-chat",
    ]);
    landscape.unmount();

    mockViewport("tablet");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    const wide = render(<OfficialMobileShell quickAccessItems={["mailbox", "missions"]} />);
    expect(tabTestIds(wide.container)).toEqual(narrowRow);
    expect(screen.queryByTestId("mobile-nav-tab-files")).toBeNull();
    expect(screen.queryByTestId("mobile-nav-tab-git")).toBeNull();
    wide.unmount();
  });

  /*
   * FN-467 cas (j) : une rangée configurable peut renvoyer N'IMPORTE quelle destination dans le menu. Les quatre entrées
   * qui ignoraient jusqu'ici l'argument `surface` doivent donc naviguer ET refermer le popover, conformément à
   * FNXC:NativeShell 2026-09-09-22:40.
   */
  it.each([
    ["command-center", "mobile-more-item-command-center", "command-center"],
    /* FN-480 : sur mobile le slot persisté `tasks` rend et route List, le Board étant la surface de fond permanente. */
    ["tasks", "mobile-more-item-tasks", "list"],
    ["chat", "mobile-more-item-chat", "chat"],
    ["mailbox", "mobile-more-item-mailbox", "mailbox"],
  ])("navigue et referme le menu pour %s rendu dans la surface overflow", (_item, moreTestId, expectedView) => {
    const props = createDefaultProps();
    /* FN-511 : une sélection EXPLICITE de cinq destinations est nécessaire pour qu'aucun complément ne promeuve la destination testée. */
    render(<OfficialMobileShell {...props} quickAccessItems={["planning", "missions", "agents", "git", "files"]} />);
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

  /*
   * FN-480 — sur le shell mobile, le Board est la surface projet permanente sous les drawers, donc le slot d'accès
   * rapide persisté `tasks` rend et route **List**. Ces cas couvrent l'énumération de surfaces : onglet direct (a),
   * état actif (d) et retrait de l'ancien bouton codé en dur (e). Le cas (b) vit dans la table overflow ci-dessus.
   */
  // (a) onglet direct : reproduction du symptôme — le raccourci ne doit plus renvoyer vers la vue déjà affichée.
  it("rend le slot d'accès rapide `tasks` comme List et navigue vers la liste", () => {
    const props = createDefaultProps();
    render(<OfficialMobileShell {...props} />);

    const tab = screen.getByTestId("mobile-nav-tab-tasks");
    expect(tab).toHaveAttribute("aria-label", "List");

    fireEvent.click(tab);
    expect(props.onChangeView).toHaveBeenCalledWith("list");
    expect(props.onChangeView).not.toHaveBeenCalledWith("board");
  });

  // (d) état actif : `list` marque l'onglet, `board` n'en marque aucun (surface de fond, pas une destination).
  it("marque l'onglet `tasks` sur la vue liste et aucun onglet sur le Board", () => {
    const onList = render(<OfficialMobileShell view="list" />);
    expect(screen.getByTestId("mobile-nav-tab-tasks")).toHaveAttribute("aria-current", "page");
    expect(document.querySelectorAll('.mobile-nav-tab[aria-current="page"]')).toHaveLength(1);
    onList.unmount();

    render(<OfficialMobileShell view="board" />);
    expect(document.querySelectorAll('.mobile-nav-tab[aria-current="page"]')).toHaveLength(0);
  });

  // (e) retrait : plus aucun bouton List codé en dur, sur les quatre états de sélection, et aucune coquille ajoutée.
  it.each([
    ["sélection absente", undefined],
    ["tasks en accès rapide", ["tasks", "planning"]],
    ["tasks en menu", ["planning"]],
    ["sélection vide", []],
  ] as [string, string[] | undefined][])("ne rend plus de bouton List codé en dur (%s)", (_label, selection) => {
    const { container, unmount } = render(<OfficialMobileShell quickAccessItems={selection} />);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));

    expect(screen.queryByTestId("mobile-more-item-list")).toBeNull();
    expect(pill(container).lastElementChild).toBe(screen.getByTestId("mobile-menu-trigger"));
    const listProducers = [
      screen.queryByTestId("mobile-nav-tab-tasks"),
      screen.queryByTestId("mobile-more-item-tasks"),
    ].filter(Boolean);
    expect(listProducers).toHaveLength(1);
    unmount();
  });

  /*
   * FN-480 : le producteur téléphone de List est désormais le slot d'accès rapide `tasks`. Avec une sélection qui ne
   * le contient pas, il est rendu dans le menu sous `mobile-more-item-tasks` ; les assertions de focus/Escape, vrai
   * sujet de ce cas, sont inchangées.
   */
  it("opens the single navigation menu, routes List, and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    render(<OfficialMobileShell {...props} quickAccessItems={["planning", "missions", "agents", "git", "files"]} />);
    const trigger = screen.getByTestId("mobile-menu-trigger");
    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "Navigate" })).toHaveClass("mobile-navigation-popover");
    fireEvent.click(screen.getByTestId("mobile-more-item-tasks"));
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
   * désormais dans le menu. Un indicateur suit la SURFACE de sa destination : onglet quand elle est en accès direct,
   * ligne de menu sinon.
   *
   * FN-495 : le plafond descend à quatre, donc Mailbox quitte le défaut. La sélection explicite ci-dessous garde
   * Mailbox en onglet pour prouver l'indicateur d'onglet, et le second cas prouve qu'au défaut ses indicateurs
   * suivent la ligne du menu, comme le Chat.
   */
  it("preserves unread and planning indicators on official destinations", () => {
    const explicit = render(<OfficialMobileShell quickAccessItems={["command-center", "tasks", "planning", "mailbox"]} chatHasUnreadResponse mailboxUnreadCount={3} mailboxPendingApprovalCount={1} planningNeedsInput />);
    expect(screen.getByLabelText("Pending approvals")).toHaveClass("status-dot");
    expect(screen.getByLabelText("Planning needs your input")).toHaveClass("status-dot");
    expect(screen.getByText("3")).toHaveClass("mobile-nav-tab-badge");

    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.getByLabelText("Unread chat response")).toHaveClass("status-dot");
    explicit.unmount();

    render(<OfficialMobileShell chatHasUnreadResponse mailboxUnreadCount={3} mailboxPendingApprovalCount={1} planningNeedsInput />);
    expect(screen.getByLabelText("Planning needs your input")).toHaveClass("status-dot");
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    expect(screen.getByLabelText("Unread chat response")).toHaveClass("status-dot");
    expect(screen.getByLabelText("Pending approvals")).toHaveClass("status-dot");
    expect(screen.getByText("3")).toHaveClass("mobile-more-item-badge");
  });

  it("hides for modal, keyboard-independent hidden state, and desktop viewports", () => {
    const view = render(<OfficialMobileShell modalOpen />);
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
    view.rerender(<OfficialMobileShell hidden />);
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
    view.unmount();
    mockViewport("desktop");
    render(<OfficialMobileShell />);
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
  });

  /*
  Cas (u) — FN-468 : le montage de la pill est décidé par le prédicat de shell, pas par le seul mode `mobile`. La
  tablette n'était pas seulement masquée en CSS : le composant refusait de se monter. `modalOpen` et `hidden` ne
  sont PAS neutralisés par cet élargissement.
  */
  it("mounts on tablet as well as phone, never on desktop, and still obeys modalOpen and hidden", () => {
    for (const mode of ["mobile", "tablet"] as const) {
      mockViewport(mode);
      const mounted = render(<OfficialMobileShell />);
      expect(screen.queryByRole("navigation", { name: "Primary navigation" }), mode).not.toBeNull();
      expect(document.querySelectorAll(".mobile-nav-tab").length, `${mode} tabs`).toBeGreaterThan(0);
      expect(
        document.documentElement.style.getPropertyValue("--mobile-nav-height"),
        `${mode} published height`,
      ).not.toBe("");
      mounted.unmount();
    }

    mockViewport("tablet");
    const modal = render(<OfficialMobileShell modalOpen />);
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
    modal.unmount();

    const hiddenView = render(<OfficialMobileShell hidden />);
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
    hiddenView.unmount();

    mockViewport("desktop");
    render(<OfficialMobileShell />);
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--mobile-nav-height")).toBe("");
  });

  /*
  Cas (v) — FN-468 : l'état clavier de la barre mobile reste piloté par le téléphone (`isMobile`), donc sur tablette
  `keyboardOpen` vaut faux et ne peut pas supprimer la pill nouvellement montée.
  */
  it("keeps the tablet pill mounted because the phone keyboard state never applies there", () => {
    mockViewport("tablet");
    render(<OfficialMobileShell keyboardOpen={false} />);
    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(nav.className).not.toContain("mobile-nav-bar--keyboard-open");
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

  /* FN-480 : le producteur survivant de List dans le menu est `mobile-more-item-tasks` (slot hors accès rapide). */
  it("focuses once and routes the tapped destination without a navigation-history provider", () => {
    const navProps = { ...createDefaultProps(), quickAccessItems: ["planning", "missions", "agents", "git", "files"] };
    const view = render(<NavigationHistoryShell navProps={navProps} withProvider={false} mailboxUnreadCount={0} />);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));

    const popover = screen.getByRole("menu", { name: "Navigate" });
    exposeScrollPosition(popover, 96);
    view.rerender(<NavigationHistoryShell navProps={navProps} withProvider={false} mailboxUnreadCount={5} />);

    expect(menuFocusCalls(recordedFocus)).toHaveLength(1);
    expect(popover.scrollTop).toBe(96);
    fireEvent.click(screen.getByTestId("mobile-more-item-tasks"));
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

/*
FNXC:HeaderNavigationOwnership 2026-09-17-02:14:
FN-481 : « si le bouton d'accès est présent dans le header à cette vue, il ne doit pas être présent en plus dans le
footer ni dans "more" ». Ces cas prouvent le retrait des DEUX producteurs (rangée directe et menu) pour chaque
destination possédée par le Header, la conservation de toutes les autres, et le fait qu'une pill sans Header ne perd
rien.
*/
describe("MobileNavBar exclut les accès déjà possédés par le Header", () => {
  beforeEach(() => {
    mockViewport("mobile");
    vi.mocked(fetchScripts).mockReset();
    vi.mocked(fetchScripts).mockResolvedValue({});
  });

  function openMenuWith(props: Partial<React.ComponentProps<typeof MobileNavBar>> = {}) {
    const rendered = render(<OfficialMobileShell {...props} />);
    fireEvent.click(screen.getByTestId("mobile-menu-trigger"));
    return rendered;
  }

  it("garde toutes les destinations quand aucune propriété de Header n'est déclarée", () => {
    openMenuWith();
    for (const item of ["usage", "projects", "notes", "activity"]) {
      const inRow = screen.queryByTestId(`mobile-nav-tab-${item}`);
      const inMenu = screen.queryByTestId(MORE_TEST_IDS[item]!);
      expect(Boolean(inRow) || Boolean(inMenu)).toBe(true);
    }
  });

  it.each([
    ["téléphone", ["usage", "projects"]],
    ["tablette", ["usage", "projects", "notes", "activity"]],
  ])("retire les deux producteurs des destinations possédées en %s", (_label, owned) => {
    openMenuWith({ headerOwnedItems: owned });
    for (const item of owned) {
      expect(screen.queryByTestId(`mobile-nav-tab-${item}`)).toBeNull();
      expect(screen.queryByTestId(MORE_TEST_IDS[item]!)).toBeNull();
    }
  });

  it("conserve Notes et Activity en bas sur téléphone, où le Header ne les rend pas", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} headerOwnedItems={["usage", "projects"]} navigationMenuOpen onUiMenuOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId("mobile-more-item-notes"));
    expect(props.onChangeView).toHaveBeenCalledWith("notes");
    fireEvent.click(screen.getByTestId("mobile-more-item-activity"));
    expect(props.onOpenActivityLog).toHaveBeenCalled();
  });

  it("précède la répartition : une destination sélectionnée ET promouvable est retirée partout", () => {
    /* `settings` est à la fois sélectionnable en accès rapide et présent dans l'ordre de promotion. */
    const { container } = openMenuWith({
      quickAccessItems: ["settings", "planning"],
      headerOwnedItems: ["settings"],
    });

    expect(tabTestIds(container)).not.toContain("mobile-nav-tab-settings");
    expect(screen.queryByTestId("mobile-more-item-settings")).toBeNull();
    /* Le séparateur ne doit pas rester seul quand son unique groupe a disparu. */
    expect(document.querySelector(".mobile-more-separator")).toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-planning")).toBeInTheDocument();
  });

  it("n'ajoute aucun bouton vide et garde le hamburger en dernier", () => {
    const { container } = openMenuWith({ headerOwnedItems: ["usage", "projects", "notes", "activity"] });

    expect(pill(container).lastElementChild).toBe(screen.getByTestId("mobile-menu-trigger"));
    for (const button of Array.from(document.querySelectorAll<HTMLElement>(".mobile-more-item"))) {
      expect(button.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
    for (const tab of Array.from(container.querySelectorAll<HTMLElement>(".mobile-nav-bar--native > .mobile-nav-tab"))) {
      expect(tab.getAttribute("aria-label")?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("ne rend aucun bouton de repli inerte quand le callback de la destination est absent", () => {
    render(
      <MobileNavBar
        {...createDefaultProps()}
        onOpenUsage={undefined}
        onViewAllProjects={undefined}
        onOpenActivityLog={undefined}
        navigationMenuOpen
        onUiMenuOpenChange={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("mobile-more-item-usage")).toBeNull();
    expect(screen.queryByTestId("mobile-more-item-projects")).toBeNull();
    expect(screen.queryByTestId("mobile-more-item-activity")).toBeNull();
    /* Notes passe par le routage de vue existant et reste donc disponible. */
    expect(screen.getByTestId("mobile-more-item-notes")).toBeInTheDocument();
  });

  it("tolère une liste d'exclusions vide, dupliquée ou inconnue", () => {
    const { unmount } = openMenuWith({ headerOwnedItems: [] });
    expect(screen.getByTestId("mobile-more-item-usage")).toBeInTheDocument();
    unmount();

    openMenuWith({ headerOwnedItems: ["usage", "usage", "destination-inconnue"] });
    expect(screen.queryByTestId("mobile-more-item-usage")).toBeNull();
    expect(screen.getByTestId("mobile-more-item-projects")).toBeInTheDocument();
  });

  it("garde un focus utile quand la propriété du Header retire l'élément focalisé du menu ouvert", () => {
    const props = createDefaultProps();
    const view = render(<MobileNavBar {...props} headerOwnedItems={[]} navigationMenuOpen onUiMenuOpenChange={vi.fn()} />);

    const usageEntry = screen.getByTestId("mobile-more-item-usage");
    usageEntry.focus();
    expect(document.activeElement).toBe(usageEntry);

    view.rerender(<MobileNavBar {...props} headerOwnedItems={["usage"]} navigationMenuOpen onUiMenuOpenChange={vi.fn()} />);

    expect(screen.queryByTestId("mobile-more-item-usage")).toBeNull();
    const popover = screen.getByRole("menu", { name: "Navigate" });
    expect(popover.contains(document.activeElement)).toBe(true);
  });

  it("ne vole pas le focus lors d'un simple rafraîchissement sans changement de propriétaire", () => {
    const props = createDefaultProps();
    const view = render(<MobileNavBar {...props} headerOwnedItems={["usage"]} navigationMenuOpen onUiMenuOpenChange={vi.fn()} />);
    const notesEntry = screen.getByTestId("mobile-more-item-notes");
    notesEntry.focus();

    view.rerender(<MobileNavBar {...props} headerOwnedItems={["usage"]} navigationMenuOpen mailboxUnreadCount={3} onUiMenuOpenChange={vi.fn()} />);

    expect(document.activeElement).toBe(screen.getByTestId("mobile-more-item-notes"));
  });
});

/*
FNXC:MobileNavGesture 2026-09-17-16:53:
FN-511 supprime la suite « ouvre le Chat par un glissement du pied de page vers le haut » : le geste n'ouvre plus le
Chat, donc le sujet de ces cas a disparu du produit. La couverture du geste vit désormais dans
`MobileNavBar.menu-gesture.test.tsx`, où il ouvre le MENU de navigation derrière l'option projet
`mobileNavMenuSwipeGesture`.
*/

