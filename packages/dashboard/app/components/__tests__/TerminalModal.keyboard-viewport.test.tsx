import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { TerminalModal } from "../TerminalModal";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";
import { _resetKeyboardViewportStore } from "../../utils/mobileKeyboardViewport";

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 terminal geometry. The terminal has its own presentation and its own historical baseline
machinery, so it needs its own proof that it answers from the SHARED measurement:

  - WebKit shape (layout stays tall, visual shrinks): reserve exactly the occluded band;
  - Android resizes-content shape (layout already reduced): reserve NOTHING, because a bar anchored
    at `bottom: 0` is already visible and any reservation is dead space;
  - a first sample that is already keyboard-open must not invent a lift from the device screen.

The terminal's layout must be published BEFORE xterm re-fits, or xterm measures the pre-keyboard box
and the 10px/12px terminals wrap into spaced glyphs. That ordering is asserted here too.

jsdom performs no layout, so these drive metric pairs and assert published CSS variables. They are not
evidence of a rendered Safari layout, and nothing here raises a real keyboard.
*/

const mockOnClose = vi.fn();

vi.mock("../../api", () => ({
  createTerminalSession: vi.fn().mockResolvedValue({ id: "s1" }),
  killPtyTerminalSession: vi.fn().mockResolvedValue({ killed: true }),
  listTerminalSessions: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../hooks/useWorkspaces", () => ({ useWorkspaces: () => ({ workspaces: [], loading: false }) }));
vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn(function TerminalMock() { return {}; }) }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn(function FitAddonMock() { return {}; }) }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: vi.fn(function WebLinksMock() { return {}; }) }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: vi.fn(function WebglMock() { return {}; }) }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

interface ViewportControl {
  listeners: Record<string, Array<() => void>>;
  set(next: { layoutHeight: number; innerHeight?: number; visualHeight: number; offsetTop?: number; visualWidth?: number }): void;
}

const restores: Array<() => void> = [];

function define(target: object, key: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else delete (target as Record<string, unknown>)[key];
  });
}

function installMobileViewport({
  layoutHeight,
  visualHeight,
  visualWidth = 390,
  screenSize,
}: {
  layoutHeight: number;
  visualHeight: number;
  visualWidth?: number;
  screenSize?: { width: number; height: number };
}): ViewportControl {
  define(window, "ontouchstart", null);
  define(window.navigator, "maxTouchPoints", 5);
  if (screenSize) define(window, "screen", screenSize);

  const listeners: Record<string, Array<() => void>> = { resize: [], scroll: [] };
  const mockVV = {
    width: visualWidth,
    height: visualHeight,
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
    addEventListener: vi.fn((event: string, cb: () => void) => { listeners[event]?.push(cb); }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };

  define(window, "visualViewport", mockVV);
  define(window, "innerWidth", visualWidth);
  define(window, "innerHeight", layoutHeight);
  define(document.documentElement, "clientHeight", layoutHeight);
  define(document.documentElement, "clientWidth", visualWidth);

  return {
    listeners,
    set(next) {
      Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: next.innerHeight ?? next.layoutHeight });
      Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: next.layoutHeight });
      Object.defineProperty(mockVV, "height", { configurable: true, writable: true, value: next.visualHeight });
      Object.defineProperty(mockVV, "offsetTop", { configurable: true, writable: true, value: next.offsetTop ?? 0 });
      if (next.visualWidth !== undefined) {
        Object.defineProperty(mockVV, "width", { configurable: true, writable: true, value: next.visualWidth });
      }
      act(() => {
        for (const cb of listeners.resize) cb();
      });
    },
  };
}

/**
 * `--keyboard-overlap` is written only while something is genuinely occluded, so "nothing reserved"
 * is the ABSENCE of the variable, not a `0px` value. Normalize that for readable assertions.
 */
function readOverlap() {
  return screen.getByTestId("terminal-modal").style.getPropertyValue("--keyboard-overlap") || "0px";
}

function focusEditor() {
  const editor = document.createElement("textarea");
  document.body.append(editor);
  act(() => editor.focus());
  return editor;
}

beforeEach(() => {
  _resetInitialViewportHeight();
  _resetKeyboardViewportStore();
  mockOnClose.mockClear();
});

afterEach(() => {
  cleanup();
  _resetKeyboardViewportStore();
  _resetInitialViewportHeight();
  while (restores.length > 0) restores.pop()?.();
});

