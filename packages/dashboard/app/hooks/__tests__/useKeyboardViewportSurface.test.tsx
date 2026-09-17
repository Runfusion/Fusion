import { act, render, renderHook } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KeyboardViewportOwnerProvider,
  useKeyboardViewportSurface,
} from "../useKeyboardViewportSurface";
import {
  installMobileKeyboardViewport,
  stubBoundingRect,
  type MobileKeyboardViewportHarness,
} from "../../test/mobileKeyboardViewport";

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 single-owner contract. Two properties matter and are asserted independently:

1. A container adapts from ITS OWN measured rectangle, so a full-screen drawer, a small window, and
   an already-resized layout all get the right answer from one rule, and nothing is ever grown.
2. A descendant inside an adapted ancestor adapts NOTHING. Stacked adjustments are exactly what made
   the reported symptom depend on the order the keyboard events arrived in.

jsdom performs no layout, so every rectangle here is supplied explicitly. These assertions prove the
published bound and the ownership decision, never a rendered CSS result.
*/

let harness: MobileKeyboardViewportHarness | null = null;

const PHONE = { layoutHeight: 844, visualHeight: 844, visualWidth: 390 };

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  harness?.restore();
  harness = null;
  document.body.replaceChildren();
});

function renderSurface(
  rect: { top: number; height: number },
  options: { enabled?: boolean; standalone?: boolean; wrapper?: (children: ReactNode) => ReactNode } = {},
) {
  const element = document.createElement("div");
  document.body.append(element);
  stubBoundingRect(element, rect);

  const useHarnessHook = () => {
    const ref = useRef<HTMLElement | null>(element);
    return useKeyboardViewportSurface(ref, {
      enabled: options.enabled ?? true,
      standalone: options.standalone,
    });
  };

  return renderHook(useHarnessHook, {
    wrapper: options.wrapper
      ? ({ children }) => <>{options.wrapper!(children)}</>
      : undefined,
  });
}

describe("measuring the container against the visible bound", () => {
  it("publishes nothing while the container fits entirely in the visible area", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { result } = renderSurface({ top: 0, height: 844 });

    expect(result.current.bottomOverflow).toBe(0);
    expect(result.current.maxBlockSize).toBeNull();
    expect(result.current.style).toEqual({});
  });

  it("reports exactly the part of the container below the visible bottom edge", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { result } = renderSurface({ top: 0, height: 844 });

    harness.set({ ...PHONE, visualHeight: 500 });

    expect(result.current.bottomOverflow).toBe(344);
    expect(result.current.maxBlockSize).toBe(500);
    expect(result.current.style).toEqual({ "--keyboard-visible-block-size": "500px" });
  });

  it("accounts for a container that does not start at the top of the page", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { result } = renderSurface({ top: 100, height: 744 });

    harness.set({ ...PHONE, visualHeight: 500 });

    // Only the 344px below the visible bound is removed; the container keeps its offset top.
    expect(result.current.bottomOverflow).toBe(344);
    expect(result.current.maxBlockSize).toBe(400);
  });

  it("publishes NOTHING when the browser already resized the layout viewport", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { result } = renderSurface({ top: 0, height: 500 });

    // Android resizes-content: layout shrank with the keyboard, container followed it.
    harness.set({ layoutHeight: 500, innerHeight: 844, visualHeight: 500, visualWidth: 390 });

    expect(result.current.bottomOverflow).toBe(0);
    expect(result.current.maxBlockSize).toBeNull();
  });

  it("never grows a small container up to the viewport", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { result } = renderSurface({ top: 40, height: 200 });

    harness.set({ ...PHONE, visualHeight: 500 });

    expect(result.current.bottomOverflow).toBe(0);
    expect(result.current.maxBlockSize).toBeNull();
  });

  it("uses the visible bottom edge, not a keyboard height, when offsetTop is positive", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { result } = renderSurface({ top: 0, height: 844 });

    harness.set({ ...PHONE, visualHeight: 500, offsetTop: 40 });

    // Visible bound is 540, so only 304px of the container fall below it.
    expect(result.current.bottomOverflow).toBe(304);
    expect(result.current.maxBlockSize).toBe(540);
  });

  it("restores the resting geometry exactly when the keyboard closes", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { result } = renderSurface({ top: 0, height: 844 });

    harness.set({ ...PHONE, visualHeight: 500 });
    expect(result.current.maxBlockSize).toBe(500);

    harness.set(PHONE);

    expect(result.current.maxBlockSize).toBeNull();
    expect(result.current.style).toEqual({});
  });

  it("stays inert on an empty rectangle rather than publishing a nonsense size", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { result } = renderSurface({ top: 0, height: 0 });

    harness.set({ ...PHONE, visualHeight: 500 });

    expect(result.current.maxBlockSize).toBeNull();
  });

  it("publishes nothing while disabled, even during a real keyboard transition", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { result } = renderSurface({ top: 0, height: 844 }, { enabled: false });

    harness.set({ ...PHONE, visualHeight: 500 });

    expect(result.current.maxBlockSize).toBeNull();
    expect(result.current.bottomOverflow).toBe(0);
  });
});

