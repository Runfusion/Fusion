import { useState } from "react";
import { createPortal } from "react-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardToolPopover } from "../DashboardToolPopover";

afterEach(cleanup);

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return { x: 0, y: 0, top: 40, bottom: 60, left: 900, right: 960, width: 60, height: 20, toJSON: () => ({}), ...overrides } as DOMRect;
}

/*
 * FN-426: Activity and Notes moved out of the right dock into header-anchored panels, so this shared shell has to hold
 * the properties that make a panel a usable replacement for a docked tool: it mounts nothing while closed, stays
 * inside the viewport at every width, owns a bounded scroll, and returns focus to its trigger on dismissal.
 */
describe("DashboardToolPopover", () => {
  it("mounts no body while closed", () => {
    const body = vi.fn(() => <div data-testid="panel-body" />);
    render(<DashboardToolPopover open={false} onClose={vi.fn()} anchorRect={rect()} id="p" ariaLabel="Panel">{body()}</DashboardToolPopover>);
    expect(screen.queryByTestId("panel-body")).not.toBeInTheDocument();
  });

  it("anchors under its trigger, bounds its height, and exposes a dialog role", () => {
    window.innerWidth = 1280;
    window.innerHeight = 800;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect()} id="activity-panel" testId="tool-popover" ariaLabel="Activity Log"><div /></DashboardToolPopover>);

    const panel = screen.getByTestId("tool-popover");
    expect(panel).toHaveAttribute("role", "dialog");
    expect(panel).toHaveAttribute("aria-label", "Activity Log");
    expect(panel).toHaveAttribute("id", "activity-panel");
    // Right edge aligns with the trigger; top sits just below it; height is bounded by the viewport.
    expect(panel.style.top).toBe("68px");
    expect(panel.style.left).toBe("540px");
    expect(panel.style.maxHeight).toBe("724px");
    expect(panel).toHaveAttribute("data-placement", "below");
  });

  /*
   * FN-433: the bottom-bar Chat trigger lives in a bar fixed to `bottom: 0`, so its rect bottom is the window bottom.
   * Placing the panel below it put the whole dialog off-screen — the operator clicked Chat and saw nothing. These cases
   * assert the flip is driven by measured geometry and that the flipped panel is fully contained in the viewport.
   */
  it("flips above a bottom-bar anchor instead of rendering off-screen below it", () => {
    window.innerWidth = 1280;
    window.innerHeight = 800;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect({ top: 764, bottom: 800, left: 1100, right: 1180, height: 36 })} id="chat-panel" testId="tool-popover" ariaLabel="Conversations"><div /></DashboardToolPopover>);

    const panel = screen.getByTestId("tool-popover");
    expect(panel).toHaveAttribute("data-placement", "above");
    expect(panel.style.top).toBe("");
    expect(panel.style.bottom).toBe("44px");
    const maxHeight = Number.parseInt(panel.style.maxHeight, 10);
    expect(maxHeight).toBeLessThanOrEqual(756);
    // Bottom edge clears the trigger; top edge stays inside the viewport margin.
    expect(800 - 44).toBeLessThanOrEqual(764 - 8);
    expect(800 - 44 - maxHeight).toBeGreaterThanOrEqual(8);
  });

  it("keeps a bottom-bar anchor above and inside a short landscape-tablet viewport", () => {
    window.innerWidth = 1024;
    window.innerHeight = 640;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect({ top: 604, bottom: 640, left: 860, right: 940, height: 36 })} id="chat-panel" testId="tool-popover" ariaLabel="Conversations"><div /></DashboardToolPopover>);

    const panel = screen.getByTestId("tool-popover");
    expect(panel).toHaveAttribute("data-placement", "above");
    expect(panel.style.top).toBe("");
    const bottom = Number.parseInt(panel.style.bottom, 10);
    const maxHeight = Number.parseInt(panel.style.maxHeight, 10);
    expect(640 - bottom).toBeLessThanOrEqual(604 - 8);
    expect(640 - bottom - maxHeight).toBeGreaterThanOrEqual(8);
  });

  /*
   * FN-436: the bottom-bar Chat trigger is NOT the last action in its bar (Terminal, Settings and the window-visibility
   * toggle follow it), so aligning the panel's right edge with the trigger's left it ~100px short of the screen edge —
   * the operator reported it opening "too far left". `align="viewport-end"` pins it to the viewport's right edge, and
   * the default alignment must stay untouched for the header anchors.
   */
  it("pins a viewport-end panel to the right edge of a desktop viewport", () => {
    window.innerWidth = 1280;
    window.innerHeight = 800;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect({ top: 764, bottom: 800, left: 1100, right: 1180, height: 36 })} id="chat-panel" testId="tool-popover" ariaLabel="Conversations" align="viewport-end"><div /></DashboardToolPopover>);

    const panel = screen.getByTestId("tool-popover");
    expect(panel.style.left).toBe("852px");
    expect(Number.parseInt(panel.style.left, 10) + Number.parseInt(panel.style.width, 10)).toBe(1272);
    expect(panel).toHaveAttribute("data-placement", "above");
  });

  it("pins a viewport-end panel to the right edge of a landscape-tablet viewport", () => {
    window.innerWidth = 1024;
    window.innerHeight = 640;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect({ top: 604, bottom: 640, left: 860, right: 940, height: 36 })} id="chat-panel" testId="tool-popover" ariaLabel="Conversations" align="viewport-end"><div /></DashboardToolPopover>);

    const panel = screen.getByTestId("tool-popover");
    expect(Number.parseInt(panel.style.left, 10) + Number.parseInt(panel.style.width, 10)).toBe(1024 - 8);
  });

  it("keeps the anchor-end alignment for a header trigger when no align is requested", () => {
    window.innerWidth = 1280;
    window.innerHeight = 800;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect()} id="activity-panel" testId="tool-popover" ariaLabel="Activity Log"><div /></DashboardToolPopover>);
    expect(screen.getByTestId("tool-popover").style.left).toBe("540px");
  });

  it("keeps a viewport-end panel inside the viewport when no anchor rect is available", () => {
    window.innerWidth = 1280;
    window.innerHeight = 800;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={null} id="p" testId="tool-popover" ariaLabel="Panel" align="viewport-end"><div /></DashboardToolPopover>);

    const panel = screen.getByTestId("tool-popover");
    const left = Number.parseInt(panel.style.left, 10);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + Number.parseInt(panel.style.width, 10)).toBeLessThanOrEqual(1280);
  });

  it("shrinks a viewport-end panel instead of overflowing a narrow viewport", () => {
    window.innerWidth = 390;
    window.innerHeight = 640;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect({ right: 380 })} id="p" testId="tool-popover" ariaLabel="Panel" width={520} align="viewport-end"><div /></DashboardToolPopover>);

    const panel = screen.getByTestId("tool-popover");
    const left = Number.parseInt(panel.style.left, 10);
    const panelWidth = Number.parseInt(panel.style.width, 10);
    expect(panelWidth).toBeLessThanOrEqual(390 - 16);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + panelWidth).toBeLessThanOrEqual(390);
  });

  it("re-pins a viewport-end panel to the new right edge after a resize", () => {
    window.innerWidth = 1280;
    window.innerHeight = 800;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect({ top: 764, bottom: 800, left: 1100, right: 1180, height: 36 })} id="p" testId="tool-popover" ariaLabel="Panel" align="viewport-end"><div /></DashboardToolPopover>);
    expect(screen.getByTestId("tool-popover").style.left).toBe("852px");

    act(() => {
      window.innerWidth = 900;
      window.dispatchEvent(new Event("resize"));
    });

    const panel = screen.getByTestId("tool-popover");
    expect(Number.parseInt(panel.style.left, 10) + Number.parseInt(panel.style.width, 10)).toBe(900 - 8);
  });

  /*
   * FN-433: Chat's conversation list is virtualized and measures its container, so it needs a definite height; Activity
   * and Notes must stay content-sized, and the available space must always win over the requested height.
   */
  it("emits no height style unless a preferred height is requested", () => {
    window.innerWidth = 1280;
    window.innerHeight = 800;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel"><div /></DashboardToolPopover>);
    expect(screen.getByTestId("tool-popover").style.height).toBe("");
  });

  it("applies a requested height when the available space allows it", () => {
    window.innerWidth = 1280;
    window.innerHeight = 800;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect({ top: 764, bottom: 800, left: 1100, right: 1180, height: 36 })} id="p" testId="tool-popover" ariaLabel="Panel" preferredHeight={560}><div /></DashboardToolPopover>);
    expect(screen.getByTestId("tool-popover").style.height).toBe("560px");
  });

  it("bounds a requested height by the space actually available", () => {
    window.innerWidth = 1280;
    window.innerHeight = 420;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect({ top: 384, bottom: 420, left: 1100, right: 1180, height: 36 })} id="p" testId="tool-popover" ariaLabel="Panel" preferredHeight={560}><div /></DashboardToolPopover>);

    const panel = screen.getByTestId("tool-popover");
    const height = Number.parseInt(panel.style.height, 10);
    expect(height).toBeLessThan(560);
    expect(height).toBe(Number.parseInt(panel.style.maxHeight, 10));
  });

  it("stays below and inside the viewport when no anchor rect is available", () => {
    window.innerWidth = 1280;
    window.innerHeight = 800;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={null} id="p" testId="tool-popover" ariaLabel="Panel"><div /></DashboardToolPopover>);

    const panel = screen.getByTestId("tool-popover");
    expect(panel).toHaveAttribute("data-placement", "below");
    expect(panel.style.bottom).toBe("");
    const top = Number.parseInt(panel.style.top, 10);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + Number.parseInt(panel.style.maxHeight, 10)).toBeLessThanOrEqual(800);
  });

  it("re-resolves the placement of a low anchor when the window shrinks", () => {
    window.innerWidth = 1280;
    window.innerHeight = 1200;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect({ top: 764, bottom: 800, left: 1100, right: 1180, height: 36 })} id="p" testId="tool-popover" ariaLabel="Panel"><div /></DashboardToolPopover>);
    expect(screen.getByTestId("tool-popover")).toHaveAttribute("data-placement", "below");

    act(() => {
      window.innerHeight = 800;
      window.dispatchEvent(new Event("resize"));
    });

    const panel = screen.getByTestId("tool-popover");
    expect(panel).toHaveAttribute("data-placement", "above");
    expect(panel.style.top).toBe("");
    expect(panel.style.bottom).toBe("44px");
  });

  it("keeps the panel inside a narrow viewport instead of overflowing it", () => {
    window.innerWidth = 390;
    window.innerHeight = 640;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect({ right: 380 })} id="p" testId="tool-popover" ariaLabel="Panel" width={520}><div /></DashboardToolPopover>);

    const panel = screen.getByTestId("tool-popover");
    expect(Number.parseInt(panel.style.width, 10)).toBeLessThanOrEqual(390 - 16);
    expect(Number.parseInt(panel.style.left, 10)).toBeGreaterThanOrEqual(8);
  });

  it("re-anchors when the window is resized", () => {
    window.innerWidth = 1280;
    window.innerHeight = 800;
    render(<DashboardToolPopover open onClose={vi.fn()} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel"><div /></DashboardToolPopover>);
    const before = screen.getByTestId("tool-popover").style.left;

    act(() => {
      window.innerWidth = 600;
      window.innerHeight = 500;
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByTestId("tool-popover").style.left).not.toBe(before);
    expect(Number.parseInt(screen.getByTestId("tool-popover").style.maxHeight, 10)).toBeLessThanOrEqual(500);
  });

  // (7)
  it("Échap ferme et rend le focus au déclencheur", async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>Open</button>
          <DashboardToolPopover open={open} onClose={() => setOpen(false)} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel">
            <button type="button" data-testid="inside">Inside</button>
          </DashboardToolPopover>
        </>
      );
    }
    render(<Host />);

    await user.click(screen.getByTestId("trigger"));
    expect(screen.getByTestId("tool-popover")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("tool-popover")).not.toBeInTheDocument();
    expect(screen.getByTestId("trigger")).toHaveFocus();
  });

  /*
   * FN-491: the panel is NON-modal, so it must never freeze the board behind it. It used to mount a full-screen
   * transparent backdrop purely to catch the outside click; that pane swallowed wheel, touch scrolling and every
   * click, so clicking a card only closed the panel and the operator had to click twice. Dismissal now comes from the
   * shared `useOutsidePointerDismiss` hook and NO layer is mounted at all, which is what these cases prove.
   */
  // (1)
  it("ne monte aucun calque plein écran pendant l'ouverture", () => {
    render(
      <DashboardToolPopover open onClose={vi.fn()} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel">
        <div />
      </DashboardToolPopover>,
    );

    expect(screen.getByTestId("tool-popover")).toBeInTheDocument();
    expect(document.querySelectorAll(".dashboard-tool-popover__backdrop")).toHaveLength(0);
    expect(screen.queryByTestId("tool-popover-backdrop")).not.toBeInTheDocument();
  });

  // (2)
  it.each([
    ["ancre d'en-tête", {} as { anchorRect?: DOMRect }],
    ["ancre de barre basse", { anchorRect: rect({ top: 764, bottom: 800, left: 1100, right: 1180, height: 36 }) }],
  ])("ferme sur pointerdown extérieur (%s) tout en laissant le board recevoir son clic", async (_label, overrides) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const boardClicked = vi.fn();
    render(
      <>
        <button type="button" data-testid="board-card" onClick={boardClicked}>Card</button>
        <DashboardToolPopover
          open
          onClose={onClose}
          anchorRect={overrides.anchorRect ?? rect()}
          id="p"
          testId="tool-popover"
          ariaLabel="Panel"
          align={overrides.anchorRect ? "viewport-end" : undefined}
          preferredHeight={overrides.anchorRect ? 560 : undefined}
        >
          <div />
        </DashboardToolPopover>
      </>,
    );

    await user.click(screen.getByTestId("board-card"));

    expect(boardClicked).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // (3)
  it("ne ferme pas sur pointerdown intérieur", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const insideClicked = vi.fn();
    render(
      <DashboardToolPopover open onClose={onClose} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel">
        <button type="button" data-testid="inside" onClick={insideClicked}>Inside</button>
      </DashboardToolPopover>,
    );

    await user.click(screen.getByTestId("inside"));

    expect(insideClicked).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  /*
   * A child that portals itself elsewhere (a native select popup, a nested menu) must stay usable: it is a logical
   * child in the React tree, so the shared hook marks its pointerdown as inside.
   */
  // (4)
  it("garde un enfant portalisé utilisable", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const clicked = vi.fn();
    render(
      <DashboardToolPopover open onClose={onClose} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel">
        {createPortal(<button type="button" data-testid="portal-child" onClick={clicked}>Child</button>, document.body)}
      </DashboardToolPopover>,
    );

    await user.click(screen.getByTestId("portal-child"));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  // (5)
  it("ne ferme pas sur le déclencheur et ne rouvre pas", async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            data-testid="trigger"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? "p" : undefined}
            onClick={() => setOpen((value) => !value)}
          >
            Open
          </button>
          <DashboardToolPopover open={open} onClose={() => setOpen(false)} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel">
            <div />
          </DashboardToolPopover>
        </>
      );
    }
    render(<Host />);

    await user.click(screen.getByTestId("trigger"));
    expect(screen.getByTestId("tool-popover")).toBeInTheDocument();

    await user.click(screen.getByTestId("trigger"));
    expect(screen.queryByTestId("tool-popover")).not.toBeInTheDocument();
    // A dismissal on pointerdown followed by the trigger's own click would re-open it in the same gesture.
    expect(screen.queryByTestId("tool-popover")).not.toBeInTheDocument();
  });

  // (5b)
  it("ferme sur pointerdown extérieur quand le déclencheur est absent du DOM", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <>
        <button type="button" data-testid="board-card">Card</button>
        <DashboardToolPopover open onClose={onClose} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel">
          <div />
        </DashboardToolPopover>
      </>,
    );
    expect(document.querySelector('[aria-controls="p"]')).toBeNull();

    await user.click(screen.getByTestId("board-card"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // (6)
  it("ne ferme pas au défilement", () => {
    const onClose = vi.fn();
    render(
      <DashboardToolPopover open onClose={onClose} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel">
        <div />
      </DashboardToolPopover>,
    );

    fireEvent.wheel(document, { deltaY: 240 });
    fireEvent.scroll(document);
    fireEvent.wheel(window, { deltaY: -240 });
    fireEvent.scroll(window);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("tool-popover")).toBeInTheDocument();
  });

  // (8)
  it("ferme sur pointerdown extérieur sans ancre mesurée", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <>
        <button type="button" data-testid="board-card">Card</button>
        <DashboardToolPopover open onClose={onClose} anchorRect={null} id="p" testId="tool-popover" ariaLabel="Panel">
          <div />
        </DashboardToolPopover>
      </>,
    );

    await user.click(screen.getByTestId("board-card"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // (9)
  it.each([1280, 760])("aucun calque bloquant à %ipx de large", async (width) => {
    window.innerWidth = width;
    window.innerHeight = 800;
    const user = userEvent.setup();
    const onClose = vi.fn();
    const boardClicked = vi.fn();
    render(
      <>
        <button type="button" data-testid="board-card" onClick={boardClicked}>Card</button>
        <DashboardToolPopover open onClose={onClose} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel">
          <div />
        </DashboardToolPopover>
      </>,
    );

    expect(document.querySelectorAll(".dashboard-tool-popover__backdrop")).toHaveLength(0);
    expect(screen.queryByTestId("tool-popover-backdrop")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("board-card"));
    expect(boardClicked).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /*
   * Inside-ness is marked by EVENT IDENTITY: a descendant that stops propagation prevents the document listener from
   * running at all, so a boolean marker would stay armed and swallow the next outside dismissal.
   */
  // (10)
  it("un descendant qui stoppe la propagation ne bloque pas la fermeture suivante", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <>
        <button type="button" data-testid="board-card">Card</button>
        <DashboardToolPopover open onClose={onClose} anchorRect={rect()} id="p" testId="tool-popover" ariaLabel="Panel">
          <button type="button" data-testid="greedy" onPointerDown={(event) => event.stopPropagation()}>Greedy</button>
        </DashboardToolPopover>
      </>,
    );

    await user.click(screen.getByTestId("greedy"));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("board-card"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
