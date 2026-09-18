import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOutsidePointerDismiss } from "../useOutsidePointerDismiss";

afterEach(cleanup);

/** Lets the hook's deferred capture turn (`setTimeout(..., 0)`) run, so a press with stopped propagation is decided. */
const flushDeferredTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface HostProps {
  open?: boolean;
  onDismiss: () => void;
  triggerSelector?: string;
  /** When false the surface root keeps no ref, so `ref.current` stays null. */
  attachRef?: boolean;
  children?: ReactNode;
}

function Host({ open = true, onDismiss, triggerSelector, attachRef = true, children }: HostProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { onPointerDownCapture } = useOutsidePointerDismiss({ open, onDismiss, surfaceRefs: [panelRef], triggerSelector });
  return (
    <div>
      <button type="button" data-testid="trigger" aria-controls="panel">Trigger</button>
      <button type="button" data-testid="board">Board</button>
      {open ? (
        <div ref={attachRef ? panelRef : undefined} data-testid="panel" onPointerDownCapture={onPointerDownCapture}>
          <button type="button" data-testid="inside">Inside</button>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/*
 * FN-491: this hook replaces the full-screen transparent backdrops that froze the board behind every non-modal
 * desktop panel. The contract it owns is exactly: an outside pointer dismisses, everything logically inside does
 * not, and nothing about scrolling ever dismisses.
 */
describe("useOutsidePointerDismiss", () => {
  it("dismisses on an outside pointerdown while letting the outside target act", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const boardClicked = vi.fn();
    render(
      <>
        <Host onDismiss={onDismiss} />
        <button type="button" data-testid="outside-board" onClick={boardClicked}>Board</button>
      </>,
    );

    await user.click(screen.getByTestId("outside-board"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(boardClicked).toHaveBeenCalledTimes(1);

    // FN-523: the deferred capture path must never re-decide an event the bubble path already owned.
    await flushDeferredTurn();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  /*
   * FN-523 symptom: `handleDragPointerDown` / `handleResizePointerDown` (FloatingWindow) and the
   * `useModalResizePersist` handle call `stopPropagation()` on the press, killing it before `document` bubble, so
   * starting to drag another window left every popover open. The deferred capture path decides those presses too.
   */
  it("dismisses on an outside pointerdown whose propagation is stopped before document", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <>
        <Host onDismiss={onDismiss} />
        <div
          data-testid="drag-handle"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          Header
        </div>
      </>,
    );

    await user.click(screen.getByTestId("drag-handle"));
    await flushDeferredTurn();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss when a PORTALLED descendant stops propagation on its own pointerdown", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <Host onDismiss={onDismiss}>
        {createPortal(
          <button type="button" data-testid="portal-greedy" onPointerDown={(event) => event.stopPropagation()}>Child</button>,
          document.body,
        )}
      </Host>,
    );

    await user.click(screen.getByTestId("portal-greedy"));
    await flushDeferredTurn();

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not dismiss when the trigger itself stops propagation", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <>
        <button type="button" data-testid="greedy-trigger" aria-controls="panel" onPointerDown={(event) => event.stopPropagation()}>Toggle</button>
        <Host onDismiss={onDismiss} triggerSelector='[aria-controls="panel"]' />
      </>,
    );

    await user.click(screen.getByTestId("greedy-trigger"));
    await flushDeferredTurn();

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not dismiss on a pointerdown inside the surface", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Host onDismiss={onDismiss} />);

    await user.click(screen.getByTestId("inside"));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps a portalled descendant usable without dismissing its host", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const childClicked = vi.fn();
    render(
      <Host onDismiss={onDismiss}>
        {createPortal(<button type="button" data-testid="portal-child" onClick={childClicked}>Child</button>, document.body)}
      </Host>,
    );

    await user.click(screen.getByTestId("portal-child"));

    expect(childClicked).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not dismiss inside a body-portalled model menu", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const menu = document.createElement("div");
    menu.className = "model-combobox-dropdown--portal";
    menu.innerHTML = '<button type="button" data-testid="model-option">Option</button>';
    document.body.appendChild(menu);

    render(<Host onDismiss={onDismiss} />);
    await user.click(screen.getByTestId("model-option"));

    expect(onDismiss).not.toHaveBeenCalled();
    menu.remove();
  });

  /*
   * Inside-ness is marked by EVENT IDENTITY, never by a boolean: a descendant that stops propagation prevents the
   * document listener from running at all, so a boolean would stay armed and swallow the next dismissal.
   */
  it("still dismisses after a descendant stopped propagation on its own pointerdown", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <>
        <Host onDismiss={onDismiss}>
          <button type="button" data-testid="greedy" onPointerDown={(event) => event.stopPropagation()}>Greedy</button>
        </Host>
        <button type="button" data-testid="outside-board">Board</button>
      </>,
    );

    await user.click(screen.getByTestId("greedy"));
    expect(onDismiss).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("outside-board"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss on the surface's own trigger when a triggerSelector is supplied", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Host onDismiss={onDismiss} triggerSelector='[aria-controls="panel"]' />);

    await user.click(screen.getByTestId("trigger"));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses on an outside pointerdown when no trigger matches the selector", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Host onDismiss={onDismiss} triggerSelector='[data-testid="absent-trigger"]' />);

    await user.click(screen.getByTestId("board"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses on an outside pointerdown when the surface ref holds null", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Host onDismiss={onDismiss} attachRef={false} />);

    await user.click(screen.getByTestId("board"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("observes nothing while closed", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Host open={false} onDismiss={onDismiss} />);

    await user.click(screen.getByTestId("board"));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("removes its document listener on unmount", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const { unmount } = render(
      <>
        <Host onDismiss={onDismiss} />
        <button type="button" data-testid="outside-board">Board</button>
      </>,
    );

    unmount();
    const survivor = document.createElement("button");
    survivor.addEventListener("pointerdown", (event) => event.stopPropagation());
    document.body.appendChild(survivor);
    await user.click(survivor);
    // A pending deferred turn must never outlive the surface.
    await flushDeferredTurn();

    expect(onDismiss).not.toHaveBeenCalled();
    survivor.remove();
  });

  it("never dismisses on wheel, scroll or touchmove", async () => {
    const onDismiss = vi.fn();
    render(<Host onDismiss={onDismiss} />);

    fireEvent.wheel(document, { deltaY: 240 });
    fireEvent.scroll(document);
    fireEvent.wheel(window, { deltaY: -240 });
    fireEvent.scroll(window);
    fireEvent.touchMove(document, { touches: [{ clientX: 10, clientY: 120 }] });
    fireEvent.resize(window);
    await flushDeferredTurn();

    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId("panel")).toBeInTheDocument();
  });
});
