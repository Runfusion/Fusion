import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileBarKeyboardState } from "../App";
import { MobileNavBar } from "../components/MobileNavBar";
import { _resetInitialViewportHeight } from "../hooks/useMobileKeyboard";

function installViewport(width: number, height: number) {
  const target = new EventTarget();
  const viewport = {
    width,
    height,
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return viewport;
}

function MobileNavKeyboardHarness({ isMobile }: { isMobile: boolean }) {
  const state = useMobileBarKeyboardState({ isMobile, anyModalOpen: false, overlayOpen: false });
  return <>
    <output data-testid="keyboard-open">{String(state.keyboardOpen)}</output>
    <output data-testid="footer-hidden">{String(state.footerHidden)}</output>
    <MobileNavBar view="board" onChangeView={vi.fn()} footerVisible={!state.footerHidden} keyboardOpen={state.navKeyboardOpen} />
  </>;
}

describe("App landscape mobile keyboard seam", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetInitialViewportHeight();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 932 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 430 });
    Object.defineProperty(window, "screen", { configurable: true, value: { width: 932, height: 430 } });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("renders the nav off-screen immediately on focus and after a settled landscape sample", () => {
    const viewport = installViewport(932, 430);
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    const { container } = render(<MobileNavKeyboardHarness isMobile />);
    const nav = container.querySelector(".mobile-nav-bar");
    expect(nav).not.toBeNull();
    expect(nav).not.toHaveClass("mobile-nav-bar--keyboard-open");

    act(() => { textarea.focus(); textarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    expect(nav).toHaveClass("mobile-nav-bar--keyboard-open");
    expect(screen.getByTestId("footer-hidden")).toHaveTextContent("false");

    viewport.height = 220;
    act(() => { viewport.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(1_000); });
    expect(screen.getByTestId("keyboard-open")).toHaveTextContent("true");
    expect(nav).toHaveClass("mobile-nav-bar--keyboard-open");

    viewport.height = 430;
    act(() => { textarea.blur(); textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); viewport.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(1_000); });
    expect(nav).not.toHaveClass("mobile-nav-bar--keyboard-open");
    expect(screen.getByTestId("footer-hidden")).toHaveTextContent("false");
    expect(document.body.style.position).not.toBe("fixed");
  });

  it("never fabricates landscape keyboard state for a non-mobile host", () => {
    const viewport = installViewport(1280, 430);
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    const { container } = render(<MobileNavKeyboardHarness isMobile={false} />);
    act(() => { textarea.focus(); textarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); viewport.height = 220; viewport.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(1_000); });
    expect(screen.getByTestId("keyboard-open")).toHaveTextContent("false");
    expect(container.querySelector(".mobile-nav-bar")).not.toHaveClass("mobile-nav-bar--keyboard-open");
  });

  it("keeps App's only keyboard hook call inside the exported production seam", () => {
    const appSource = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
    expect(appSource.match(/useMobileKeyboard\(/g)).toHaveLength(1);
    const seamStart = appSource.indexOf("export function useMobileBarKeyboardState");
    const hookCall = appSource.indexOf("useMobileKeyboard(");
    const seamEnd = appSource.indexOf("export function shouldOpenBoardTaskInDock");
    expect(hookCall).toBeGreaterThan(seamStart);
    expect(hookCall).toBeLessThan(seamEnd);
  });
});
