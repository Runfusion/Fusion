import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardToolPopover } from "../DashboardToolPopover";

afterEach(cleanup);

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return { x: 0, y: 0, top: 40, bottom: 60, left: 900, right: 960, width: 60, height: 20, toJSON: () => ({}), ...overrides } as DOMRect;
}

/** Lets the hook's deferred capture turn run, so a press whose propagation was stopped is decided. */
const flushDeferredTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Reproduces the exact shape of `handleDragPointerDown` / `handleResizePointerDown` (FloatingWindow) and of the
 * `useModalResizePersist` handle: `preventDefault()` then `stopPropagation()`, which kills the press before it can
 * bubble to `document`.
 */
function GreedyDragHandle({ testId }: { testId: string }) {
  return (
    <div
      data-testid={testId}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      Header
    </div>
  );
}

function OpenPopover({ onClose, id, testId, children }: { onClose: () => void; id: string; testId: string; children?: React.ReactNode }) {
  return (
    <DashboardToolPopover open onClose={onClose} anchorRect={rect()} id={id} testId={testId} ariaLabel={id}>
      {children ?? <div data-testid={`${testId}-body`} />}
    </DashboardToolPopover>
  );
}

/** Host that really unmounts the panel on close, so the assertion is the panel LEAVING the DOM, not a spy alone. */
function ClosablePopoverHost({ id, testId, onClose }: { id: string; testId: string; onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <DashboardToolPopover
        open={open}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
        anchorRect={rect()}
        id={id}
        testId={testId}
        ariaLabel={id}
      >
        <div data-testid={`${testId}-body`} />
      </DashboardToolPopover>
      <GreedyDragHandle testId="window-drag-handle" />
    </>
  );
}

/*
 * FN-523 symptom, reported by the operator: a tool popover (Notes, Conversations, Activity) stayed open while another
 * floating window was being dragged, because the window's header press calls `stopPropagation()` and therefore never
 * reached the `document` bubble listener that owns the "outside press dismisses" rule. These cases assert the real
 * panel actually LEAVES the DOM for such a press, on every host id and at a narrow viewport, and that genuinely inside
 * presses — including one stopping its own propagation — still do not dismiss.
 */
describe("DashboardToolPopover — outside press that stops propagation", () => {
  it("se ferme quand un bandeau de fenêtre coupe la propagation de son pointerdown", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ClosablePopoverHost id="chat-panel" testId="chat-tool-popover" onClose={onClose} />);

    expect(screen.getByTestId("chat-tool-popover")).toBeInTheDocument();
    await user.click(screen.getByTestId("window-drag-handle"));
    await flushDeferredTurn();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("chat-tool-popover")).not.toBeInTheDocument();
  });

  // The rule lives in ONE shared component, so no host may have its own dismissal branch.
  it.each([
    ["activity-panel", "activity-tool-popover"],
    ["notes-panel", "notes-tool-popover"],
    ["chat-panel", "chat-tool-popover"],
  ])("ferme l'hôte %s, avec un contenu vide comme peuplé", async (id, testId) => {
    for (const children of [<div key="empty" />, <ul key="filled"><li>Une note</li><li>Une autre</li></ul>]) {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const { unmount } = render(
        <>
          <OpenPopover onClose={onClose} id={id} testId={testId}>{children}</OpenPopover>
          <GreedyDragHandle testId="window-drag-handle" />
        </>,
      );

      await user.click(screen.getByTestId("window-drag-handle"));
      await flushDeferredTurn();

      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  /*
   * Falsification control: this press was ALREADY dismissing before FN-523 (its propagation is intact), so it must
   * stay green both before and after the fix. If it ever fails, the deferred path broke the ordinary path.
   */
  it("contrôle : un appui extérieur ordinaire ferme déjà, et ne ferme qu'une fois", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <>
        <OpenPopover onClose={onClose} id="notes-panel" testId="notes-tool-popover" />
        <button type="button" data-testid="board-card">Card</button>
      </>,
    );

    await user.click(screen.getByTestId("board-card"));
    await flushDeferredTurn();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ne ferme pas sur un appui INTÉRIEUR qui coupe lui aussi la propagation", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <OpenPopover onClose={onClose} id="notes-panel" testId="notes-tool-popover">
        <button type="button" data-testid="inside-greedy" onPointerDown={(event) => event.stopPropagation()}>Renommer</button>
      </OpenPopover>,
    );

    await user.click(screen.getByTestId("inside-greedy"));
    await flushDeferredTurn();

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("notes-tool-popover")).toBeInTheDocument();
  });

  // Conversations is the only host mounted at every breakpoint; Activity and Notes are desktop-only.
  it("ferme Conversations au point de rupture étroit", async () => {
    const previousWidth = window.innerWidth;
    const previousHeight = window.innerHeight;
    window.innerWidth = 390;
    window.innerHeight = 780;
    try {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<ClosablePopoverHost id="chat-panel" testId="chat-tool-popover" onClose={onClose} />);

      await user.click(screen.getByTestId("window-drag-handle"));
      await flushDeferredTurn();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("chat-tool-popover")).not.toBeInTheDocument();
    } finally {
      window.innerWidth = previousWidth;
      window.innerHeight = previousHeight;
    }
  });
});
