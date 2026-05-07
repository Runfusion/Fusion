import { act, renderHook } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
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
    clientX: 0,
    clientY: 0,
    stopPropagation: vi.fn(),
    currentTarget: target,
    ...overrides,
  } as unknown as React.PointerEvent<HTMLElement>;
}

describe("useNodeDrag", () => {
  it("transitions pending to dragging and back on pointer up", () => {
    const onPositionChange = vi.fn();
    const onDragStateChange = vi.fn();
    const { result } = renderHook(() =>
      useNodeDrag({ taskId: "A", position: { x: 10, y: 10 }, scale: 1, onPositionChange, onDragStateChange }),
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
      useNodeDrag({ taskId: "A", position: { x: 0, y: 0 }, scale: 1, onPositionChange }),
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
      useNodeDrag({ taskId: "A", position: { x: 0, y: 0 }, scale: 2, onPositionChange }),
    );

    act(() => result.current.onPointerDown(pointerEvent()));
    act(() => result.current.onPointerMove(pointerEvent({ clientX: 10, clientY: 6 })));

    expect(onPositionChange).toHaveBeenCalledWith("A", { x: 5, y: 3 });
  });

  it("cancels drag cleanly on pointer cancel", () => {
    const onPositionChange = vi.fn();
    const { result } = renderHook(() =>
      useNodeDrag({ taskId: "A", position: { x: 0, y: 0 }, scale: 1, onPositionChange }),
    );

    act(() => result.current.onPointerDown(pointerEvent()));
    act(() => result.current.onPointerMove(pointerEvent({ clientX: 8, clientY: 0 })));
    expect(result.current.isDragging).toBe(true);

    act(() => result.current.onPointerCancel(pointerEvent({ clientX: 8, clientY: 0 })));
    expect(result.current.isDragging).toBe(false);
  });
});
