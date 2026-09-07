import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateVirtualListRange, useVirtualizedList } from "../useVirtualizedList";

const keys = (count: number, prefix = "row") => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

afterEach(() => vi.unstubAllGlobals());

describe("calculateVirtualListRange", () => {
  it("keeps empty, single, duplicate and ten-thousand-key inputs bounded", () => {
    expect(calculateVirtualListRange({ keys: [] }).endIndex).toBe(0);
    expect(calculateVirtualListRange({ keys: ["only"], estimateHeight: 40 }).totalHeight).toBe(40);
    const duplicates = calculateVirtualListRange({ keys: ["same", "same", "other"], estimateHeight: 20, viewportHeight: 20 });
    expect(duplicates.totalHeight).toBe(60);
    const large = calculateVirtualListRange({ keys: keys(10_000), estimateHeight: 50, viewportHeight: 500, maxRenderedRows: 32 });
    expect(large.endIndex - large.startIndex).toBeLessThanOrEqual(32);
    expect(large.endIndex).toBe(10_000);
  });

  it("uses variable measurements for spacers and total height", () => {
    const result = calculateVirtualListRange({ keys: ["a", "b", "c"], measuredHeights: new Map([["a", 20], ["b", 200]]), estimateHeight: 50, viewportHeight: 50, scrollTop: 20 });
    expect(result.totalHeight).toBe(270);
    expect(result.endIndex - result.startIndex).toBeLessThanOrEqual(3);
  });
});

describe("useVirtualizedList", () => {
  it("preserves the visible anchor across prepend and resets measurements across A to B to A", () => {
    const container = document.createElement("div");
    Object.defineProperties(container, { clientHeight: { value: 200 }, scrollHeight: { value: 10_000 }, scrollTop: { writable: true, value: 0 } });
    const ref = { current: container };
    const initial = keys(100, "a");
    const { result, rerender } = renderHook(({ collectionKey, rows }) => useVirtualizedList({ collectionKey, keys: rows, scrollRef: ref, estimateHeight: 50 }), { initialProps: { collectionKey: "A", rows: initial } });
    act(() => result.current.scrollToKey("a-50"));
    const anchor = result.current.captureAnchor();
    rerender({ collectionKey: "A", rows: [...keys(10, "new"), ...initial] });
    expect(container.scrollTop).toBe(3_000);
    expect(anchor).not.toBeNull();
    rerender({ collectionKey: "B", rows: ["b"] });
    expect(result.current.totalHeight).toBe(50);
    rerender({ collectionKey: "A", rows: initial });
    expect(result.current.totalHeight).toBe(5_000);
  });

  it("disconnects ResizeObserver on collection change and unmount", () => {
    const disconnect = vi.fn();
    class Observer { observe() {} unobserve() {} disconnect = disconnect; constructor(_callback: ResizeObserverCallback) {} }
    vi.stubGlobal("ResizeObserver", Observer);
    const ref = { current: document.createElement("div") };
    const { result, rerender, unmount } = renderHook(({ id }) => useVirtualizedList({ collectionKey: id, keys: [id], scrollRef: ref }), { initialProps: { id: "A" } });
    act(() => result.current.measureRow("A")(document.createElement("div")));
    rerender({ id: "B" });
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
