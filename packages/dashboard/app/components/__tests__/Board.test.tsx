import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Board } from "../Board";
import { COLUMNS } from "@kb/core";

// Mock child components so we only test Board's own rendering
vi.mock("../Column", () => ({
  Column: ({ column }: { column: string }) => (
    <div data-testid={`column-${column}`} />
  ),
}));

const noop = () => {};
const noopAsync = () => Promise.resolve({} as any);

function renderBoard() {
  return render(
    <Board
      tasks={[]}
      maxConcurrent={2}
      onMoveTask={noopAsync}
      onOpenDetail={noop}
      addToast={noop}
      isCreating={false}
      onCancelCreate={noop}
      onCreateTask={noopAsync}
      onNewTask={noop}
      autoMerge={true}
      onToggleAutoMerge={noop}
      globalPaused={false}
    />,
  );
}

describe("Board", () => {
  it("renders a <main> element with class 'board'", () => {
    renderBoard();
    const main = screen.getByRole("main");
    expect(main).toBeDefined();
    expect(main.className).toContain("board");
  });

  it("renders with id='board' for scroll targeting", () => {
    renderBoard();
    const main = screen.getByRole("main");
    expect(main.id).toBe("board");
  });

  it("renders all 5 columns", () => {
    renderBoard();
    for (const col of COLUMNS) {
      expect(screen.getByTestId(`column-${col}`)).toBeDefined();
    }
  });

  it("renders all 5 columns as direct children of .board (CSS selector target)", () => {
    renderBoard();
    const board = screen.getByRole("main");
    // The mock Column renders <div data-testid="column-{col}" />, which are direct children
    const directChildren = Array.from(board.children);
    expect(directChildren).toHaveLength(COLUMNS.length);
    // Each direct child should be one of the column test-id elements
    for (const col of COLUMNS) {
      const colEl = screen.getByTestId(`column-${col}`);
      expect(colEl.parentElement).toBe(board);
    }
  });

  it("renders the board element as a <main> tag (semantic structure)", () => {
    renderBoard();
    const board = screen.getByRole("main");
    expect(board.tagName).toBe("MAIN");
  });
});
