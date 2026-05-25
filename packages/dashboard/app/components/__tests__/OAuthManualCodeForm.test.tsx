import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OAuthManualCodeForm } from "../OAuthManualCodeForm";

function mockMatchMedia({ mobile = false, coarse = false, reducedMotion = false }: { mobile?: boolean; coarse?: boolean; reducedMotion?: boolean }) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches:
        ((query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)") && mobile)
        || (query === "(pointer: coarse)" && coarse)
        || (query === "(prefers-reduced-motion: reduce)" && reducedMotion),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("OAuthManualCodeForm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("scrolls the textarea into view on mobile focus and visual viewport resize", () => {
    mockMatchMedia({ mobile: true });

    const listeners: Record<string, (() => void) | undefined> = {};
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        addEventListener: vi.fn((event: string, callback: () => void) => {
          listeners[event] = callback;
        }),
        removeEventListener: vi.fn((event: string) => {
          delete listeners[event];
        }),
      },
    });

    render(
      <OAuthManualCodeForm
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        prompt="Paste code"
      />,
    );

    const textarea = screen.getByRole("textbox");
    const scrollIntoView = vi.fn();
    Object.defineProperty(textarea, "scrollIntoView", {
      value: scrollIntoView,
      writable: true,
    });

    fireEvent.focus(textarea);
    vi.runAllTimers();

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      behavior: "smooth",
      inline: "nearest",
    });

    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => textarea,
    });

    listeners.resize?.();
    vi.runAllTimers();

    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("does not trigger scroll assist on non-mobile layouts", () => {
    mockMatchMedia({ mobile: false, coarse: false });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });

    render(
      <OAuthManualCodeForm
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        prompt="Paste code"
      />,
    );

    const textarea = screen.getByRole("textbox");
    const scrollIntoView = vi.fn();
    Object.defineProperty(textarea, "scrollIntoView", {
      value: scrollIntoView,
      writable: true,
    });

    fireEvent.focus(textarea);
    vi.runAllTimers();

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
