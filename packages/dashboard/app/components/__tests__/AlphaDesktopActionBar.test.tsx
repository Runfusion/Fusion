import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AlphaDesktopActionBar } from "../AlphaDesktopActionBar";
import { buildDashboardNavigationEntries } from "../dashboardNavigationEntries";

function entries(onChangeView = vi.fn()) { return buildDashboardNavigationEntries({ view: "board", onChangeView, onOpenPilot: vi.fn(), onNewTask: vi.fn(), onOpenSettings: vi.fn(), showAgents: true }); }

describe("AlphaDesktopActionBar", () => {
  it("affiche les actions directes avec libellés et état actif", () => {
    render(<AlphaDesktopActionBar entries={entries()} activeId="patchnode" />);
    expect(screen.getByTestId("alpha-desktop-action-bar")).toBeInTheDocument();
    expect(screen.getByTestId("alpha-desktop-nav-patchnode")).toHaveTextContent("History");
    expect(screen.getByTestId("alpha-desktop-nav-patchnode")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("alpha-desktop-nav-new-task")).toHaveAccessibleName("New Task");
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
