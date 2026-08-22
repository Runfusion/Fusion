import { useState } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBoardMousePan } from "../useBoardMousePan";

function PanHarness({ enabled = true, onClick = vi.fn() }: { enabled?: boolean; onClick?: () => void }) {
  const [boardElement, setBoardElement] = useState<HTMLElement | null>(null);
  const { isPanning, ...bindings } = useBoardMousePan(boardElement, enabled);
  return (
    <main ref={setBoardElement} className={isPanning ? "is-mouse-panning" : ""} data-panning={String(isPanning)} data-testid="board" onClick={onClick} {...bindings}>
      <p data-testid="empty-text">No tasks</p>
      <div data-testid="surface">Safe surface</div>
      <button type="button" data-testid="button">Button</button>
      <input aria-label="Editable" data-testid="input" />
      <div contentEditable data-testid="contenteditable">Editable content</div>
      <div draggable data-testid="draggable">Draggable</div>
      <article data-id="FN-1" data-testid="card">Card</article>
    </main>
  );
}

function renderPanHarness(enabled = true, onClick = vi.fn()) {
  const result = render(<PanHarness enabled={enabled} onClick={onClick} />);
  const board = result.getByTestId("board");
  Object.defineProperties(board, {
    clientWidth: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: 600 },
  });
  return { ...result, board };
}

function pointerDown(target: HTMLElement, clientX = 100, clientY = 50, pointerId = 1, pointerType = "mouse", button = 0) {
  fireEvent.pointerDown(target, { button, clientX, clientY, pointerId, pointerType });
}

function pointerMove(target: HTMLElement, clientX: number, clientY = 50, pointerId = 1, pointerType = "mouse") {
  fireEvent.pointerMove(target, { clientX, clientY, pointerId, pointerType });
}

function pointerUp(target: HTMLElement, pointerId = 1, pointerType = "mouse") {
  fireEvent.pointerUp(target, { button: 0, clientX: 100, clientY: 50, pointerId, pointerType });
}

describe("useBoardMousePan", () => {
  it("pans safe descendants and the root by inverse horizontal delta in both directions", () => {
    const { board, getByTestId } = renderPanHarness();
    board.scrollLeft = 100;

    pointerDown(getByTestId("empty-text"));
    pointerMove(getByTestId("empty-text"), 140);
    expect(board.scrollLeft).toBe(60);
    expect(board).toHaveAttribute("data-panning", "true");
    pointerUp(getByTestId("empty-text"));

    board.scrollLeft = 100;
    pointerDown(board, 100, 50, 2);
    pointerMove(board, 70, 50, 2);
    expect(board.scrollLeft).toBe(130);
  });

  it("leaves excluded interactive, editable, native-draggable, and task surfaces native", () => {
    const { board, getByTestId } = renderPanHarness();
    board.scrollLeft = 100;

    for (const [index, target] of ["button", "input", "contenteditable", "draggable", "card"].map(getByTestId).entries()) {
      pointerDown(target, 100, 50, index + 1);
      pointerMove(target, 40, 50, index + 1);
      pointerUp(target, index + 1);
    }

    expect(board.scrollLeft).toBe(100);
    expect(board).toHaveAttribute("data-panning", "false");
  });

  it("is inert when disabled for mobile and for touch, pen, or non-primary input", () => {
    const onClick = vi.fn();
    const { board, getByTestId, rerender } = renderPanHarness(false, onClick);
    board.scrollLeft = 100;
    const surface = getByTestId("surface");

    pointerDown(surface);
    pointerMove(surface, 40);
    pointerUp(surface);
    fireEvent.click(surface);
    expect(board.scrollLeft).toBe(100);
    expect(board).toHaveAttribute("data-panning", "false");
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<PanHarness />);
    board.scrollLeft = 100;
    for (const [pointerType, pointerId] of [["touch", 1], ["pen", 2]] as const) {
      pointerDown(getByTestId("surface"), 100, 50, pointerId, pointerType);
      pointerMove(getByTestId("surface"), 40, 50, pointerId, pointerType);
      pointerUp(getByTestId("surface"), pointerId, pointerType);
    }
    pointerDown(getByTestId("surface"), 100, 50, 3, "mouse", 2);
    pointerMove(getByTestId("surface"), 40, 50, 3);
    expect(board.scrollLeft).toBe(100);
  });

  it("does not pan before horizontal intent, without overflow, or after a stationary edgeward pointer", () => {
    const { board, getByTestId } = renderPanHarness();
    const surface = getByTestId("surface");
    board.scrollLeft = 100;

    pointerDown(surface);
    pointerMove(surface, 103);
    pointerMove(surface, 104, 110);
    pointerUp(surface);
    expect(board.scrollLeft).toBe(100);

    Object.defineProperty(board, "scrollWidth", { configurable: true, value: 200 });
    pointerDown(surface, 100, 50, 2);
    pointerMove(surface, 190, 50, 2);
    pointerUp(surface, 2);
    expect(board.scrollLeft).toBe(100);

    Object.defineProperty(board, "scrollWidth", { configurable: true, value: 600 });
    pointerDown(surface, 100, 50, 3);
    pointerMove(surface, 190, 50, 3);
    const scrollAfterMove = board.scrollLeft;
    pointerUp(surface, 3);
    expect(board.scrollLeft).toBe(scrollAfterMove);
  });

  it("suppresses one compatibility click after a pan and cleans up cancellation, lost capture, and unmount", () => {
    const onClick = vi.fn();
    const { board, getByTestId, unmount } = renderPanHarness(true, onClick);
    const surface = getByTestId("surface");
    const setPointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => true);
    const releasePointerCapture = vi.fn();
    Object.defineProperties(board, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: hasPointerCapture },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    });

    pointerDown(surface);
    pointerMove(surface, 140);
    pointerUp(surface);
    fireEvent.click(surface);
    fireEvent.click(surface);
    expect(onClick).toHaveBeenCalledTimes(1);

    pointerDown(surface, 100, 50, 2);
    pointerMove(surface, 140, 50, 2);
    fireEvent.pointerCancel(surface, { pointerId: 2 });
    expect(board).toHaveAttribute("data-panning", "false");
    fireEvent.click(surface);

    pointerDown(surface, 100, 50, 3);
    pointerMove(surface, 140, 50, 3);
    fireEvent.lostPointerCapture(surface, { pointerId: 3 });
    expect(board).toHaveAttribute("data-panning", "false");
    fireEvent.click(surface);

    pointerDown(surface, 100, 50, 4);
    unmount();
    expect(setPointerCapture).toHaveBeenCalledWith(4);
    expect(releasePointerCapture).toHaveBeenCalledWith(4);
    expect(onClick).toHaveBeenCalledTimes(3);
  });
});
