import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateVirtualTranscriptRange, useVirtualizedChatTranscript } from "../useVirtualizedChatTranscript";

function keys(count: number, prefix = "message") {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("calculateVirtualTranscriptRange", () => {
  it("handles empty and single-row transcripts without structural spacers", () => {
    expect(calculateVirtualTranscriptRange({ keys: [] })).toEqual({ startIndex: 0, endIndex: 0, topSpacerHeight: 0, bottomSpacerHeight: 0, totalHeight: 0 });
    expect(calculateVirtualTranscriptRange({ keys: ["only"], estimateHeight: 100, viewportHeight: 0 })).toEqual({ startIndex: 0, endIndex: 1, topSpacerHeight: 0, bottomSpacerHeight: 0, totalHeight: 100 });
  });

  it("starts at the tail and remains bounded for 10,000 unknown rows", () => {
    const result = calculateVirtualTranscriptRange({ keys: keys(10_000), estimateHeight: 100, viewportHeight: 500, maxRenderedRows: 30 });
    expect(result.endIndex).toBe(10_000);
    expect(result.endIndex - result.startIndex).toBeLessThanOrEqual(30);
    expect(result.topSpacerHeight).toBeGreaterThan(0);
    expect(result.bottomSpacerHeight).toBe(0);
  });

  it("moves to the middle and incorporates very different measured heights", () => {
    const list = keys(100);
    const measured = new Map([[list[50]!, 400], [list[51]!, 20]]);
    const result = calculateVirtualTranscriptRange({ keys: list, measuredHeights: measured, estimateHeight: 100, viewportHeight: 300, scrollTop: 5_000 });
    expect(result.startIndex).toBeLessThanOrEqual(50);
    expect(result.endIndex).toBeGreaterThan(50);
    expect(result.totalHeight).toBe(10_220);
    expect(result.endIndex - result.startIndex).toBeLessThanOrEqual(60);
  });

  it("includes a synthetic streaming tail without growing the mounted bound", () => {
    const result = calculateVirtualTranscriptRange({ keys: [...keys(1_000), "__streaming__"], viewportHeight: 480, maxRenderedRows: 24 });
    expect(result.endIndex).toBe(1_001);
    expect(result.endIndex - result.startIndex).toBeLessThanOrEqual(24);
  });
});

describe("useVirtualizedChatTranscript", () => {
  it("scrolls to an unmounted key and preserves an anchor across prepend", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 10_000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    const ref = { current: element };
    const initial = keys(100, "old");
    const { result, rerender } = renderHook(
      ({ transcriptKeys }) => useVirtualizedChatTranscript({ transcriptKey: "session", keys: transcriptKeys, scrollRef: ref, estimateHeight: 100 }),
      { initialProps: { transcriptKeys: initial } },
    );

    act(() => result.current.scrollToKey("old-50", "start"));
    expect(element.scrollTop).toBe(5_000);
    expect(result.current.visibleKeys).toContain("old-50");
    const anchor = result.current.captureAnchor();
    expect(anchor).not.toBeNull();

    rerender({ transcriptKeys: [...keys(10, "new"), ...initial] });
    expect(element.scrollTop).toBe(6_000);
    act(() => result.current.restoreAnchor(anchor!));
    expect(result.current.visibleKeys).toContain(anchor!.key);
  });

  it("disconnects observers and ignores their late callback after a transcript change", () => {
    let callback: ResizeObserverCallback | undefined;
    const disconnect = vi.fn();
    const observe = vi.fn();
    class FakeResizeObserver {
      constructor(next: ResizeObserverCallback) { callback = next; }
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    const row = document.createElement("div");
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ height: 100 } as DOMRect);
    const ref = { current: container };
    const { result, rerender, unmount } = renderHook(
      ({ id }) => useVirtualizedChatTranscript({ transcriptKey: id, keys: [id], scrollRef: ref }),
      { initialProps: { id: "first" } },
    );
    act(() => result.current.measureRow("first")(row));
    expect(observe).toHaveBeenCalledWith(row);

    rerender({ id: "second" });
    expect(disconnect).toHaveBeenCalled();
    act(() => callback?.([{ target: row, contentRect: { height: 900 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(result.current.totalHeight).toBe(112);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("uses deterministic measurement fallback without ResizeObserver", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const container = document.createElement("div");
    const row = document.createElement("div");
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ height: 240 } as DOMRect);
    const ref = { current: container };
    const { result } = renderHook(() => useVirtualizedChatTranscript({ transcriptKey: "fallback", keys: ["row"], scrollRef: ref }));
    await act(async () => {
      result.current.measureRow("row")(row);
      await Promise.resolve();
    });
    expect(result.current.totalHeight).toBe(240);
  });
});
