import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardFocusPending } from "../useKeyboardFocusPending";

function installViewport(scale = 1) {
  const target = new EventTarget();
  const addEventListener = vi.fn(target.addEventListener.bind(target));
  const removeEventListener = vi.fn(target.removeEventListener.bind(target));
  const viewport = { scale, addEventListener, removeEventListener, dispatchEvent: target.dispatchEvent.bind(target) };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return viewport;
}

function focus(element: HTMLElement) {
  act(() => { element.focus(); element.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
}

describe("useKeyboardFocusPending", () => {
  beforeEach(() => document.body.replaceChildren());
  afterEach(() => {
    document.body.replaceChildren();
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  });

  it("tracks textarea and text input focus, then clears on blur", () => {
    installViewport();
    const textarea = document.createElement("textarea");
    const input = document.createElement("input");
    document.body.append(textarea, input);
    const { result } = renderHook(() => useKeyboardFocusPending(true));
    focus(textarea);
    expect(result.current).toBe(true);
    act(() => { textarea.blur(); textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(result.current).toBe(false);
    focus(input);
    expect(result.current).toBe(true);
  });

  it("never treats checkbox, button, or range input focus as keyboard pending", () => {
    installViewport();
    const { result } = renderHook(() => useKeyboardFocusPending(true));
    for (const type of ["checkbox", "button", "range"]) {
      const input = document.createElement("input");
      input.type = type;
      document.body.append(input);
      focus(input);
      expect(result.current).toBe(false);
      input.remove();
    }
  });

  it("clears a focused field while pinch zoom is active and updates on viewport events", () => {
    const viewport = installViewport(1);
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    const { result } = renderHook(() => useKeyboardFocusPending(true));
    focus(textarea);
    expect(result.current).toBe(true);
    viewport.scale = 1.5;
    act(() => viewport.dispatchEvent(new Event("resize")));
    expect(result.current).toBe(false);
  });

  it("is disabled without registering any focus or viewport listeners", () => {
    const viewport = installViewport();
    const windowAdd = vi.spyOn(window, "addEventListener");
    const { result, unmount } = renderHook(() => useKeyboardFocusPending(false));
    expect(result.current).toBe(false);
    expect(windowAdd).not.toHaveBeenCalledWith("focusin", expect.any(Function));
    expect(viewport.addEventListener).not.toHaveBeenCalled();
    unmount();
    windowAdd.mockRestore();
  });

  it("safely works without visualViewport and removes every listener on unmount", () => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    const windowAdd = vi.spyOn(window, "addEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    const { result, unmount } = renderHook(() => useKeyboardFocusPending(true));
    focus(textarea);
    expect(result.current).toBe(true);
    expect(windowAdd).toHaveBeenCalledWith("focusin", expect.any(Function));
    unmount();
    expect(windowRemove).toHaveBeenCalledWith("focusin", expect.any(Function));
    expect(windowRemove).toHaveBeenCalledWith("focusout", expect.any(Function));
    windowAdd.mockRestore();
    windowRemove.mockRestore();
  });

  it("removes visual viewport resize and scroll listeners on unmount", () => {
    const viewport = installViewport();
    const { unmount } = renderHook(() => useKeyboardFocusPending(true));
    unmount();
    expect(viewport.removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(viewport.removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
});
