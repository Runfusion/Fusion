import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopActionBar } from "../DesktopActionBar";
import { useExecutorStats } from "../../hooks/useExecutorStats";
import { buildDashboardNavigationEntries, type DashboardNavigationRegistryOptions } from "../dashboardNavigationEntries";
import { readAppFile } from "../../test/cssFixture";

const alphaDesktopActionBarCss = readAppFile("components/DesktopActionBar.css");
const headerCss = readAppFile("components/Header.css");
const leftSidebarNavCss = readAppFile("components/LeftSidebarNav.css");
const mobileNavBarCss = readAppFile("components/MobileNavBar.css");
const overflowMenuRule = alphaDesktopActionBarCss.match(/\.desktop-action-bar__menu\s*\{([^}]*)\}/s)?.[1] ?? "";
const overflowCorridorRule = alphaDesktopActionBarCss.match(/\.desktop-action-bar__more::before\s*\{([^}]*)\}/s)?.[1] ?? "";

/*
 * FN-467 : le centrage réel du groupe « rangée directe + More » n'est pas mesurable dans jsdom (aucune mise en page).
 * La preuve exécutable porte donc sur le CONTRAT de pistes déclaré par la feuille de style : on découpe la valeur en
 * pistes de premier niveau (parenthèses respectées) puis on compare la première et la dernière par égalité de chaînes.
 */
