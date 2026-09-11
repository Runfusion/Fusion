import "../../hero-ui-alpha.css";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Board } from "../Board";
import { writeBoardWorkflowsCache } from "../../utils/boardWorkflowsCache";
import { readAppFile } from "../../test/cssFixture";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchWorkflowSteps: vi.fn(() => new Promise<never>(() => {})),
    fetchBoardWorkflows: vi.fn(() => new Promise<never>(() => {})),
  };
});

const lanePayload = {
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  workflows: [{
    id: "builtin:coding",
    name: "Coding",
    columns: [
      { id: "triage", name: "Planning", flags: { intake: true } },
      { id: "todo", name: "Todo", flags: { hold: true } },
      { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
      { id: "in-review", name: "In review", flags: { mergeBlocker: true } },
      { id: "done", name: "Done", flags: { complete: true } },
    ],
  }],
  taskWorkflowIds: {},
};

function board(
  alphaUpdatesEnabled: boolean,
  tasks: ComponentProps<typeof Board>["tasks"] = [],
  overrides: Partial<ComponentProps<typeof Board>> = {},
) {
  return (
    <Board
      tasks={tasks}
      maxConcurrent={2}
      maxWorktrees={2}
      showWorktreeGrouping={false}
      onMoveTask={vi.fn()}
      onOpenDetail={vi.fn()}
      addToast={vi.fn()}
      onNewTask={vi.fn()}
      autoMerge
      onToggleAutoMerge={vi.fn()}
      planAutoApproveEnabled={false}
      onTogglePlanAutoApprove={vi.fn()}
      alphaUpdatesEnabled={alphaUpdatesEnabled}
      {...overrides}
    />
  );
}

describe("HeroUI Alpha Board", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    writeBoardWorkflowsCache(undefined, lanePayload);
  });

  it("renders loading and missing-workflow states through the Alpha surface", () => {
    window.sessionStorage.clear();
    const loading = render(board(true));
    expect(screen.getByTestId("board-workflows-skeleton")).toHaveAttribute("aria-busy", "true");
    expect(loading.container.querySelector('[data-heroui-alpha="surface"]')).not.toBeNull();
    loading.unmount();

    writeBoardWorkflowsCache(undefined, { ...lanePayload, workflows: [], defaultWorkflowId: "" });
    render(board(true));
    expect(screen.getByTestId("board-workflows-empty")).toHaveAccessibleName("No workflow lanes available");
  });

  it("covers duplicate, pagination-error, loading-more, and mobile Board states in Alpha", () => {
    const retry = vi.fn();
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const task = {
      id: "FN-DUPLICATE",
      title: "Carte dupliquée",
      description: "État mobile",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      sourceMetadata: { nearDuplicateOf: "FN-ORIGINAL" },
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    } as never;
    try {
      const view = render(board(true, [
        task,
        { ...task, id: "FN-ORIGINAL", title: "Carte originale", sourceMetadata: undefined },
      ], {
        currentTasksHasMore: true,
        currentTasksLoadingMore: true,
        currentTasksPaginationError: "request-failed",
        onRetryCurrentTasks: retry,
      }));
      expect(screen.getByText("Carte dupliquée")).toBeInTheDocument();
      expect(screen.getByText("Duplicate of FN-ORIGINAL")).toBeInTheDocument();
      expect(screen.getAllByText("Older tasks could not be loaded.").length).toBeGreaterThan(0);
      const retryButton = screen.getAllByRole("button", { name: "Retry" })[0];
      expect(retryButton).toHaveAttribute("data-heroui-alpha", "button");
      fireEvent.click(retryButton);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(view.container.querySelector('[data-heroui-alpha-surface="true"]')).not.toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    }
  });

  it("keeps production card status and portal styles stable across Fusion color themes", () => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.colorTheme = "cozy-cartoon";
    const task = {
      id: "FN-THEME",
      title: "Carte de statut",
      description: "Palette fixe",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      status: "queued",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    } as never;

    try {
      const view = render(board(true, [task], { onDeleteTask: vi.fn() }));
      const card = view.container.querySelector<HTMLElement>(".card");
      const statusBadge = view.container.querySelector<HTMLElement>(".card-status-badge--todo");
      expect(card).not.toBeNull();
      expect(statusBadge).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Planning column actions" }));
      const portal = screen.getByRole("menu", { name: "Planning column actions" });
      expect(portal).toHaveAttribute("data-heroui-alpha", "menu");

      const productionPalette = (element: Element) => {
        const style = getComputedStyle(element);
        return [
          style.getPropertyValue("--todo"),
          style.getPropertyValue("--status-todo-bg"),
          style.getPropertyValue("--color-info"),
          style.getPropertyValue("--color-error"),
          style.getPropertyValue("--focus-ring"),
        ];
      };
      const cardTheme = productionPalette(card!);
      expect(cardTheme).toEqual(Array.from({ length: 5 }, () => expect.stringMatching(/\S/)));
      expect(productionPalette(statusBadge!)).toEqual(cardTheme);
      expect(productionPalette(portal!)).toEqual(cardTheme);

      card!.focus();
      expect(card).toHaveFocus();
      const darkCardStyle = getComputedStyle(card!);
      const darkFocusRing = darkCardStyle.getPropertyValue("--focus-ring-strong");
      const darkAccent = darkCardStyle.getPropertyValue("--alpha-neutral-accent");
      expect(darkFocusRing).toMatch(/^\s*0 0 0 0\.125rem color-mix\(/);

      document.documentElement.dataset.colorTheme = "shadcn-purple";
      expect(productionPalette(card!)).toEqual(cardTheme);
      expect(productionPalette(statusBadge!)).toEqual(cardTheme);
      expect(productionPalette(portal!)).toEqual(cardTheme);
      expect(getComputedStyle(card!).getPropertyValue("--focus-ring-strong")).toBe(darkFocusRing);

      document.documentElement.dataset.theme = "light";
      const lightCardStyle = getComputedStyle(card!);
      expect(lightCardStyle.getPropertyValue("--focus-ring-strong")).toBe(darkFocusRing);
      expect(lightCardStyle.getPropertyValue("--alpha-neutral-accent")).not.toBe(darkAccent);
    } finally {
      document.documentElement.removeAttribute("data-theme");
      document.documentElement.removeAttribute("data-color-theme");
    }
  });

  it("keeps compact density scoped to Alpha without replacing Board interaction geometry", () => {
    const boardCss = readAppFile("components/Board.css");
    const columnCss = readAppFile("components/Column.css");
    const cardCss = readAppFile("components/TaskCard.css");
    expect(boardCss).toContain('[data-heroui-alpha-surface="true"] .board');
    expect(boardCss).toContain("--board-padding: var(--alpha-density-3)");
    expect(columnCss).toContain('[data-heroui-alpha-surface="true"] .column-header');
    expect(cardCss).toContain('[data-heroui-alpha-surface="true"] .card');
    expect(boardCss).not.toContain('[data-heroui-alpha-surface="true"] .board *');
    expect(columnCss).not.toContain("overflow-x: visible");
  });

  it("uses HeroUI controls only in Alpha while preserving empty and populated live boards", () => {
    const view = render(board(false));
    expect(screen.getByRole("main")).toHaveClass("board");
    expect(view.container.querySelector("[data-heroui-alpha]")).toBeNull();

    view.rerender(board(true, [{
      id: "FN-ALPHA",
      title: "Carte Alpha",
      description: "Carte peuplée",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    } as never]));
    expect(screen.getByRole("main")).toHaveClass("board");
    expect(screen.getByText("Carte Alpha")).toBeInTheDocument();
    expect(view.container.querySelector('[data-heroui-alpha="button"]')).not.toBeNull();
    expect(view.container.querySelector('[data-heroui-alpha="surface"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Planning column actions" }));
    expect(screen.getByRole("menu", { name: "Planning column actions" })).toHaveAttribute("data-heroui-alpha", "menu");

    view.rerender(board(false));
    expect(view.container.querySelector("[data-heroui-alpha]")).toBeNull();
    expect(screen.getByRole("main")).toHaveClass("board");
  });
});
