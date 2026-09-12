import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlphaDesktopActionBar } from "../AlphaDesktopActionBar";
import { useExecutorStats } from "../../hooks/useExecutorStats";
import { buildDashboardNavigationEntries, type DashboardNavigationRegistryOptions } from "../dashboardNavigationEntries";
import { readAppFile } from "../../test/cssFixture";

const alphaDesktopActionBarCss = readAppFile("components/AlphaDesktopActionBar.css");
const headerCss = readAppFile("components/Header.css");
const leftSidebarNavCss = readAppFile("components/LeftSidebarNav.css");
const mobileNavBarCss = readAppFile("components/MobileNavBar.css");
const overflowMenuRule = alphaDesktopActionBarCss.match(/\.alpha-desktop-action-bar__menu\s*\{([^}]*)\}/s)?.[1] ?? "";

vi.mock("../../hooks/useExecutorStats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useExecutorStats")>();
  return { ...actual, useExecutorStats: vi.fn() };
});

function entries(onChangeView = vi.fn(), overrides: Partial<DashboardNavigationRegistryOptions> = {}) {
  return buildDashboardNavigationEntries({ view: "board", onChangeView, onNewTask: vi.fn(), onOpenSettings: vi.fn(), showAgents: true, ...overrides });
}

function openOverflowMenu() {
  fireEvent.pointerEnter(screen.getByTestId("alpha-desktop-nav-more"));
  return screen.getByRole("menu");
}

function expectAscendingSingleColumnGeometry(menu: HTMLElement) {
  expect(menu).toHaveClass("alpha-desktop-action-bar__menu");
  expect(overflowMenuRule).toMatch(/bottom:\s*calc\(100% \+ var\(--space-sm\)\)/);
  expect(overflowMenuRule).toMatch(/grid-template-columns:\s*1fr/);
  expect(overflowMenuRule).toMatch(/grid-auto-flow:\s*row/);
  expect(overflowMenuRule).toMatch(/max-block-size:\s*calc\(100vh - var\(--space-3xl\) \* 3\)/);
  expect(overflowMenuRule).toMatch(/overflow-y:\s*auto/);
  expect(overflowMenuRule).not.toContain("repeat(3");
}

