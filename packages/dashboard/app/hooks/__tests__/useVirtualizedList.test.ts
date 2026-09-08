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
  it("publishes terminal geometry before a mounting viewport can accept its bottom scroll", () => {
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 10_000 },
      scrollTop: { configurable: true, get: () => 0, set: () => undefined },
    });
    const rows = keys(100);
    const ref = { current: container };
    const { result, rerender } = renderHook(
      ({ transcriptKeys }) => useVirtualizedList({ collectionKey: "tail", keys: transcriptKeys, scrollRef: ref, estimateHeight: 100, initialAlign: "start" }),
      { initialProps: { transcriptKeys: rows.slice(0, 1) } },
    );
    act(() => result.current.onScroll());
    rerender({ transcriptKeys: rows });

    expect(result.current.visibleKeys).toContain("row-0");
    act(() => result.current.scrollToBottom());
    expect(result.current.visibleKeys).toContain("row-99");
  });

  it("retains terminal alignment through late measurements and yields to explicit navigation", () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    class Observer {
      constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", Observer);

    const container = document.createElement("div");
    let scrollHeight = 1_000;
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    const rows = keys(10);
    const ref = { current: container };
    const { result } = renderHook(() => useVirtualizedList({
      collectionKey: "tail",
      keys: rows,
      scrollRef: ref,
      estimateHeight: 100,
      initialAlign: "start",
    }));
    const lastRow = document.createElement("div");
    vi.spyOn(lastRow, "getBoundingClientRect").mockReturnValue({ height: 100 } as DOMRect);
    act(() => result.current.measureRow("row-9")(lastRow));

    act(() => result.current.scrollToBottom());
    expect(container.scrollTop).toBe(1_000);

    scrollHeight = 1_400;
    act(() => resizeCallback?.([{
      target: lastRow,
      borderBoxSize: [{ blockSize: 500 }],
      contentRect: { height: 500 },
    } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    expect(result.current.visibleKeys).toContain("row-9");
    expect(container.scrollTop).toBe(1_400);

    act(() => result.current.scrollToKey("row-2", "center"));
    expect(container.scrollTop).toBe(150);
    scrollHeight = 1_500;
    act(() => resizeCallback?.([{
      target: lastRow,
      borderBoxSize: [{ blockSize: 600 }],
      contentRect: { height: 600 },
    } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    expect(container.scrollTop).toBe(150);

    act(() => result.current.scrollToBottom());
    act(() => result.current.cancelPendingScrollToBottom());
    container.scrollTop = 200;
    act(() => result.current.onScroll());
    scrollHeight = 1_600;
    act(() => resizeCallback?.([{
      target: lastRow,
      borderBoxSize: [{ blockSize: 700 }],
      contentRect: { height: 700 },
    } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    expect(container.scrollTop).toBe(200);
  });

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
