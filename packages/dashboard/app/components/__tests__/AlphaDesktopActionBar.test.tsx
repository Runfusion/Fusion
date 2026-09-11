import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AlphaDesktopActionBar } from "../AlphaDesktopActionBar";
import { buildDashboardNavigationEntries } from "../dashboardNavigationEntries";

function entries(onChangeView = vi.fn()) { return buildDashboardNavigationEntries({ view: "board", onChangeView, onNewTask: vi.fn(), onOpenSettings: vi.fn(), showAgents: true }); }

describe("AlphaDesktopActionBar", () => {
  it("affiche le footer principal sans les destinations du dock ou de Done", () => {
    render(<AlphaDesktopActionBar entries={entries()} activeId="board" />);
    expect(screen.getByTestId("alpha-desktop-action-bar")).toBeInTheDocument();
    expect(screen.getByTestId("alpha-desktop-nav-board")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("alpha-desktop-nav-new-task")).toHaveAccessibleName("New Task");
    expect(screen.queryByTestId("alpha-desktop-nav-patchnode")).toBeNull();
    expect(screen.queryByTestId("alpha-desktop-nav-chat")).toBeNull();
    expect(screen.queryByTestId("alpha-desktop-nav-notes")).toBeNull();
  });

  it("garde l’overflow ouvert quand la garde refuse puis le ferme après acceptation", async () => {
    const onChangeView = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<AlphaDesktopActionBar entries={entries(onChangeView)} activeId="board" />);
    fireEvent.click(screen.getByTestId("alpha-desktop-nav-more"));
    fireEvent.click(screen.getByTestId("alpha-desktop-nav-automations"));
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("alpha-desktop-nav-automations"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onChangeView).toHaveBeenCalledTimes(2);
  });
});
