/**
 * FN-419 — Shell controls hosted by the left sidebar.
 *
 * In `sidebar` placement the shell has no bottom bar at all, so the engine control menu and the Terminal action must
 * live here or lose their only wide entry point. The dashboard window visibility toggle must NOT follow them: the
 * operator asked for it to disappear with the bottom bar.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LeftSidebarNav } from "../LeftSidebarNav";
import { useExecutorStats } from "../../hooks/useExecutorStats";

vi.mock("../../hooks/useExecutorStats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useExecutorStats")>();
  return { ...actual, useExecutorStats: vi.fn() };
});

const projects = [
  {
    id: "proj_1",
    name: "Project One",
    path: "/path/one",
    status: "active" as const,
    isolationMode: "in-process" as const,
    createdAt: "",
    updatedAt: "",
  },
];

function renderSidebar(overrides: Record<string, unknown> = {}) {
  return render(
    <LeftSidebarNav
      view="board"
      onChangeView={vi.fn()}
      onOpenSettings={vi.fn()}
      projects={projects}
      currentProject={projects[0]}
      onSelectProject={vi.fn()}
      onViewAllProjects={vi.fn()}
      projectId="proj_1"
      tasks={[]}
      {...overrides}
    />,
  );
}

describe("LeftSidebarNav shell controls", () => {
  beforeEach(() => {
    vi.mocked(useExecutorStats).mockReturnValue({
      stats: { runningTaskCount: 2, maxConcurrent: 5 } as never,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it("hosts the engine control menu with the shared capacity contract", () => {
    renderSidebar({ onToggleTerminal: vi.fn() });
    const capacity = screen.getByTestId("sidebar-capacity-count");
    expect(capacity).toBeInTheDocument();
    expect(capacity.textContent).toBe("2 / 5");
    expect(capacity.closest(".left-sidebar-nav__capacity")).not.toBeNull();
    expect(screen.getByLabelText("Engine controls: 2 / 5")).toBeInTheDocument();
  });

  it("omits the engine control host entirely when no project is present", () => {
    const { container } = renderSidebar({ projectId: undefined });
    expect(screen.queryByTestId("sidebar-capacity-count")).toBeNull();
    expect(container.querySelector(".left-sidebar-nav__capacity")).toBeNull();
  });

  it("calls onToggleTerminal exactly once per Terminal click", () => {
    const onToggleTerminal = vi.fn();
    renderSidebar({ onToggleTerminal });
    fireEvent.click(screen.getByTestId("sidebar-nav-terminal"));
    expect(onToggleTerminal).toHaveBeenCalledTimes(1);
  });

  it("leaves no Terminal button shell when no handler is supplied", () => {
    const { container } = renderSidebar();
    expect(screen.queryByTestId("sidebar-nav-terminal")).toBeNull();
    expect(container.querySelector(".left-sidebar-nav__terminal")).toBeNull();
    expect(container.querySelector('[aria-label="Terminal"]')).toBeNull();
  });

  it("never renders the dashboard window visibility toggle and leaves no empty footer shell", () => {
    const { container } = renderSidebar({ onToggleTerminal: vi.fn() });
    expect(screen.queryByTestId("dashboard-window-visibility-toggle")).toBeNull();
    expect(container.querySelector(".dashboard-window-visibility-toggle")).toBeNull();
    expect(container.querySelector(".dashboard-window-visibility-toggle__placeholder")).toBeNull();

    const footer = container.querySelector(".left-sidebar-nav__footer");
    const header = container.querySelector(".left-sidebar-nav__header");
    expect(footer).not.toBeNull();
    expect(header).not.toBeNull();
    for (const region of [footer!, header!]) {
      for (const button of Array.from(region.querySelectorAll("button"))) {
        const hasContent = button.textContent!.trim().length > 0 || button.querySelector("svg") !== null;
        expect(hasContent, `orphan button shell: ${button.getAttribute("data-testid") ?? button.outerHTML}`).toBe(true);
        expect(button.getAttribute("aria-label")?.trim() ?? "not-set").not.toBe("");
      }
    }
  });

  /*
  FNXC:Navigation 2026-09-16-20:52:
  FN-473 moved the collapse toggle into the sidebar header, so the footer's remaining order is capacity -> Terminal ->
  Settings and it must no longer contain the collapse affordance or a leftover wrapper where it used to sit.
  */
  it("orders the footer as capacity, Terminal, Settings with no collapse toggle left behind", () => {
    const { container } = renderSidebar({ onToggleTerminal: vi.fn() });
    const footer = container.querySelector(".left-sidebar-nav__footer")!;
    const order = Array.from(footer.children);
    const capacityIndex = order.findIndex((node) => node.classList.contains("left-sidebar-nav__capacity"));
    const terminalIndex = order.findIndex((node) => node.classList.contains("left-sidebar-nav__terminal"));
    const settingsIndex = order.findIndex((node) => node.classList.contains("left-sidebar-nav__settings"));
    expect(capacityIndex).toBeGreaterThanOrEqual(0);
    expect(capacityIndex).toBeLessThan(terminalIndex);
    expect(terminalIndex).toBeLessThan(settingsIndex);
    expect(settingsIndex).toBe(order.length - 1);
    expect(footer.querySelector(".left-sidebar-nav__collapse-toggle")).toBeNull();
    expect(footer.querySelector('[data-testid="sidebar-nav-collapse-toggle"]')).toBeNull();
    expect(container.querySelector(".left-sidebar-nav__header .left-sidebar-nav__collapse-toggle")).not.toBeNull();
  });
});
