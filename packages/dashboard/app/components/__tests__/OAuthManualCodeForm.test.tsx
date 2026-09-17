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

  /*
  FNXC:MobileKeyboardViewport 2026-09-17-14:23:
  FN-512 replaced this form's page-moving assist. It used to call
  `scrollIntoView({ block: "center" })` in an animation frame and AGAIN 120ms later; both scrolled
  every scrollable ancestor up to the document, and the deferred one could fire after the user had
  moved to a different field and drag that surface instead.

  The contract is now: reveal the code field inside its own scroller, only while it is still the
  focused connected control, with the pending frame cancelled on blur and unmount. The assertions
  below follow that observable behaviour.
  */
  function mountInScroller() {
    render(
      <OAuthManualCodeForm
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        prompt="Paste code"
      />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    const scroller = textarea.closest(".oauth-manual-code") as HTMLElement;
    Object.defineProperties(scroller, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 400, configurable: true },
    });
    scroller.style.overflowY = "auto";
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => { scrollTop = next; },
    });
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: 400, height: 400, left: 0, right: 390, width: 390, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    textarea.getBoundingClientRect = () => {
      const top = 440 - scrollTop;
      return ({
        top, bottom: top + 40, height: 40, left: 0, right: 390, width: 390, x: 0, y: top, toJSON: () => ({}),
      }) as DOMRect;
    };
    const scrollIntoView = vi.fn();
    Object.defineProperty(textarea, "scrollIntoView", { value: scrollIntoView, writable: true });
    return { textarea, scroller, scrollIntoView, readScrollTop: () => scroller.scrollTop };
  }

  it("reveals the textarea inside its own scroller on mobile focus and visual viewport resize", () => {
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

    const { textarea, scrollIntoView, readScrollTop } = mountInScroller();

    textarea.focus();
    fireEvent.focus(textarea);
    vi.runAllTimers();

    expect(readScrollTop()).toBe(80);
    expect(scrollIntoView).not.toHaveBeenCalled();

    listeners.resize?.();
    vi.runAllTimers();

    // Already revealed, so the repeat converges instead of drifting further.
    expect(readScrollTop()).toBe(80);
  });

  it("declines to move anything once focus has transferred to another field", () => {
    mockMatchMedia({ mobile: true });
    const listeners: Record<string, (() => void) | undefined> = {};
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        addEventListener: vi.fn((event: string, callback: () => void) => { listeners[event] = callback; }),
        removeEventListener: vi.fn((event: string) => { delete listeners[event]; }),
      },
    });

    const { textarea, scrollIntoView, readScrollTop } = mountInScroller();
    textarea.focus();
    fireEvent.focus(textarea);
    vi.runAllTimers();
    const revealed = readScrollTop();

    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();

    listeners.resize?.();
    vi.runAllTimers();

    expect(readScrollTop()).toBe(revealed);
    expect(scrollIntoView).not.toHaveBeenCalled();
    elsewhere.remove();
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
    const scroller = textarea.closest(".oauth-manual-code") as HTMLElement;
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => { scrollTop = next; },
    });

    fireEvent.focus(textarea);
    vi.runAllTimers();

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(0);
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