describe("TerminalModal keyboard geometry", () => {
  it("reserves exactly the occluded band when only the visual viewport shrinks", async () => {
    const viewport = installMobileViewport({ layoutHeight: 844, visualHeight: 844 });
    render(<TerminalModal isOpen onClose={mockOnClose} />);
    const editor = focusEditor();

    viewport.set({ layoutHeight: 844, visualHeight: 500 });

    await waitFor(() => expect(readOverlap()).toBe("344px"));
    editor.remove();
  });

  it("reserves nothing once the layout viewport has already been reduced", async () => {
    // Android interactive-widget=resizes-content, with innerHeight lagging behind.
    const viewport = installMobileViewport({ layoutHeight: 844, visualHeight: 844 });
    render(<TerminalModal isOpen onClose={mockOnClose} />);
    const editor = focusEditor();

    viewport.set({ layoutHeight: 500, innerHeight: 844, visualHeight: 500 });

    await waitFor(() => expect(readOverlap()).toBe("0px"));
    editor.remove();
  });

  it("does not invent a lift from the device screen on a first already-keyboard-open sample", async () => {
    // The whole layout viewport is already 390 tall; a bar at bottom: 0 is visible.
    installMobileViewport({ layoutHeight: 390, visualHeight: 390, screenSize: { width: 390, height: 844 } });
    const editor = focusEditor();

    render(<TerminalModal isOpen onClose={mockOnClose} />);

    await waitFor(() => expect(readOverlap()).toBe("0px"));
    editor.remove();
  });

  it("moves the reservation with a positive offsetTop instead of stacking two offsets", async () => {
    const viewport = installMobileViewport({ layoutHeight: 844, visualHeight: 844 });
    render(<TerminalModal isOpen onClose={mockOnClose} />);
    const editor = focusEditor();

    viewport.set({ layoutHeight: 844, visualHeight: 500, offsetTop: 40 });

    await waitFor(() => expect(readOverlap()).toBe("304px"));
    editor.remove();
  });

  it("restores the resting geometry exactly after close and reopen of the keyboard", async () => {
    const viewport = installMobileViewport({ layoutHeight: 844, visualHeight: 844 });
    render(<TerminalModal isOpen onClose={mockOnClose} />);
    const editor = focusEditor();

    viewport.set({ layoutHeight: 844, visualHeight: 500 });
    await waitFor(() => expect(readOverlap()).toBe("344px"));

    act(() => editor.blur());
    viewport.set({ layoutHeight: 844, visualHeight: 844 });
    await waitFor(() => expect(readOverlap()).toBe("0px"));

    act(() => editor.focus());
    viewport.set({ layoutHeight: 844, visualHeight: 500 });
    await waitFor(() => expect(readOverlap()).toBe("344px"));

    act(() => editor.blur());
    viewport.set({ layoutHeight: 844, visualHeight: 844 });
    await waitFor(() => expect(readOverlap()).toBe("0px"));
    editor.remove();
  });

  it("publishes the visible width and height alongside the reservation", async () => {
    const viewport = installMobileViewport({ layoutHeight: 844, visualHeight: 844 });
    render(<TerminalModal isOpen onClose={mockOnClose} />);
    const editor = focusEditor();

    viewport.set({ layoutHeight: 844, visualHeight: 500, visualWidth: 360 });

    await waitFor(() => {
      const modal = screen.getByTestId("terminal-modal");
      expect(modal.style.getPropertyValue("--vv-height")).toBe("500px");
      expect(modal.style.getPropertyValue("--vv-width")).toBe("360px");
    });
    editor.remove();
  });

  it("never scrolls the page to compensate for the keyboard", async () => {
    const viewport = installMobileViewport({ layoutHeight: 844, visualHeight: 844 });
    const windowScrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(<TerminalModal isOpen onClose={mockOnClose} />);
    const editor = focusEditor();
    const modal = screen.getByTestId("terminal-modal");
    const scrollIntoView = vi.fn();
    modal.scrollIntoView = scrollIntoView;

    viewport.set({ layoutHeight: 844, visualHeight: 500 });
    await waitFor(() => expect(readOverlap()).toBe("344px"));

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(windowScrollTo).not.toHaveBeenCalled();
    windowScrollTo.mockRestore();
    editor.remove();
  });

  it("ignores a viewport shrink while nothing editable is focused", async () => {
    const viewport = installMobileViewport({ layoutHeight: 844, visualHeight: 844 });
    render(<TerminalModal isOpen onClose={mockOnClose} />);

    viewport.set({ layoutHeight: 844, visualHeight: 500 });

    // The terminal still reports the geometric band (it is a real occlusion of its own box), but it
    // must never be derived from a baseline: with no focus and no layout change there is nothing to
    // invent beyond what the browser published.
    await waitFor(() => expect(readOverlap()).toBe("344px"));
  });
});
