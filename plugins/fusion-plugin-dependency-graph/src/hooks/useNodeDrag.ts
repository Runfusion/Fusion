import { useCallback, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { GraphPosition } from "../types.js";

const DRAG_THRESHOLD_PX = 4;
const DOUBLE_TAP_MAX_DELAY_MS = 300;
const DOUBLE_TAP_MAX_DISTANCE_PX = 24;

interface UseNodeDragOptions {
  taskId: string;
  position: GraphPosition;
  scale: number;
  canDrag: boolean;
  onPositionChange: (taskId: string, position: GraphPosition) => void;
  onDragStateChange?: (isDragging: boolean) => void;
  onDragEnd?: () => void;
  onDoubleTap?: () => void;
}

interface PendingState {
  pointerId: number;
  pointerType: string;
  startPointer: { x: number; y: number };
  startPosition: GraphPosition;
  defaultPrevented: boolean;
  movedBeyondThreshold: boolean;
}

interface TapState {
  timeStamp: number;
  point: { x: number; y: number };
}

export function useNodeDrag({
  taskId,
  position,
  scale,
  canDrag,
  onPositionChange,
  onDragStateChange,
  onDragEnd,
  onDoubleTap,
}: UseNodeDragOptions) {
  const [isDragging, setIsDragging] = useState(false);
  const pendingRef = useRef<PendingState | null>(null);
  const positionRef = useRef(position);
  const suppressClickRef = useRef(false);
  const lastTapRef = useRef<TapState | null>(null);
  const dragStateRef = useRef(false);

  positionRef.current = position;
  dragStateRef.current = isDragging;

  const resetTapState = useCallback(() => {
    lastTapRef.current = null;
  }, []);

  const endDrag = useCallback(
    (dragging: boolean) => {
      pendingRef.current = null;
      setIsDragging(false);
      dragStateRef.current = false;
      if (dragging) {
        onDragStateChange?.(false);
        onDragEnd?.();
        suppressClickRef.current = true;
        resetTapState();
      }
    },
    [onDragEnd, onDragStateChange, resetTapState],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!event.isPrimary) return;
      if (event.defaultPrevented) {
        resetTapState();
        return;
      }
      const now = Date.now();
      if (lastTapRef.current && now - lastTapRef.current.timeStamp > DOUBLE_TAP_MAX_DELAY_MS) {
        resetTapState();
      }
      if (canDrag) {
        event.stopPropagation();
      }
      const currentTarget = event.currentTarget;
      if (canDrag && typeof currentTarget.setPointerCapture === "function") {
        currentTarget.setPointerCapture(event.pointerId);
      }
      pendingRef.current = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startPointer: { x: event.clientX, y: event.clientY },
        startPosition: positionRef.current,
        defaultPrevented: event.defaultPrevented,
        movedBeyondThreshold: false,
      };
    },
    [canDrag, resetTapState],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== event.pointerId) return;
      if (canDrag) {
        event.stopPropagation();
      }

      const deltaX = event.clientX - pending.startPointer.x;
      const deltaY = event.clientY - pending.startPointer.y;
      const distance = Math.hypot(deltaX, deltaY);

      if (distance >= DRAG_THRESHOLD_PX) {
        pending.movedBeyondThreshold = true;
      }

      if (!canDrag) {
        if (pending.movedBeyondThreshold) {
          resetTapState();
        }
        return;
      }

      if (!dragStateRef.current && distance >= DRAG_THRESHOLD_PX) {
        setIsDragging(true);
        dragStateRef.current = true;
        onDragStateChange?.(true);
        resetTapState();
      }

      if (distance < DRAG_THRESHOLD_PX) return;

      const safeScale = scale > 0 ? scale : 1;
      onPositionChange(taskId, {
        x: pending.startPosition.x + deltaX / safeScale,
        y: pending.startPosition.y + deltaY / safeScale,
      });
    },
    [canDrag, onDragStateChange, onPositionChange, resetTapState, scale, taskId],
  );

  const maybeHandleDoubleTap = useCallback(
    (_event: ReactPointerEvent<HTMLElement>, pending: PendingState) => {
      if (!onDoubleTap || pending.defaultPrevented || pending.movedBeyondThreshold) {
        if (Date.now() - (lastTapRef.current?.timeStamp ?? 0) > DOUBLE_TAP_MAX_DELAY_MS) {
          resetTapState();
        }
        return false;
      }
      if (pending.pointerType === "mouse") {
        resetTapState();
        return false;
      }
      const currentTap = {
        timeStamp: Date.now(),
        point: { x: pending.startPointer.x, y: pending.startPointer.y },
      };
      const previousTap = lastTapRef.current;
      if (!previousTap) {
        lastTapRef.current = currentTap;
        return false;
      }
      const elapsed = currentTap.timeStamp - previousTap.timeStamp;
      if (elapsed > DOUBLE_TAP_MAX_DELAY_MS) {
        lastTapRef.current = currentTap;
        return false;
      }
      const distance = Math.hypot(currentTap.point.x - previousTap.point.x, currentTap.point.y - previousTap.point.y);
      if (distance > DOUBLE_TAP_MAX_DISTANCE_PX) {
        lastTapRef.current = currentTap;
        return false;
      }
      suppressClickRef.current = true;
      resetTapState();
      onDoubleTap();
      return true;
    },
    [onDoubleTap, resetTapState],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== event.pointerId) return;
      if (canDrag) {
        event.stopPropagation();
      }
      if (
        canDrag &&
        typeof event.currentTarget.hasPointerCapture === "function" &&
        event.currentTarget.hasPointerCapture(event.pointerId) &&
        typeof event.currentTarget.releasePointerCapture === "function"
      ) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const didDrag = dragStateRef.current;
      const didDoubleTap = !didDrag && maybeHandleDoubleTap(event, pending);
      if (didDoubleTap) {
        event.preventDefault();
      }
      endDrag(didDrag);
    },
    [canDrag, endDrag, maybeHandleDoubleTap],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== event.pointerId) return;
      if (canDrag) {
        event.stopPropagation();
      }
      if (
        canDrag &&
        typeof event.currentTarget.hasPointerCapture === "function" &&
        event.currentTarget.hasPointerCapture(event.pointerId) &&
        typeof event.currentTarget.releasePointerCapture === "function"
      ) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      resetTapState();
      endDrag(dragStateRef.current);
    },
    [canDrag, endDrag, resetTapState],
  );

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return useMemo(
    () => ({
      isDragging,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClickCapture,
    }),
    [isDragging, onClickCapture, onPointerCancel, onPointerDown, onPointerMove, onPointerUp],
  );
}

export const __internal = { DRAG_THRESHOLD_PX, DOUBLE_TAP_MAX_DELAY_MS, DOUBLE_TAP_MAX_DISTANCE_PX };