describe("AlphaDesktopActionBar", () => {
  beforeEach(() => {
    vi.mocked(useExecutorStats).mockReturnValue({ stats: { runningTaskCount: 0, maxConcurrent: 4 } as never, loading: false, error: null, refresh: vi.fn() });
  });

  it("affiche le footer principal sans les destinations du dock ou de Done", () => {
    render(<AlphaDesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    expect(screen.getByTestId("alpha-desktop-action-bar")).toBeInTheDocument();
    expect(screen.getByTestId("alpha-desktop-nav-board")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByTestId("alpha-desktop-nav-new-task")).toBeNull();
    expect(screen.getByTestId("alpha-desktop-capacity-count")).toHaveTextContent("0 / 4");
    expect(screen.getByTestId("alpha-desktop-nav-settings")).toHaveAccessibleName("Settings");
    expect(screen.queryByTestId("alpha-desktop-nav-patchnode")).toBeNull();
    expect(screen.queryByTestId("alpha-desktop-nav-chat")).toBeNull();
    expect(screen.queryByTestId("alpha-desktop-nav-notes")).toBeNull();
  });

  it("affiche honnêtement une capacité entièrement utilisée et ouvre ses réglages dans le viewport", () => {
    vi.mocked(useExecutorStats).mockReturnValue({ stats: { runningTaskCount: 3, maxConcurrent: 3 } as never, loading: false, error: null, refresh: vi.fn() });
    render(<AlphaDesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    expect(screen.getByTestId("alpha-desktop-capacity-count")).toHaveTextContent("3 / 3");
    fireEvent.click(screen.getByTestId("engine-control-menu-trigger"));
    expect(screen.getByTestId("engine-control-menu")).toBeInTheDocument();
    expect(alphaDesktopActionBarCss).toMatch(/\.alpha-desktop-action-bar__capacity \.engine-control-menu > \.engine-control-menu__popover\.card\s*\{[^}]*inset-inline-start:\s*0;[^}]*inset-inline-end:\s*auto;[^}]*min-inline-size:\s*min\(24rem,\s*calc\(100vw - \(var\(--space-lg\) \* 2\)\)\);[^}]*max-inline-size:\s*calc\(100vw - \(var\(--space-lg\) \* 2\)\);/s);
  });

  it("ne rend aucun trigger, panneau ou shell vide sans destination overflow", () => {
    const withoutOverflow = entries().filter((entry) => entry.placement !== "overflow");
    render(<AlphaDesktopActionBar entries={withoutOverflow} activeId="board" tasks={[]} />);
    expect(screen.queryByTestId("alpha-desktop-nav-more")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.querySelector(".alpha-desktop-action-bar__more")).toBeNull();
  });

  it("rend une destination sur une seule rangée ascendante", () => {
    const oneOverflowEntry = entries().filter((entry) => entry.placement !== "overflow" || entry.id === "automations");
    render(<AlphaDesktopActionBar entries={oneOverflowEntry} activeId="board" tasks={[]} />);
    const menu = openOverflowMenu();
    expect(menu.querySelectorAll(":scope > .alpha-desktop-action-bar__action")).toHaveLength(1);
    expect(screen.getByTestId("alpha-desktop-nav-automations")).toHaveAccessibleName("Automations");
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
    render(<AlphaDesktopActionBar entries={populatedEntries} activeId="board" tasks={[]} />);
    const menu = openOverflowMenu();
    const renderedItems = Array.from(menu.querySelectorAll<HTMLButtonElement>(":scope > .alpha-desktop-action-bar__action"));
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
    render(<AlphaDesktopActionBar entries={longEntries} activeId="board" tasks={[]} />);
    const menu = openOverflowMenu();
    expect(menu.querySelectorAll(":scope > .alpha-desktop-action-bar__action")).toHaveLength(overflowCount);
    expectAscendingSingleColumnGeometry(menu);
  });

  it("limite la géométrie ascendante au footer Alpha desktop", () => {
    expect(alphaDesktopActionBarCss).not.toMatch(/(?:\.header|\.left-sidebar-nav|\.mobile-nav-bar)[^{]*\{[^}]*(?:grid-template-columns|grid-auto-flow|bottom:)/s);
    for (const standardNavigationCss of [headerCss, leftSidebarNavCss, mobileNavBarCss]) {
      expect(standardNavigationCss).not.toContain("alpha-desktop-action-bar__menu");
    }
  });

  it("ouvre Plus au survol, conserve le trajet vers le menu et ferme à la sortie", () => {
    render(<AlphaDesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const trigger = screen.getByTestId("alpha-desktop-nav-more");
    fireEvent.pointerEnter(trigger);
    const menu = screen.getByRole("menu");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerEnter(menu);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerLeave(menu.parentElement!);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ouvre au focus ou au clic sans toggler, puis ferme avec Escape ou à la sortie du focus", () => {
    render(<AlphaDesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const trigger = screen.getByTestId("alpha-desktop-nav-more");
    fireEvent.focus(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.focus(trigger);
    const item = screen.getByTestId("alpha-desktop-nav-automations");
    fireEvent.blur(trigger, { relatedTarget: item });
    fireEvent.focus(item);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.focusOut(item, { relatedTarget: null });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("garde l’overflow ouvert quand la garde refuse puis le ferme après acceptation", async () => {
    const onChangeView = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<AlphaDesktopActionBar entries={entries(onChangeView)} activeId="board" tasks={[]} />);
    fireEvent.pointerEnter(screen.getByTestId("alpha-desktop-nav-more"));
    fireEvent.click(screen.getByTestId("alpha-desktop-nav-automations"));
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("alpha-desktop-nav-automations"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onChangeView).toHaveBeenCalledTimes(2);
  });
});
