import { useCallback, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { GraphPosition } from "../types";

const DRAG_THRESHOLD_PX = 4;

interface UseNodeDragOptions {
  taskId: string;
  position: GraphPosition;
  scale: number;
  onPositionChange: (taskId: string, position: GraphPosition) => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

interface PendingState {
  pointerId: number;
  startPointer: { x: number; y: number };
  startPosition: GraphPosition;
}

export function useNodeDrag({ taskId, position, scale, onPositionChange, onDragStateChange }: UseNodeDragOptions) {
  const [isDragging, setIsDragging] = useState(false);
  const pendingRef = useRef<PendingState | null>(null);
  const positionRef = useRef(position);
  const suppressClickRef = useRef(false);

  positionRef.current = position;

  const endDrag = useCallback((dragging: boolean) => {
    pendingRef.current = null;
    setIsDragging(false);
    if (dragging) {
      onDragStateChange?.(false);
      suppressClickRef.current = true;
    }
  }, [onDragStateChange]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary) return;
    event.stopPropagation();
    const currentTarget = event.currentTarget;
    if (typeof currentTarget.setPointerCapture === "function") {
      currentTarget.setPointerCapture(event.pointerId);
    }
    pendingRef.current = {
      pointerId: event.pointerId,
      startPointer: { x: event.clientX, y: event.clientY },
      startPosition: positionRef.current,
    };
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const pending = pendingRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    event.stopPropagation();

    const deltaX = event.clientX - pending.startPointer.x;
    const deltaY = event.clientY - pending.startPointer.y;
    const distance = Math.hypot(deltaX, deltaY);

    if (!isDragging && distance >= DRAG_THRESHOLD_PX) {
      setIsDragging(true);
      onDragStateChange?.(true);
    }

    if (distance < DRAG_THRESHOLD_PX) return;

    const safeScale = scale > 0 ? scale : 1;
    onPositionChange(taskId, {
      x: pending.startPosition.x + deltaX / safeScale,
      y: pending.startPosition.y + deltaY / safeScale,
    });
  }, [isDragging, onDragStateChange, onPositionChange, scale, taskId]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const pending = pendingRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (typeof event.currentTarget.hasPointerCapture === "function" && event.currentTarget.hasPointerCapture(event.pointerId) && typeof event.currentTarget.releasePointerCapture === "function") {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    endDrag(isDragging);
  }, [endDrag, isDragging]);

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const pending = pendingRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (typeof event.currentTarget.hasPointerCapture === "function" && event.currentTarget.hasPointerCapture(event.pointerId) && typeof event.currentTarget.releasePointerCapture === "function") {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    endDrag(isDragging);
  }, [endDrag, isDragging]);

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return useMemo(() => ({
    isDragging,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClickCapture,
  }), [isDragging, onClickCapture, onPointerCancel, onPointerDown, onPointerMove, onPointerUp]);
}

export const __internal = { DRAG_THRESHOLD_PX };
