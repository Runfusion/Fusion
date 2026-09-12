import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlphaDesktopActionBar } from "../AlphaDesktopActionBar";
import { useExecutorStats } from "../../hooks/useExecutorStats";
import { buildDashboardNavigationEntries } from "../dashboardNavigationEntries";
import { readAppFile } from "../../test/cssFixture";

const alphaDesktopActionBarCss = readAppFile("components/AlphaDesktopActionBar.css");

vi.mock("../../hooks/useExecutorStats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useExecutorStats")>();
  return { ...actual, useExecutorStats: vi.fn() };
});

function entries(onChangeView = vi.fn()) { return buildDashboardNavigationEntries({ view: "board", onChangeView, onNewTask: vi.fn(), onOpenSettings: vi.fn(), showAgents: true }); }

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

  it("garde l’overflow ouvert quand la garde refuse puis le ferme après acceptation", async () => {
    const onChangeView = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<AlphaDesktopActionBar entries={entries(onChangeView)} activeId="board" tasks={[]} />);
    fireEvent.click(screen.getByTestId("alpha-desktop-nav-more"));
    fireEvent.click(screen.getByTestId("alpha-desktop-nav-automations"));
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("alpha-desktop-nav-automations"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onChangeView).toHaveBeenCalledTimes(2);
  });
});
