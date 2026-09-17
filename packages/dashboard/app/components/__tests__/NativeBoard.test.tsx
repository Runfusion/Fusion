import "../../native-ui.css";
import "../../ui-style-tokens.css";
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
  _legacyAlphaValue: boolean,
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
      planAutoApproveEnabled={false}
      onTogglePlanAutoApprove={vi.fn()}
      {...overrides}
    />
  );
}

describe("homemade Alpha Board", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    writeBoardWorkflowsCache(undefined, lanePayload);
  });

  it("renders loading and missing-workflow states through the Alpha surface", () => {
    window.sessionStorage.clear();
    const loading = render(board(true));
    expect(screen.getByTestId("board-workflows-skeleton")).toHaveAttribute("aria-busy", "true");
    expect(loading.container.querySelector('[data-ui="surface"]')).not.toBeNull();
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
      expect(retryButton).toHaveAttribute("data-ui", "button");
      fireEvent.click(retryButton);
      expect(retry).toHaveBeenCalledTimes(1);
      // FNXC:NativeUiPresentation 2026-09-15-00:20: no perimeter element wraps Board any more, so the assertion is on Board's own root.
      expect(view.container.querySelector(".board")).not.toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    }
  });

  /*
  FNXC:NativeUiPresentation 2026-09-15-00:20:
  This case used to assert Board's colours were IDENTICAL across Fusion colour themes — which was the
  defect, not the contract: the boundary pinned a fixed palette so a theme change could not reach a card,
  badge or portaled menu. FN-399 removes that palette, so the invariant is inverted here to the structural
  proof JSDOM can give (no stylesheet on this tree pins a semantic colour token), and the real computed
  colour comparison across themes lives in the browser lane.
  */
  it("pins no semantic colour of its own, so the selected theme reaches cards, badges and portals", () => {
    const nativeCss = readAppFile("native-ui.css").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const token of ["--bg", "--surface", "--card", "--border", "--text", "--accent", "--todo", "--triage", "--in-progress", "--in-review", "--done", "--status-todo-bg", "--color-error", "--color-info"]) {
      expect(nativeCss).not.toContain(`${token}:`);
    }
    for (const stylesheet of ["components/Board.css", "components/Column.css", "components/TaskCard.css"]) {
      const css = readAppFile(stylesheet).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css).not.toContain("--alpha-neutral-");
      expect(css).not.toMatch(/--(?:todo|triage|in-progress|in-review|done|accent|text|bg|border)\s*:/);
    }
  });

  it("renders a themed card, badge and portaled column menu from real Board data", () => {
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
      expect(portal).toHaveAttribute("data-ui", "menu");

      // The card stays focusable and the theme attributes remain free to change under it.
      card!.focus();
      expect(card).toHaveFocus();

      document.documentElement.dataset.colorTheme = "shadcn-purple";
      expect(card).toHaveFocus();
      expect(statusBadge).toBeInTheDocument();
      expect(portal).toHaveAttribute("data-ui", "menu");

      document.documentElement.dataset.theme = "light";
      expect(card).toHaveFocus();
      expect(portal).toHaveAttribute("data-ui", "menu");
    } finally {
      document.documentElement.removeAttribute("data-theme");
      document.documentElement.removeAttribute("data-color-theme");
    }
  });

  /*
  FNXC:NativeDensity 2026-09-15-00:20:
  Board density comes from the interface-style catalogue instead of a boundary-scoped block. The guard it
  always carried stays: density must never be applied through a blanket universal descendant selector, and
  Board keeps its own horizontal overflow ownership.
  */
  it("takes its density from the style catalogue without blanket-styling Board descendants", () => {
    const boardCss = readAppFile("components/Board.css");
    const columnCss = readAppFile("components/Column.css");
    const cardCss = readAppFile("components/TaskCard.css");
    expect(boardCss).toContain(".board");
    expect(boardCss).toContain("--board-padding: var(--ui-density-md)");
    expect(columnCss).toContain(".column-header");
    expect(cardCss).toContain(".card");
    expect(columnCss).not.toContain("overflow-x: visible");

    // The only universal descendant rule is FN-194's text-selection suppression, which sets no dimension.
    const universalBlocks = [...boardCss.matchAll(/\.board \*[^{]*\{([^}]*)\}/g)].map((match) => match[1]);
    for (const block of universalBlocks) {
      expect(block).not.toMatch(/(padding|margin|gap|font-size|border-radius)\s*:/);
    }
  });

  it("uses official controls while preserving empty and populated live boards", () => {
    const view = render(board(false));
    expect(screen.getByRole("main")).toHaveClass("board");
    expect(view.container.querySelector('[data-ui="surface"]')).not.toBeNull();

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
    expect(view.container.querySelector('[data-ui="button"]')).not.toBeNull();
    expect(view.container.querySelector('[data-ui="surface"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Planning column actions" }));
    expect(screen.getByRole("menu", { name: "Planning column actions" })).toHaveAttribute("data-ui", "menu");

    view.rerender(board(false));
    expect(view.container.querySelector('[data-ui="surface"]')).not.toBeNull();
    expect(screen.getByRole("main")).toHaveClass("board");
  });
});
