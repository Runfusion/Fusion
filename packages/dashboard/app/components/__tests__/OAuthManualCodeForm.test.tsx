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

  // FNXC:OAuthManualCodeForm 2026-07-14-00:00: regression coverage for FN-7953 —
  // on mobile, tapping "Submit code" while the textarea still has focus used to
  // only blur/dismiss the keyboard on the first tap, requiring a second tap to
  // actually submit. These tests reproduce the real mobile event sequence
  // (touch/pointer event → blur → click) and assert a single tap submits
  // immediately, with no double-submit and no desktop regression.
  describe("single-tap submit (FN-7953)", () => {
    it("submits from a single mobile tap even though the textarea still holds focus when the tap lands", () => {
      mockMatchMedia({ mobile: true });

      const onSubmit = vi.fn();
      render(
        <OAuthManualCodeForm
          value="pasted-code"
          onChange={vi.fn()}
          onSubmit={onSubmit}
          prompt="Paste code"
        />,
      );

      const textarea = screen.getByRole("textbox");
      const button = screen.getByRole("button", { name: "Submit code" });

      // Textarea still has focus (keyboard open) when the tap lands.
      fireEvent.focus(textarea);

      // Real mobile browser sequence for a single physical tap on the button:
      // the touch first blurs the still-focused textarea (dismissing the
      // keyboard) before any click is dispatched.
      fireEvent.touchStart(button);
      fireEvent.blur(textarea);
      fireEvent.click(button);

      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("does not double-submit when pointerdown and touchstart both fire for a single physical tap", () => {
      mockMatchMedia({ mobile: true });

      const onSubmit = vi.fn();
      render(
        <OAuthManualCodeForm
          value="pasted-code"
          onChange={vi.fn()}
          onSubmit={onSubmit}
          prompt="Paste code"
        />,
      );

      const textarea = screen.getByRole("textbox");
      const button = screen.getByRole("button", { name: "Submit code" });

      fireEvent.focus(textarea);

      // Some mobile browsers dispatch both a pointerdown and a touchstart for
      // the same physical tap; the gesture guard must dedupe these so only one
      // onSubmit call results from the combined sequence.
      fireEvent.pointerDown(button, { pointerType: "touch" });
      fireEvent.touchStart(button);
      fireEvent.blur(textarea);
      fireEvent.click(button);

      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("still submits exactly once on a plain desktop mouse click with no touch/pointer events", () => {
      mockMatchMedia({ mobile: false, coarse: false });
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });

      const onSubmit = vi.fn();
      render(
        <OAuthManualCodeForm
          value="pasted-code"
          onChange={vi.fn()}
          onSubmit={onSubmit}
          prompt="Paste code"
        />,
      );

      const button = screen.getByRole("button", { name: "Submit code" });

      fireEvent.click(button);

      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("never invokes onSubmit from any tap path while disabled", () => {
      mockMatchMedia({ mobile: true });

      const onSubmit = vi.fn();
      render(
        <OAuthManualCodeForm
          value="pasted-code"
          onChange={vi.fn()}
          onSubmit={onSubmit}
          prompt="Paste code"
          disabled
        />,
      );

      const button = screen.getByRole("button", { name: "Submit code" });

      fireEvent.pointerDown(button, { pointerType: "touch" });
      fireEvent.touchStart(button);
      fireEvent.click(button);

      expect(onSubmit).not.toHaveBeenCalled();
    });
  });
});
