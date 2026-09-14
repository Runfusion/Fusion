import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useStickyBottomFollow } from "../useStickyBottomFollow";

interface Geometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

const mountedContainers: HTMLElement[] = [];

function createContainer(geometry: Geometry): HTMLDivElement {
  const container = document.createElement("div");
  let scrollTop = geometry.scrollTop;
  Object.defineProperties(container, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = Math.max(0, Math.min(next, geometry.scrollHeight - geometry.clientHeight));
      },
    },
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    clientHeight: { configurable: true, get: () => geometry.clientHeight },
  });
  document.body.appendChild(container);
  mountedContainers.push(container);
  return container;
}

function wheel(container: HTMLElement, deltaY: number): void {
  const event = new Event("wheel") as WheelEvent & { deltaY: number };
  Object.defineProperty(event, "deltaY", { value: deltaY });
  act(() => { container.dispatchEvent(event); });
}

function touchAt(type: "touchstart" | "touchmove", container: HTMLElement, clientY: number): void {
  const event = new Event(type);
  Object.defineProperty(event, "touches", { value: [{ clientY }] });
  Object.defineProperty(event, "target", { value: container });
  act(() => { container.dispatchEvent(event); });
}

function scrollTo(container: HTMLElement, scrollTop: number): void {
  container.scrollTop = scrollTop;
  act(() => { container.dispatchEvent(new Event("scroll")); });
}

function key(container: HTMLElement, keyName: string, defaultPrevented = false): void {
  const event = new KeyboardEvent("keydown", { key: keyName, cancelable: true });
  if (defaultPrevented) event.preventDefault();
  act(() => { container.dispatchEvent(event); });
}

afterEach(() => {
  while (mountedContainers.length > 0) mountedContainers.pop()?.remove();
});

