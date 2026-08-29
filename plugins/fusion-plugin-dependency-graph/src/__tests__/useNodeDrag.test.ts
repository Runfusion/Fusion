import { act, renderHook } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __internal, useNodeDrag } from "../hooks/useNodeDrag";

function pointerEvent(overrides: Partial<PointerEvent> = {}) {
  const target = {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  };
  return {
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
    clientX: 0,
    clientY: 0,
    timeStamp: 0,
    defaultPrevented: false,
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
    currentTarget: target,
    ...overrides,
  } as unknown as React.PointerEvent<HTMLElement>;
}

describe("useNodeDrag", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions pending to dragging and back on pointer up", () => {
    const onPositionChange = vi.fn();
    const onDragStateChange = vi.fn();
    const { result } = renderHook(() =>
      useNodeDrag({ taskId: "A", position: { x: 10, y: 10 }, scale: 1, canDrag: true, onPositionChange, onDragStateChange }),
    );

    act(() => result.current.onPointerDown(pointerEvent({ clientX: 10, clientY: 20 })));
    act(() => result.current.onPointerMove(pointerEvent({ clientX: 16, clientY: 26 })));
    expect(result.current.isDragging).toBe(true);
    expect(onPositionChange).toHaveBeenCalledWith("A", { x: 16, y: 16 });

    act(() => result.current.onPointerUp(pointerEvent({ clientX: 16, clientY: 26 })));
    expect(result.current.isDragging).toBe(false);
    expect(onDragStateChange).toHaveBeenCalledWith(true);
    expect(onDragStateChange).toHaveBeenCalledWith(false);
  });

  it("stays click-only below threshold", () => {
    const onPositionChange = vi.fn();
    const { result } = renderHook(() =>
      useNodeDrag({ taskId: "A", position: { x: 0, y: 0 }, scale: 1, canDrag: true, onPositionChange }),
    );

    act(() => result.current.onPointerDown(pointerEvent()));
    act(() => result.current.onPointerMove(pointerEvent({ clientX: __internal.DRAG_THRESHOLD_PX - 1, clientY: 0 })));
    act(() => result.current.onPointerUp(pointerEvent({ clientX: __internal.DRAG_THRESHOLD_PX - 1, clientY: 0 })));

    expect(result.current.isDragging).toBe(false);
    expect(onPositionChange).not.toHaveBeenCalled();
  });

  it("divides pointer delta by zoom scale", () => {
    const onPositionChange = vi.fn();
    const { result } = renderHook(() =>
      useNodeDrag({ taskId: "A", position: { x: 0, y: 0 }, scale: 2, canDrag: true, onPositionChange }),
    );

    act(() => result.current.onPointerDown(pointerEvent()));
    act(() => result.current.onPointerMove(pointerEvent({ clientX: 10, clientY: 6 })));

    expect(onPositionChange).toHaveBeenCalledWith("A", { x: 5, y: 3 });
  });

  it("cancels drag cleanly on pointer cancel", () => {
    const onPositionChange = vi.fn();
    const { result } = renderHook(() =>
      useNodeDrag({ taskId: "A", position: { x: 0, y: 0 }, scale: 1, canDrag: true, onPositionChange }),
    );

    act(() => result.current.onPointerDown(pointerEvent()));
    act(() => result.current.onPointerMove(pointerEvent({ clientX: 8, clientY: 0 })));
    expect(result.current.isDragging).toBe(true);

    act(() => result.current.onPointerCancel(pointerEvent({ clientX: 8, clientY: 0 })));
    expect(result.current.isDragging).toBe(false);
  });

  it("ignores position updates when dragging is disabled", () => {
    const onPositionChange = vi.fn();
    const { result } = renderHook(() =>
      useNodeDrag({ taskId: "A", position: { x: 0, y: 0 }, scale: 1, canDrag: false, onPositionChange }),
    );

    act(() => result.current.onPointerDown(pointerEvent({ pointerType: "touch", timeStamp: 100 })));
    act(() => result.current.onPointerMove(pointerEvent({ pointerType: "touch", clientX: 8, clientY: 0, timeStamp: 120 })));

    expect(result.current.isDragging).toBe(false);
    expect(onPositionChange).not.toHaveBeenCalled();
  });

  it("fires onDoubleTap for qualifying touch taps and suppresses the follow-up click", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() =>
      useNodeDrag({ taskId: "A", position: { x: 0, y: 0 }, scale: 1, canDrag: false, onPositionChange: vi.fn(), onDoubleTap }),
    );

    const firstDown = pointerEvent({ pointerId: 1, pointerType: "touch", clientX: 12, clientY: 16 });
    const firstUp = pointerEvent({ pointerId: 1, pointerType: "touch", clientX: 12, clientY: 16, currentTarget: firstDown.currentTarget });
    const secondDown = pointerEvent({ pointerId: 2, pointerType: "touch", clientX: 18, clientY: 20 });
    const secondUp = pointerEvent({ pointerId: 2, pointerType: "touch", clientX: 18, clientY: 20, currentTarget: secondDown.currentTarget });

    act(() => result.current.onPointerDown(firstDown));
    act(() => result.current.onPointerUp(firstUp));
    act(() => vi.advanceTimersByTime(120));
    act(() => result.current.onPointerDown(secondDown));
    act(() => result.current.onPointerUp(secondUp));

    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    expect(secondUp.preventDefault).toHaveBeenCalledTimes(1);

    const clickEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.MouseEvent<HTMLElement>;
    act(() => result.current.onClickCapture(clickEvent));
    expect(clickEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(clickEvent.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("does not fire onDoubleTap when the second tap is too late", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() =>
      useNodeDrag({ taskId: "A", position: { x: 0, y: 0 }, scale: 1, canDrag: false, onPositionChange: vi.fn(), onDoubleTap }),
    );

    act(() => result.current.onPointerDown(pointerEvent({ pointerId: 1, pointerType: "touch" })));
    act(() => result.current.onPointerUp(pointerEvent({ pointerId: 1, pointerType: "touch" })));
    act(() => vi.advanceTimersByTime(320));
    act(() => result.current.onPointerDown(pointerEvent({ pointerId: 2, pointerType: "touch" })));
    act(() => result.current.onPointerUp(pointerEvent({ pointerId: 2, pointerType: "touch" })));

    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("does not fire onDoubleTap for mouse pointer events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() =>
      useNodeDrag({ taskId: "A", position: { x: 0, y: 0 }, scale: 1, canDrag: false, onPositionChange: vi.fn(), onDoubleTap }),
    );

    act(() => result.current.onPointerDown(pointerEvent({ pointerId: 1, pointerType: "mouse" })));
    act(() => result.current.onPointerUp(pointerEvent({ pointerId: 1, pointerType: "mouse" })));
    act(() => vi.advanceTimersByTime(120));
    act(() => result.current.onPointerDown(pointerEvent({ pointerId: 2, pointerType: "mouse" })));
    act(() => result.current.onPointerUp(pointerEvent({ pointerId: 2, pointerType: "mouse" })));

    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("does not fire onDoubleTap after movement reaches the drag threshold", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() =>
      useNodeDrag({ taskId: "A", position: { x: 0, y: 0 }, scale: 1, canDrag: false, onPositionChange: vi.fn(), onDoubleTap }),
    );

    act(() => result.current.onPointerDown(pointerEvent({ pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0 })));
    act(() => result.current.onPointerMove(pointerEvent({ pointerId: 1, pointerType: "touch", clientX: __internal.DRAG_THRESHOLD_PX, clientY: 0 })));
    act(() => result.current.onPointerUp(pointerEvent({ pointerId: 1, pointerType: "touch", clientX: __internal.DRAG_THRESHOLD_PX, clientY: 0 })));
    act(() => vi.advanceTimersByTime(120));
    act(() => result.current.onPointerDown(pointerEvent({ pointerId: 2, pointerType: "touch", clientX: 0, clientY: 0 })));
    act(() => result.current.onPointerUp(pointerEvent({ pointerId: 2, pointerType: "touch", clientX: 0, clientY: 0 })));

    expect(onDoubleTap).not.toHaveBeenCalled();
  });
});