describe("single-owner enforcement", () => {
  const ownedWrapper = (children: ReactNode) => (
    <KeyboardViewportOwnerProvider value={{ owned: true }}>{children}</KeyboardViewportOwnerProvider>
  );

  it("refuses to adapt inside an already-adapted ancestor", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { result } = renderSurface({ top: 0, height: 844 }, { wrapper: ownedWrapper });

    harness.set({ ...PHONE, visualHeight: 500 });

    expect(result.current.ownedByAncestor).toBe(true);
    expect(result.current.bottomOverflow).toBe(0);
    expect(result.current.maxBlockSize).toBeNull();
    expect(result.current.style).toEqual({});
  });

  it("adapts normally when no ancestor claims ownership", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { result } = renderSurface({ top: 0, height: 844 });

    harness.set({ ...PHONE, visualHeight: 500 });

    expect(result.current.ownedByAncestor).toBe(false);
    expect(result.current.maxBlockSize).toBe(500);
  });

  it("lets a genuinely standalone portal opt out of an inherited owner it does not live inside", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { result } = renderSurface({ top: 0, height: 844 }, { wrapper: ownedWrapper, standalone: true });

    harness.set({ ...PHONE, visualHeight: 500 });

    expect(result.current.ownedByAncestor).toBe(false);
    expect(result.current.maxBlockSize).toBe(500);
  });

  it("gives exactly one bound for a nested owner/child pair", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    outer.append(inner);
    document.body.append(outer);
    stubBoundingRect(outer, { top: 0, height: 844 });
    stubBoundingRect(inner, { top: 0, height: 844 });

    const bounds: Array<{ outer: number | null; inner: number | null }> = [];

    function Child() {
      const ref = useRef<HTMLElement | null>(inner);
      const surface = useKeyboardViewportSurface(ref);
      bounds.at(-1)!.inner = surface.maxBlockSize;
      return null;
    }

    function Owner() {
      const ref = useRef<HTMLElement | null>(outer);
      const surface = useKeyboardViewportSurface(ref, { standalone: true });
      bounds.push({ outer: surface.maxBlockSize, inner: null });
      return (
        <KeyboardViewportOwnerProvider value={{ owned: surface.maxBlockSize !== null }}>
          <Child />
        </KeyboardViewportOwnerProvider>
      );
    }

    render(<Owner />);
    harness.set({ ...PHONE, visualHeight: 500 });

    const latest = bounds.at(-1)!;
    expect(latest.outer).toBe(500);
    expect(latest.inner).toBeNull();
  });
});

describe("lifetime", () => {
  it("re-measures on demand after a layout change the viewport did not cause", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const element = document.createElement("div");
    document.body.append(element);
    stubBoundingRect(element, { top: 0, height: 400 });

    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(element);
      return useKeyboardViewportSurface(ref);
    });

    harness.set({ ...PHONE, visualHeight: 500 });
    expect(result.current.maxBlockSize).toBeNull();

    stubBoundingRect(element, { top: 0, height: 844 });
    act(() => result.current.remeasure());

    expect(result.current.maxBlockSize).toBe(500);
  });

  it("releases its subscription on unmount so a later transition cannot touch it", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { result, unmount } = renderSurface({ top: 0, height: 844 });
    harness.set({ ...PHONE, visualHeight: 500 });
    const last = result.current.maxBlockSize;
    unmount();

    harness.set({ ...PHONE, visualHeight: 300 });

    expect(result.current.maxBlockSize).toBe(last);
  });
});