function ruleOf(css: string, selector: string): string {
  return css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

function declarationOf(rule: string, property: string): string {
  return rule.match(new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;]+)`))?.[1]?.trim() ?? "";
}

function splitTopLevelTracks(value: string): string[] {
  const tracks: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && /\s/.test(char)) {
      if (current.trim()) tracks.push(current.trim().replace(/\s+/g, " "));
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) tracks.push(current.trim().replace(/\s+/g, " "));
  return tracks;
}

vi.mock("../../hooks/useExecutorStats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useExecutorStats")>();
  return { ...actual, useExecutorStats: vi.fn() };
});

function entries(onChangeView = vi.fn(), overrides: Partial<DashboardNavigationRegistryOptions> = {}) {
  return buildDashboardNavigationEntries({ view: "board", onChangeView, onNewTask: vi.fn(), onOpenSettings: vi.fn(), showAgents: true, ...overrides });
}

function openOverflowMenu() {
  fireEvent.pointerEnter(screen.getByTestId("desktop-nav-more"));
  return screen.getByRole("menu");
}

function expectAscendingSingleColumnGeometry(menu: HTMLElement) {
  expect(menu).toHaveClass("desktop-action-bar__menu");
  expect(overflowMenuRule).toMatch(/inset-inline-start:\s*50%/);
  expect(overflowMenuRule).toMatch(/transform:\s*translateX\(-50%\)/);
  expect(overflowMenuRule).not.toMatch(/inset-inline-end:\s*0/);
  expect(overflowMenuRule).toMatch(/bottom:\s*calc\(100% \+ var\(--space-sm\)\)/);
  expect(overflowCorridorRule).toMatch(/inset-inline:\s*0/);
  expect(overflowCorridorRule).toMatch(/bottom:\s*100%/);
  expect(overflowCorridorRule).toMatch(/block-size:\s*var\(--space-sm\)/);
  expect(overflowMenuRule).toMatch(/grid-template-columns:\s*1fr/);
  expect(overflowMenuRule).toMatch(/grid-auto-flow:\s*row/);
  expect(overflowMenuRule).toMatch(/max-block-size:\s*calc\(100vh - var\(--space-3xl\) \* 3\)/);
  expect(overflowMenuRule).toMatch(/overflow-y:\s*auto/);
  expect(overflowMenuRule).not.toContain("repeat(3");
}

describe("DesktopActionBar", () => {
  beforeEach(() => {
    vi.mocked(useExecutorStats).mockReturnValue({ stats: { runningTaskCount: 0, maxConcurrent: 4 } as never, loading: false, error: null, refresh: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /*
   * FN-467 cas (a) — reproduction automatisée du symptôme : sur la base, `.desktop-action-bar` était un conteneur flex
   * sans AUCUNE piste latérale, donc l'extraction ci-dessous ne produisait rien et l'égalité des deux pistes échouait.
   */
  it("déclare deux pistes latérales strictement identiques autour du groupe centré", () => {
    const barRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar");
    expect(barRule).toBeTruthy();
    expect(declarationOf(barRule, "display")).toBe("grid");

    const tracks = splitTopLevelTracks(declarationOf(barRule, "grid-template-columns"));
    expect(tracks).toHaveLength(3);
    expect(tracks[0]).toBe(tracks[2]);
    expect(tracks[1]).toMatch(/^(auto|max-content|min-content|fit-content\(.*\))$/);
    expect(tracks[0]).not.toMatch(/\d+px/);

    const centerRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar__center");
    expect(declarationOf(centerRule, "grid-column")).toBe("2");

    const rightRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar__right");
    expect(rightRule).not.toMatch(/margin-inline-start:\s*auto/);
    expect(declarationOf(rightRule, "grid-column")).toBe("3");
    expect(declarationOf(rightRule, "margin-inline-end")).toBe("var(--touch-target-min-size)");

    const placeholderRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar > .dashboard-window-visibility-toggle__placeholder");
    expect(placeholderRule).toBeTruthy();
    expect(declarationOf(placeholderRule, "grid-column")).toBe("3");
    expect(declarationOf(placeholderRule, "grid-row")).toBe("1");
    expect(declarationOf(placeholderRule, "inline-size")).toBe("var(--touch-target-min-size)");
    expect(placeholderRule).not.toMatch(/\d+px/);
  });

  /* FN-467 cas (b) : les cinq accès rapides ET le déclencheur More appartiennent au même groupe centré, dans l'ordre persisté. */
  it("regroupe les accès rapides et More dans l'unique groupe centré", () => {
    render(<DesktopActionBar entries={entries(vi.fn(), { quickAccessEntryIds: ["mailbox", "missions", "board", "planning", "command-center"] })} activeId="board" tasks={[]} onToggleTerminal={vi.fn()} />);
    const centers = document.querySelectorAll(".desktop-action-bar__center");
    expect(centers).toHaveLength(1);
    const center = centers[0] as HTMLElement;

    expect(Array.from(center.querySelectorAll<HTMLElement>(".desktop-action-bar__action")).map((button) => button.dataset.testid)).toEqual([
      "desktop-nav-mailbox",
      "desktop-nav-missions",
      "desktop-nav-board",
      "desktop-nav-planning",
      "desktop-nav-command-center",
      "desktop-nav-more",
    ]);
    expect(center).not.toContainElement(screen.getByTestId("desktop-capacity-count"));
    expect(center).not.toContainElement(screen.getByTestId("desktop-nav-settings"));
    expect(center).not.toContainElement(screen.getByTestId("desktop-nav-terminal"));

    const menu = openOverflowMenu();
    for (const testId of ["desktop-nav-mailbox", "desktop-nav-missions", "desktop-nav-board", "desktop-nav-planning", "desktop-nav-command-center"]) {
      expect(within(menu).queryByTestId(testId)).toBeNull();
    }
  });

  /* FN-467 cas (c) : contrôle de breakpoint — le footer partagé tablette/ordinateur est le seul rendu, la pill mobile est masquée. */
  it("reste le seul propriétaire de navigation basse sur tablette et ordinateur", () => {
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    expect(screen.getByTestId("desktop-action-bar")).toBeInTheDocument();
    expect(document.querySelector(".mobile-nav-bar")).toBeNull();
    expect(mobileNavBarCss).toMatch(/html:is\(\[data-viewport-mode="tablet"\], \[data-viewport-mode="desktop"\]\) \.mobile-nav-bar\s*\{\s*display:\s*none/);
  });

  it("affiche le footer principal sans les destinations du dock ou de Done", () => {
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const footer = screen.getByTestId("desktop-action-bar");
    expect(footer).toBeInTheDocument();
    expect(footer.lastElementChild).toHaveClass("dashboard-window-visibility-toggle__placeholder");
    expect(screen.getByTestId("desktop-nav-board")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByTestId("desktop-nav-new-task")).toBeNull();
    expect(screen.getByTestId("desktop-capacity-count")).toHaveTextContent("0 / 4");
    expect(screen.getByTestId("desktop-nav-settings")).toHaveAccessibleName("Settings");
    expect(screen.queryByTestId("desktop-nav-terminal")).toBeNull();
    expect(document.querySelector(".desktop-action-bar__right")).toContainElement(screen.getByTestId("desktop-nav-settings"));
    expect(screen.queryByTestId("desktop-nav-patchnode")).toBeNull();
    expect(screen.queryByTestId("desktop-nav-chat")).toBeNull();
    expect(screen.queryByTestId("desktop-nav-notes")).toBeNull();
  });

  it("place un unique Terminal immédiatement avant Settings et appelle son propriétaire", () => {
    const onToggleTerminal = vi.fn();
    const populatedEntries = entries();
    const settings = populatedEntries.find((entry) => entry.id === "settings")!;
    render(<DesktopActionBar entries={[...populatedEntries, settings]} activeId="board" tasks={[]} onToggleTerminal={onToggleTerminal} />);

    const terminal = screen.getByTestId("desktop-nav-terminal");
    const renderedSettings = screen.getByTestId("desktop-nav-settings");
    expect(screen.getAllByTestId("desktop-nav-terminal")).toHaveLength(1);
    expect(screen.getAllByTestId("desktop-nav-settings")).toHaveLength(1);
    expect(terminal).toHaveAccessibleName("Terminal");
    expect(renderedSettings).toHaveAccessibleName("Settings");
    expect(terminal.nextElementSibling).toBe(renderedSettings);
    fireEvent.click(terminal);
    expect(onToggleTerminal).toHaveBeenCalledTimes(1);
  });

  it("omet Terminal et son shell quand le handler et Settings sont absents", () => {
    render(<DesktopActionBar entries={entries().filter((entry) => entry.id !== "settings")} activeId="board" tasks={[]} />);
    expect(screen.queryByTestId("desktop-nav-terminal")).toBeNull();
    expect(screen.queryByTestId("desktop-nav-settings")).toBeNull();
    expect(document.querySelector(".desktop-action-bar__right")).toBeNull();
  });

  it("conserve les actions droites hors du scroller avec une géométrie tokenisée", () => {
    const longEntries = entries(vi.fn(), {
      pluginDashboardViews: Array.from({ length: 30 }, (_, index) => ({
        pluginId: `plugin-${index}`,
        view: { viewId: "tool", label: `Plugin ${index}`, order: index },
      })),
    });
    render(<DesktopActionBar entries={longEntries} activeId="board" tasks={[]} onToggleTerminal={vi.fn()} />);
    const right = document.querySelector(".desktop-action-bar__right");
    expect(right).toContainElement(screen.getByTestId("desktop-nav-terminal"));
    expect(right).toContainElement(screen.getByTestId("desktop-nav-settings"));
    expect(document.querySelector(".desktop-action-bar__scroller")).not.toContainElement(screen.getByTestId("desktop-nav-terminal"));
    expect(alphaDesktopActionBarCss).toMatch(/\.desktop-action-bar__right\s*\{[^}]*gap:\s*var\(--space-xs\)/s);
  });

  it("affiche honnêtement une capacité entièrement utilisée et ouvre ses réglages dans le viewport", () => {
    vi.mocked(useExecutorStats).mockReturnValue({ stats: { runningTaskCount: 3, maxConcurrent: 3 } as never, loading: false, error: null, refresh: vi.fn() });
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    expect(screen.getByTestId("desktop-capacity-count")).toHaveTextContent("3 / 3");
    fireEvent.click(screen.getByTestId("engine-control-menu-trigger"));
    expect(screen.getByTestId("engine-control-menu")).toBeInTheDocument();
    expect(alphaDesktopActionBarCss).toMatch(/\.desktop-action-bar__capacity \.engine-control-menu > \.engine-control-menu__popover\.card\s*\{[^}]*inset-inline-start:\s*0;[^}]*inset-inline-end:\s*auto;[^}]*min-inline-size:\s*min\(24rem,\s*calc\(100vw - \(var\(--space-lg\) \* 2\)\)\);[^}]*max-inline-size:\s*calc\(100vw - \(var\(--space-lg\) \* 2\)\);/s);
  });

  /*
   * FN-446 : Agents quitte la rangée directe du pied de page (défaut d'accès rapide à cinq destinations) et devient une
   * entrée ordinaire du menu **More**, sans coquille de bouton ni `aria-label` orphelin laissé derrière lui.
   */
  it("place Agents dans le menu More et non dans le rail direct par défaut", async () => {
    const onChangeView = vi.fn().mockResolvedValue(true);
    render(<DesktopActionBar entries={entries(onChangeView)} activeId="board" tasks={[]} />);
    const scroller = document.querySelector(".desktop-action-bar__scroller")!;
    expect(Array.from(scroller.querySelectorAll<HTMLElement>(".desktop-action-bar__action")).map((button) => button.dataset.testid)).toEqual([
      "desktop-nav-command-center",
      "desktop-nav-board",
      "desktop-nav-planning",
      "desktop-nav-missions",
      "desktop-nav-mailbox",
    ]);
    expect(screen.queryByTestId("desktop-nav-agents")).toBeNull();
    expect(screen.queryByLabelText("Agents")).toBeNull();

    const menu = openOverflowMenu();
    const agentsEntry = within(menu).getByTestId("desktop-nav-agents");
    expect(agentsEntry).toHaveAccessibleName("Agents");
    fireEvent.click(agentsEntry);
    expect(onChangeView).toHaveBeenCalledWith("agents");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  /* FN-446 : une sélection personnalisée définit l'ordre exact des accès rapides rendus. */
  it("rend la rangée directe dans l'ordre de la sélection d'accès rapide", () => {
    render(<DesktopActionBar entries={entries(vi.fn(), { quickAccessEntryIds: ["mailbox", "agents", "board"] })} activeId="board" tasks={[]} />);
    const scroller = document.querySelector(".desktop-action-bar__scroller")!;
    expect(Array.from(scroller.querySelectorAll<HTMLElement>(".desktop-action-bar__action")).map((button) => button.dataset.testid)).toEqual([
      "desktop-nav-mailbox",
      "desktop-nav-agents",
      "desktop-nav-board",
    ]);
    expect(within(openOverflowMenu()).getByTestId("desktop-nav-command-center")).toBeInTheDocument();
  });

  /* FN-446 : une sélection entièrement gatée off ne doit laisser aucune rangée directe vide dans le pied de page. */
  it("ne rend aucune rangée directe vide quand la sélection ne résout aucune destination", () => {
    render(<DesktopActionBar entries={entries(vi.fn(), { showAgents: false, quickAccessEntryIds: ["agents"] })} activeId="board" tasks={[]} />);
    expect(document.querySelector(".desktop-action-bar__scroller")).toBeNull();
    expect(screen.getByTestId("desktop-nav-more")).toBeInTheDocument();
    expect(within(openOverflowMenu()).getByTestId("desktop-nav-board")).toBeInTheDocument();
  });

  it("ne rend aucun trigger, panneau ou shell vide sans destination overflow", () => {
    const withoutOverflow = entries().filter((entry) => entry.placement !== "overflow");
    render(<DesktopActionBar entries={withoutOverflow} activeId="board" tasks={[]} />);
    expect(screen.queryByTestId("desktop-nav-more")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.querySelector(".desktop-action-bar__more")).toBeNull();
  });

  /*
   * FN-439 cas (g) : le Header ne produit plus de bouton List sur tablette/ordinateur, donc le menu **More** du pied de
   * page en devient le propriétaire. La destination reste hors du rail direct, ferme le menu au clic et route vers
   * `list`.
   */
  it("expose List dans le menu More et non dans le rail direct", async () => {
    const onChangeView = vi.fn().mockResolvedValue(true);
    render(<DesktopActionBar entries={entries(onChangeView)} activeId="board" tasks={[]} />);
    expect(screen.queryByTestId("desktop-nav-list")).toBeNull();

    const menu = openOverflowMenu();
    const listEntry = within(menu).getByTestId("desktop-nav-list");
    expect(listEntry).toHaveAccessibleName("List");

    fireEvent.click(listEntry);
    expect(onChangeView).toHaveBeenCalledWith("list");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("marque List comme destination active quand la vue courante est list", () => {
    render(<DesktopActionBar entries={entries()} activeId="list" tasks={[]} />);
    const menu = openOverflowMenu();
    const listEntry = within(menu).getByTestId("desktop-nav-list");
    expect(listEntry).toHaveAttribute("aria-current", "page");
    expect(listEntry).toHaveClass("desktop-action-bar__action--active");
  });

  it("rend une destination sur une seule rangée ascendante", () => {
    const oneOverflowEntry = entries().filter((entry) => entry.placement !== "overflow" || entry.id === "automations");
    render(<DesktopActionBar entries={oneOverflowEntry} activeId="board" tasks={[]} />);
    const menu = openOverflowMenu();
    expect(menu.querySelectorAll(":scope > .desktop-action-bar__action")).toHaveLength(1);
    expect(screen.getByTestId("desktop-nav-automations")).toHaveAccessibleName("Automations");
    expectAscendingSingleColumnGeometry(menu);
  });

  it("conserve en colonne l’ordre des entrées statiques, optionnelles et plugins, même avec deux libellés identiques", () => {
    const populatedEntries = entries(vi.fn(), {
      showSkills: true,
      flags: { memory: true, whiteboard: true, goals: true, insights: true, research: true, ideation: true, evals: true },
      pluginDashboardViews: [
        { pluginId: "plugin-later", view: { viewId: "shared", label: "Shared label", order: 2 } },
        { pluginId: "plugin-earlier", view: { viewId: "shared", label: "Shared label", order: 1 } },
      ],
    });
    const expectedOverflow = populatedEntries.filter((entry) => entry.placement === "overflow");
    render(<DesktopActionBar entries={populatedEntries} activeId="board" tasks={[]} />);
    const menu = openOverflowMenu();
    const renderedItems = Array.from(menu.querySelectorAll<HTMLButtonElement>(":scope > .desktop-action-bar__action"));
    expect(renderedItems.map((item) => item.dataset.testid)).toEqual(expectedOverflow.map((entry) => entry.testId));
    expect(renderedItems.map((item) => item.getAttribute("aria-label"))).toEqual(expectedOverflow.map((entry) => entry.label));
    expect(screen.getAllByRole("button", { name: "Shared label" })).toHaveLength(2);
    expectAscendingSingleColumnGeometry(menu);
  });

  it("borne et fait défiler verticalement une longue liste sur une seule colonne", () => {
    const longEntries = entries(vi.fn(), {
      pluginDashboardViews: Array.from({ length: 30 }, (_, index) => ({
        pluginId: `plugin-${index}`,
        view: { viewId: "tool", label: `Plugin ${index}`, order: index },
      })),
    });
    const overflowCount = longEntries.filter((entry) => entry.placement === "overflow").length;
    render(<DesktopActionBar entries={longEntries} activeId="board" tasks={[]} />);
    const menu = openOverflowMenu();
    expect(menu.querySelectorAll(":scope > .desktop-action-bar__action")).toHaveLength(overflowCount);
    expectAscendingSingleColumnGeometry(menu);
  });

  it("limite la géométrie ascendante au footer Alpha desktop", () => {
    expect(alphaDesktopActionBarCss).not.toMatch(/(?:\.header|\.left-sidebar-nav|\.mobile-nav-bar)[^{]*\{[^}]*(?:grid-template-columns|grid-auto-flow|bottom:)/s);
    for (const standardNavigationCss of [headerCss, leftSidebarNavCss, mobileNavBarCss]) {
      expect(standardNavigationCss).not.toContain("desktop-action-bar__menu");
    }
  });

  it("conserve une traversée lente du gap puis ferme après une sortie complète", () => {
    vi.useFakeTimers();
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const trigger = screen.getByTestId("desktop-nav-more");
    fireEvent.pointerEnter(trigger);
    const menu = screen.getByRole("menu");
    const perimeter = menu.parentElement!;
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.pointerLeave(perimeter);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerEnter(menu);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.pointerLeave(perimeter);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("annule le timer de fermeture au démontage", () => {
    vi.useFakeTimers();
    const view = render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    fireEvent.pointerEnter(screen.getByTestId("desktop-nav-more"));
    const infrastructureTimerCount = vi.getTimerCount();
    fireEvent.pointerLeave(screen.getByRole("menu").parentElement!);
    expect(vi.getTimerCount()).toBe(infrastructureTimerCount + 1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ouvre au focus ou au clic sans toggler, puis ferme avec Escape ou à la sortie du focus", () => {
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const trigger = screen.getByTestId("desktop-nav-more");
    fireEvent.focus(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.focus(trigger);
    const item = screen.getByTestId("desktop-nav-automations");
    fireEvent.blur(trigger, { relatedTarget: item });
    fireEvent.focus(item);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.focusOut(item, { relatedTarget: null });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("garde l’overflow ouvert quand la garde refuse puis le ferme après acceptation", async () => {
    const onChangeView = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<DesktopActionBar entries={entries(onChangeView)} activeId="board" tasks={[]} />);
    fireEvent.pointerEnter(screen.getByTestId("desktop-nav-more"));
    fireEvent.click(screen.getByTestId("desktop-nav-automations"));
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("desktop-nav-automations"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onChangeView).toHaveBeenCalledTimes(2);
  });

  /*
  FNXC:PopoverLayering 2026-09-15-09:31:
  FN-413: while the More menu is open the footer must outrank every dashboard-managed window (shared stack at 10100+).
  The elevation is carried by the BAR because its `var(--z-sticky)` stacking context traps the absolutely positioned menu.
  */
  // (d)
  it("élève la barre au-dessus du plafond de fenêtres pendant l’ouverture du menu More", () => {
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const footer = screen.getByTestId("desktop-action-bar");
    expect(footer).not.toHaveClass("desktop-action-bar--menu-open");

    openOverflowMenu();
    expect(footer).toHaveClass("desktop-action-bar--menu-open");

    const openRule = alphaDesktopActionBarCss.match(/\.desktop-action-bar--menu-open\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(openRule).toMatch(/z-index:\s*calc\(var\(--fusion-max-z\)\s*\+\s*3\)/);
    const restRule = alphaDesktopActionBarCss.match(/\.desktop-action-bar\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(restRule).toMatch(/z-index:\s*var\(--z-sticky\)/);
  });

  // (e)
  it("retire le modificateur d’élévation sur chaque fermeture existante", async () => {
    const onChangeView = vi.fn().mockResolvedValue(true);
    const view = render(<DesktopActionBar entries={entries(onChangeView)} activeId="board" tasks={[]} />);
    const footer = screen.getByTestId("desktop-action-bar");
    const trigger = screen.getByTestId("desktop-nav-more");

    // Escape
    fireEvent.focus(trigger);
    expect(footer).toHaveClass("desktop-action-bar--menu-open");
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(footer).not.toHaveClass("desktop-action-bar--menu-open");

    // sortie de focus
    fireEvent.focus(trigger);
    expect(footer).toHaveClass("desktop-action-bar--menu-open");
    fireEvent.focusOut(trigger, { relatedTarget: null });
    expect(footer).not.toHaveClass("desktop-action-bar--menu-open");

    // sélection d’une entrée acceptée
    fireEvent.pointerEnter(trigger);
    expect(footer).toHaveClass("desktop-action-bar--menu-open");
    fireEvent.click(screen.getByTestId("desktop-nav-automations"));
    await waitFor(() => expect(footer).not.toHaveClass("desktop-action-bar--menu-open"));

    view.unmount();

    // expiration du délai de grâce après pointerLeave
    vi.useFakeTimers();
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const footer2 = screen.getByTestId("desktop-action-bar");
    fireEvent.pointerEnter(screen.getByTestId("desktop-nav-more"));
    expect(footer2).toHaveClass("desktop-action-bar--menu-open");
    fireEvent.pointerLeave(screen.getByRole("menu").parentElement!);
    act(() => vi.advanceTimersByTime(200));
    expect(footer2).not.toHaveClass("desktop-action-bar--menu-open");
  });

  // (i)
  it("ne rend ni conteneur overflow ni modificateur d’élévation sans destination overflow", () => {
    const withoutOverflow = entries().filter((entry) => entry.placement !== "overflow");
    render(<DesktopActionBar entries={withoutOverflow} activeId="board" tasks={[]} />);
    expect(document.querySelector(".desktop-action-bar__more")).toBeNull();
    expect(screen.getByTestId("desktop-action-bar")).not.toHaveClass("desktop-action-bar--menu-open");
    expect(document.querySelector(".desktop-action-bar--menu-open")).toBeNull();
  });

  /*
  FNXC:DesktopNavigation 2026-09-15-19:42:
  FN-432: ouvrir n’appartient qu’au survol du bouton More. Le corridor invisible au-dessus du bouton ne doit pas capter le
  pointeur au repos, mais doit continuer d’empêcher la fermeture pendant la traversée bouton → liste.
  */
  // (a)
  it("n’ouvre pas au survol du périmètre seul et ouvre au survol de More", () => {
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const trigger = screen.getByTestId("desktop-nav-more");
    const perimeter = document.querySelector<HTMLElement>(".desktop-action-bar__more")!;

    fireEvent.pointerEnter(perimeter);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(perimeter).not.toHaveClass("desktop-action-bar__more--open");

    fireEvent.pointerEnter(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(perimeter).toHaveClass("desktop-action-bar__more--open");
  });

  // (b)
  it("conserve le menu ouvert pendant la traversée du corridor vers la liste", () => {
    vi.useFakeTimers();
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const trigger = screen.getByTestId("desktop-nav-more");
    fireEvent.pointerEnter(trigger);
    const menu = screen.getByRole("menu");
    const perimeter = menu.parentElement!;

    fireEvent.pointerLeave(perimeter);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerEnter(perimeter);
    fireEvent.pointerEnter(menu);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  // (c)
  it("déclare un corridor inerte au repos et interactif seulement menu ouvert", () => {
    expect(overflowCorridorRule).toMatch(/pointer-events:\s*none/);
    expect(overflowCorridorRule).toMatch(/inset-inline:\s*0/);
    expect(overflowCorridorRule).toMatch(/bottom:\s*100%/);
    expect(overflowCorridorRule).toMatch(/block-size:\s*var\(--space-sm\)/);
    const openCorridorRule =
      alphaDesktopActionBarCss.match(/\.desktop-action-bar__more--open::before\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(openCorridorRule).toMatch(/pointer-events:\s*auto/);
  });

  // (d)
  it("ne rouvre pas depuis le périmètre seul après expiration de la grâce", () => {
    vi.useFakeTimers();
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const trigger = screen.getByTestId("desktop-nav-more");
    fireEvent.pointerEnter(trigger);
    const perimeter = screen.getByRole("menu").parentElement!;
    fireEvent.pointerLeave(perimeter);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.pointerEnter(perimeter);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.pointerEnter(screen.getByTestId("desktop-nav-more"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  // (f) exemption mobile: la feuille More du téléphone reste au tap, sans périmètre de survol.
  it("n’introduit aucun survol d’ouverture dans la navigation mobile", () => {
    const mobileNavBarSource = readAppFile("components/MobileNavBar.tsx");
    expect(mobileNavBarSource).not.toMatch(/onPointerEnter/);
    expect(mobileNavBarSource).not.toMatch(/onMouseEnter/);
  });

  // (l) structural invariant: no footer ancestor may create a stacking context, or the elevation is trapped.
  it("garde les ancêtres de mise en page du footer sans contexte d’empilement", () => {
    const projectSelectorCss = readAppFile("components/ProjectSelector.css");
    for (const selector of [".dashboard-project-stack", ".dashboard-project-shell"]) {
      const rule = projectSelectorCss.match(
        new RegExp(`\\${selector}\\s*\\{([\\s\\S]*?)\\n\\}`)
      )?.[1];
      expect(rule, `${selector} rule must exist`).toBeTruthy();
      const declarations = (rule ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const property of ["z-index", "transform", "filter", "contain", "isolation"]) {
        expect(declarations, `${selector} must not declare ${property}`).not.toMatch(
          new RegExp(`(^|[;{\\s])${property}\\s*:`)
        );
      }
    }
  });
});
