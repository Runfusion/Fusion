import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  /*
  FNXC:DesktopNavigation 2026-09-15-07:00: Chat is a direct footer page again on operator request, so the bar renders
  it in the centered scroller and routes it to the chat page. Ported onto DesktopActionBar when upstream renamed the
  Alpha footer family and the old AlphaDesktopActionBar tests were deleted with the component.
  */
  it("renders Chat as a direct footer page destination", () => {
    const onChangeView = vi.fn();
    render(<DesktopActionBar entries={entries(onChangeView)} activeId="board" tasks={[]} />);
    const chat = screen.getByTestId("desktop-nav-chat");
    expect(chat).toHaveAccessibleName("Chat");
    expect(document.querySelector(".desktop-action-bar__scroller")).toContainElement(chat);
    fireEvent.click(chat);
    expect(onChangeView).toHaveBeenCalledWith("chat");
  });

  it("marks Chat as unread outside the Chat route", () => {
    const unread = render(<DesktopActionBar entries={entries(vi.fn(), { chatHasUnreadResponse: true })} activeId="board" tasks={[]} />);
    expect(unread.getByTestId("desktop-nav-chat").querySelector(".status-dot--pending")).not.toBeNull();
    unread.unmount();

    const onChatRoute = render(<DesktopActionBar entries={entries(vi.fn(), { view: "chat", chatHasUnreadResponse: true })} activeId="chat" tasks={[]} />);
    expect(onChatRoute.getByTestId("desktop-nav-chat").querySelector(".status-dot--pending")).toBeNull();
  });

  beforeEach(() => {
    vi.mocked(useExecutorStats).mockReturnValue({ stats: { runningTaskCount: 0, maxConcurrent: 4 } as never, loading: false, error: null, refresh: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    /*
    FNXC:DesktopNavigation 2026-09-15-07:00: Chat returned to the footer as a direct page destination on operator
    request; this assertion encoded FN-417's removal and is updated with the restored entry.
    */
    expect(screen.getByTestId("desktop-nav-chat")).toHaveAccessibleName("Chat");
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

  it("ne rend aucun trigger, panneau ou shell vide sans destination overflow", () => {
    const withoutOverflow = entries().filter((entry) => entry.placement !== "overflow");
    render(<DesktopActionBar entries={withoutOverflow} activeId="board" tasks={[]} />);
    expect(screen.queryByTestId("desktop-nav-more")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.querySelector(".desktop-action-bar__more")).toBeNull();
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