describe("useStickyBottomFollow", () => {
  it("disengages on a wheel-up smaller than the rearm threshold", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;

    const { result } = renderHook(() => useStickyBottomFollow(ref));
    expect(result.current.isFollowingRef.current).toBe(true);

    wheel(container, -30);

    expect(result.current.isFollowingRef.current).toBe(false);
    expect(result.current.isFollowing).toBe(false);
  });

  it("updates isFollowingRef synchronously, inside the gesture frame", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;

    const { result } = renderHook(() => useStickyBottomFollow(ref));
    const followingRef = result.current.isFollowingRef;

    const event = new Event("wheel") as WheelEvent & { deltaY: number };
    Object.defineProperty(event, "deltaY", { value: -30 });
    container.dispatchEvent(event);

    // Read before React has had any chance to commit a render.
    expect(followingRef.current).toBe(false);
    // Settle the deliberately un-acted state update this case exists to observe.
    act(() => {});
  });

  it("keeps following when an upward gesture cannot move the viewport", () => {
    const top = createContainer({ scrollTop: 0, scrollHeight: 2000, clientHeight: 400 });
    const topRef = createRef<HTMLElement>();
    (topRef as { current: HTMLElement | null }).current = top;
    const { result: atTop } = renderHook(() => useStickyBottomFollow(topRef));
    wheel(top, -30);
    expect(atTop.current.isFollowingRef.current).toBe(true);

    const short = createContainer({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 });
    const shortRef = createRef<HTMLElement>();
    (shortRef as { current: HTMLElement | null }).current = short;
    const { result: notScrollable } = renderHook(() => useStickyBottomFollow(shortRef));
    wheel(short, -120);
    expect(notScrollable.current.isFollowingRef.current).toBe(true);
  });

  it("keeps following on residual downward momentum at the clamped bottom", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;
    const { result } = renderHook(() => useStickyBottomFollow(ref));

    wheel(container, 40);

    expect(result.current.isFollowingRef.current).toBe(true);
  });

  it("does not disengage on a touchmove that moved no pixels", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;
    const { result } = renderHook(() => useStickyBottomFollow(ref));

    touchAt("touchstart", container, 300);
    touchAt("touchmove", container, 300);

    expect(result.current.isFollowingRef.current).toBe(true);
  });

  it("disengages on an upward touch pan", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;
    const { result } = renderHook(() => useStickyBottomFollow(ref));

    touchAt("touchstart", container, 300);
    touchAt("touchmove", container, 330);

    expect(result.current.isFollowingRef.current).toBe(false);
  });

  it("disengages on PageUp and rearms on End", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;
    const { result } = renderHook(() => useStickyBottomFollow(ref));

    key(container, "PageUp");
    expect(result.current.isFollowingRef.current).toBe(false);

    key(container, "End");
    expect(result.current.isFollowingRef.current).toBe(true);
    expect(container.scrollTop).toBe(1600);
  });

  it("ignores a key already consumed by a nested widget", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;
    const { result } = renderHook(() => useStickyBottomFollow(ref));

    key(container, "PageUp", true);

    expect(result.current.isFollowingRef.current).toBe(true);
  });

  it("does not let followBottom rearm itself through its own scroll echo", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;
    const { result } = renderHook(() => useStickyBottomFollow(ref));

    wheel(container, -30);
    container.scrollTop = 1570;
    act(() => { container.dispatchEvent(new Event("scroll")); });
    expect(result.current.isFollowingRef.current).toBe(false);

    // A host write to the bottom while the reader is detached must not silently rearm on its echo.
    act(() => { result.current.noteProgrammaticWrite(1600); });
    container.scrollTop = 1600;
    act(() => { container.dispatchEvent(new Event("scroll")); });

    expect(result.current.isFollowingRef.current).toBe(false);
  });

  it("rearms when a real scroll returns into the rearm window", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;
    const { result } = renderHook(() => useStickyBottomFollow(ref));

    wheel(container, -400);
    scrollTo(container, 1000);
    expect(result.current.isFollowingRef.current).toBe(false);

    scrollTo(container, 1590);

    expect(result.current.isFollowingRef.current).toBe(true);
  });

  it("does not rearm when the same scroll position is delivered twice", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;
    const { result } = renderHook(() => useStickyBottomFollow(ref));

    wheel(container, -30);
    scrollTo(container, 1570);
    expect(result.current.isFollowingRef.current).toBe(false);

    // Duplicate delivery (native listener + host onScroll) must be inert.
    act(() => { container.dispatchEvent(new Event("scroll")); });

    expect(result.current.isFollowingRef.current).toBe(false);
  });

  it("bumps the intent generation so an in-flight frame loop can abort", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;
    const onUserIntent = vi.fn();
    const { result } = renderHook(() => useStickyBottomFollow(ref, { onUserIntent }));

    const before = result.current.intentGenerationRef.current;
    wheel(container, -30);

    expect(result.current.intentGenerationRef.current).toBeGreaterThan(before);
    expect(onUserIntent).toHaveBeenCalled();
  });

  it("followBottom writes once and engages following", () => {
    const container = createContainer({ scrollTop: 400, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;
    const { result } = renderHook(() => useStickyBottomFollow(ref, { initialFollowing: false }));

    act(() => { result.current.followBottom(); });

    expect(container.scrollTop).toBe(1600);
    expect(result.current.isFollowingRef.current).toBe(true);
  });

  it("removes every listener on unmount and stops deciding", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;
    const removeSpy = vi.spyOn(container, "removeEventListener");
    const { result, unmount } = renderHook(() => useStickyBottomFollow(ref));

    unmount();

    const removed = removeSpy.mock.calls.map((call) => call[0]);
    for (const type of ["scroll", "wheel", "touchstart", "touchmove", "touchend", "touchcancel", "keydown"]) {
      expect(removed, type).toContain(type);
    }

    wheel(container, -30);
    expect(result.current.isFollowingRef.current).toBe(true);
  });

  it("attaches nothing while disabled", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;
    const { result } = renderHook(() => useStickyBottomFollow(ref, { enabled: false }));

    wheel(container, -30);

    expect(result.current.isFollowingRef.current).toBe(true);
  });

  it("ignores a wheel consumed by a nested scroller that can still move", () => {
    const container = createContainer({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
    const nested = document.createElement("pre");
    Object.defineProperties(nested, {
      scrollTop: { configurable: true, get: () => 60 },
      scrollHeight: { configurable: true, get: () => 500 },
      clientHeight: { configurable: true, get: () => 100 },
    });
    container.appendChild(nested);

    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;
    const { result } = renderHook(() => useStickyBottomFollow(ref));

    const event = new Event("wheel") as WheelEvent & { deltaY: number };
    Object.defineProperty(event, "deltaY", { value: -30 });
    Object.defineProperty(event, "target", { value: nested });
    act(() => { nested.dispatchEvent(event); });

    expect(result.current.isFollowingRef.current).toBe(true);
  });
});
