import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFlashOnIncrease } from "./useFlashOnIncrease";

describe("useFlashOnIncrease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not flash on initial render", () => {
    const { result } = renderHook(() => useFlashOnIncrease(3));
    expect(result.current).toBe(false);
  });

  it("flashes when count increases", () => {
    const { result, rerender } = renderHook(
      ({ count }) => useFlashOnIncrease(count),
      { initialProps: { count: 3 } },
    );

    rerender({ count: 5 });
    expect(result.current).toBe(true);
  });

  it("resets flashing after duration", () => {
    const { result, rerender } = renderHook(
      ({ count }) => useFlashOnIncrease(count, 1400),
      { initialProps: { count: 3 } },
    );

    rerender({ count: 5 });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(result.current).toBe(false);
  });

  it("does not flash when count decreases", () => {
    const { result, rerender } = renderHook(
      ({ count }) => useFlashOnIncrease(count),
      { initialProps: { count: 5 } },
    );

    rerender({ count: 2 });
    expect(result.current).toBe(false);
  });

  it("does not flash when count stays the same", () => {
    const { result, rerender } = renderHook(
      ({ count }) => useFlashOnIncrease(count),
      { initialProps: { count: 5 } },
    );

    rerender({ count: 5 });
    expect(result.current).toBe(false);
  });

  it("cleans up timer on unmount", () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    const { rerender, unmount } = renderHook(
      ({ count }) => useFlashOnIncrease(count),
      { initialProps: { count: 3 } },
    );

    rerender({ count: 5 });
    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
