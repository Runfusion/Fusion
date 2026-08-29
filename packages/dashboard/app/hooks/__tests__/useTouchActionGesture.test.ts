import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTouchActionGesture } from "../useTouchActionGesture";

describe("useTouchActionGesture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("beginTouchActionGesture returns true once and false on a same-tick re-entrant call", () => {
    const { result } = renderHook(() => useTouchActionGesture());

    let first: boolean | undefined;
    let second: boolean | undefined;
    act(() => {
      first = result.current.beginTouchActionGesture();
      second = result.current.beginTouchActionGesture();
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("beginTouchActionGesture allows another gesture after the guard clears on the next tick", () => {
    const { result } = renderHook(() => useTouchActionGesture());

    let first: boolean | undefined;
    act(() => {
      first = result.current.beginTouchActionGesture();
    });
    expect(first).toBe(true);

    act(() => {
      vi.advanceTimersByTime(0);
    });

    let second: boolean | undefined;
    act(() => {
      second = result.current.beginTouchActionGesture();
    });
    expect(second).toBe(true);
  });

  it("markHandledSendTouch sets a flag that consumeHandledSendTouch reads and clears exactly once", () => {
    const { result } = renderHook(() => useTouchActionGesture());

    act(() => {
      result.current.markHandledSendTouch();
    });

    let firstConsume: boolean | undefined;
    let secondConsume: boolean | undefined;
    act(() => {
      firstConsume = result.current.consumeHandledSendTouch();
      secondConsume = result.current.consumeHandledSendTouch();
    });

    expect(firstConsume).toBe(true);
    expect(secondConsume).toBe(false);
  });

  it("consumeHandledSendTouch returns false when no touch has been marked handled", () => {
    const { result } = renderHook(() => useTouchActionGesture());

    let consumed: boolean | undefined;
    act(() => {
      consumed = result.current.consumeHandledSendTouch();
    });

    expect(consumed).toBe(false);
  });

  it("the handled flag auto-expires after its timeout", () => {
    const { result } = renderHook(() => useTouchActionGesture());

    act(() => {
      result.current.markHandledSendTouch();
    });

    act(() => {
      vi.advanceTimersByTime(700);
    });

    let consumed: boolean | undefined;
    act(() => {
      consumed = result.current.consumeHandledSendTouch();
    });

    expect(consumed).toBe(false);
  });

  it("cleans up the pending handled-touch timer on unmount", () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    const { result, unmount } = renderHook(() => useTouchActionGesture());

    act(() => {
      result.current.markHandledSendTouch();
    });

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
