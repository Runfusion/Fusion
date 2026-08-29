import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetLockState,
  useMobileKeyboardViewportLock,
  useMobileScrollLock,
  useMobileViewportRestoreReset,
} from "../useMobileScrollLock";

describe("useMobileScrollLock", () => {
  let savedInnerWidth: number;
  let savedMaxTouchPoints: number;
  let savedOntouchstart: typeof window.ontouchstart;
  let savedUserAgent: string;
  let scrollSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetLockState();
    savedInnerWidth = window.innerWidth;
    savedMaxTouchPoints = navigator.maxTouchPoints;
    savedOntouchstart = window.ontouchstart;
    savedUserAgent = navigator.userAgent;
    document.documentElement.style.cssText = "";
    document.body.style.cssText = "";
    scrollSpy = vi.fn();
    window.scrollTo = scrollSpy as unknown as typeof window.scrollTo;
    Object.defineProperty(window, "scrollY", { value: 0, writable: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: savedInnerWidth, writable: true, configurable: true });
    Object.defineProperty(navigator, "maxTouchPoints", { value: savedMaxTouchPoints, configurable: true });
    Object.defineProperty(window, "ontouchstart", { value: savedOntouchstart, writable: true, configurable: true });
    Object.defineProperty(navigator, "userAgent", { value: savedUserAgent, configurable: true });
    document.documentElement.style.cssText = "";
    document.body.style.cssText = "";
    _resetLockState();
  });

  function makeMobile() {
    (window as unknown as { ontouchstart: unknown }).ontouchstart = null;
    Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 375, writable: true, configurable: true });
    // Hook is iOS-gated; default fixture uses an iPhone UA.
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
      configurable: true,
    });
  }

  function makeAndroid() {
    (window as unknown as { ontouchstart: unknown }).ontouchstart = null;
    Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 388, writable: true, configurable: true });
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36",
      configurable: true,
    });
  }

  function makeDesktop() {
    delete (window as unknown as { ontouchstart?: unknown }).ontouchstart;
    Object.defineProperty(navigator, "maxTouchPoints", { value: 0, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 1280, writable: true, configurable: true });
  }

  function setVisibilityState(value: DocumentVisibilityState) {
    Object.defineProperty(document, "visibilityState", { value, configurable: true });
  }

  it("snaps stale iOS document scroll to top on visibilitychange restore", () => {
    makeMobile();
    Object.defineProperty(window, "scrollY", { value: 120, writable: true, configurable: true });
    renderHook(() => useMobileViewportRestoreReset(true));

    setVisibilityState("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(scrollSpy).toHaveBeenCalledWith(0, 0);
  });

  it("snaps stale iOS document scroll to top on pageshow restore", () => {
    makeMobile();
    Object.defineProperty(window, "scrollY", { value: 120, writable: true, configurable: true });
    renderHook(() => useMobileViewportRestoreReset(true));

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));

    expect(scrollSpy).toHaveBeenCalledWith(0, 0);
  });

  it("does not reset document scroll on Android restore", () => {
    makeAndroid();
    Object.defineProperty(window, "scrollY", { value: 120, writable: true, configurable: true });
    renderHook(() => useMobileViewportRestoreReset(true));

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("does not reset document scroll on desktop restore", () => {
    makeDesktop();
    Object.defineProperty(window, "scrollY", { value: 120, writable: true, configurable: true });
    renderHook(() => useMobileViewportRestoreReset(true));

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("does not reset document scroll on visibilitychange hidden", () => {
    makeMobile();
    Object.defineProperty(window, "scrollY", { value: 120, writable: true, configurable: true });
    renderHook(() => useMobileViewportRestoreReset(true));

    setVisibilityState("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("does not fight an active fullscreen mobile scroll lock on restore", () => {
    makeMobile();
    Object.defineProperty(window, "scrollY", { value: 120, writable: true, configurable: true });
    renderHook(() => useMobileScrollLock(true));
    renderHook(() => useMobileViewportRestoreReset(true));

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("does not fight an active keyboard viewport lock on restore", () => {
    makeMobile();
    renderHook(() => useMobileKeyboardViewportLock(true));
    scrollSpy.mockClear();
    Object.defineProperty(window, "scrollY", { value: 120, writable: true, configurable: true });
    renderHook(() => useMobileViewportRestoreReset(true));

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("is idempotent when already aligned on restore", () => {
    makeMobile();
    renderHook(() => useMobileViewportRestoreReset(true));

    document.dispatchEvent(new Event("visibilitychange"));

    expect(scrollSpy).not.toHaveBeenCalled();
    expect(document.body.style.position).toBe("");
    expect(document.body.style.top).toBe("");
  });

  it("clears orphaned body offset styles without a live lock", () => {
    makeMobile();
    document.body.style.position = "fixed";
    document.body.style.top = "-120px";
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    renderHook(() => useMobileViewportRestoreReset(true));

    document.dispatchEvent(new Event("visibilitychange"));

    expect(document.body.style.position).toBe("");
    expect(document.body.style.top).toBe("");
    expect(document.body.style.left).toBe("");
    expect(document.body.style.right).toBe("");
    expect(document.body.style.width).toBe("");
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("pins body with position:fixed and overflow:hidden on mobile when enabled", () => {
    makeMobile();
    Object.defineProperty(window, "scrollY", { value: 120, writable: true, configurable: true });
    renderHook(() => useMobileScrollLock(true));
    expect(document.body.style.position).toBe("fixed");
    expect(document.body.style.top).toBe("-120px");
    expect(document.body.style.width).toBe("100%");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overflow).toBe("hidden");
  });

  it("does nothing on desktop", () => {
    makeDesktop();
    renderHook(() => useMobileScrollLock(true));
    expect(document.body.style.position).toBe("");
    expect(document.documentElement.style.overflow).toBe("");
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("does nothing on Android (avoids dismissing the soft keyboard)", () => {
    makeAndroid();
    renderHook(() => useMobileScrollLock(true));
    expect(document.body.style.position).toBe("");
    expect(document.documentElement.style.overflow).toBe("");
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("restores prior styles and scroll position on cleanup", () => {
    makeMobile();
    document.body.style.position = "relative";
    document.body.style.top = "5px";
    Object.defineProperty(window, "scrollY", { value: 240, writable: true, configurable: true });

    const { unmount } = renderHook(() => useMobileScrollLock(true));
    unmount();

    expect(document.body.style.position).toBe("relative");
    expect(document.body.style.top).toBe("5px");
    expect(document.body.style.overflow).toBe("");
    expect(document.documentElement.style.overflow).toBe("");
    // Always snap to 0 on release — see hook source for rationale.
    expect(scrollSpy).toHaveBeenCalledWith(0, 0);
  });

  it("does not lock when disabled", () => {
    makeMobile();
    renderHook(() => useMobileScrollLock(false));
    expect(document.body.style.position).toBe("");
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("reference-counts so an inner unmount does not release an outer lock", () => {
    makeMobile();
    Object.defineProperty(window, "scrollY", { value: 80, writable: true, configurable: true });

    const outer = renderHook(() => useMobileScrollLock(true));
    const inner = renderHook(() => useMobileScrollLock(true));
    expect(document.body.style.position).toBe("fixed");

    inner.unmount();
    expect(document.body.style.position).toBe("fixed");
    expect(scrollSpy).not.toHaveBeenCalled();

    outer.unmount();
    expect(document.body.style.position).toBe("");
    expect(scrollSpy).toHaveBeenCalledWith(0, 0);
  });
});
