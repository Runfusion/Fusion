import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

const HORIZONTAL_MOUSE_PAN_THRESHOLD = 4;

type HorizontalMousePanSession = {
  element: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  isPanning: boolean;
  isCaptured: boolean;
};

export interface HorizontalMousePanBindings {
  isPanning: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
}

export interface HorizontalMousePanOptions {
  enabled?: boolean;
  canStartFrom?: (target: EventTarget | null) => boolean;
}

function capturePointer(session: HorizontalMousePanSession): boolean {
  try {
    if (typeof session.element.setPointerCapture !== "function") return false;
    session.element.setPointerCapture(session.pointerId);
    session.isCaptured = true;
    return true;
  } catch {
    return false;
  }
}

function releasePointerCapture(session: HorizontalMousePanSession): void {
  if (!session.isCaptured) return;
  const { element, pointerId } = session;
  try {
    if (element.hasPointerCapture?.(pointerId)) {
      element.releasePointerCapture?.(pointerId);
    }
  } catch {
    // Browser teardown may release capture before React cleanup; terminal cleanup is idempotent.
  }
}

/*
FNXC:HorizontalMousePan 2026-09-12-17:32:
Mouse drag-to-scroll remains native until a four-pixel dominant-horizontal intention is proven. Consumers own descendant admission, while this primitive fences one pointer, captures only after intent, updates the viewport inversely, and consumes exactly the compatibility click produced by a completed pan; touch and pen stay browser-owned.
*/
export function useHorizontalMousePan(
  scrollElement: HTMLElement | null,
  { enabled = true, canStartFrom = () => true }: HorizontalMousePanOptions = {},
): HorizontalMousePanBindings {
  const sessionRef = useRef<HorizontalMousePanSession | null>(null);
  const didPanRef = useRef(false);
  const [isPanning, setIsPanning] = useState(false);

  const endSession = useCallback((pointerId: number, clearClickGuard: boolean) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== pointerId) return;
    releasePointerCapture(session);
    sessionRef.current = null;
    setIsPanning(false);
    if (clearClickGuard) didPanRef.current = false;
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const element = event.currentTarget;
    if (
      !enabled
      || event.pointerType !== "mouse"
      || event.button !== 0
      || !canStartFrom(event.target)
      || element.scrollWidth <= element.clientWidth
      || sessionRef.current
    ) {
      return;
    }

    didPanRef.current = false;
    sessionRef.current = {
      element,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: element.scrollLeft,
      isPanning: false,
      isCaptured: false,
    };
  }, [canStartFrom, enabled]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled) return;
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - session.startX;
    const deltaY = event.clientY - session.startY;
    if (!session.isPanning) {
      if (Math.abs(deltaX) < HORIZONTAL_MOUSE_PAN_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY)) {
        return;
      }
      if (!capturePointer(session)) {
        sessionRef.current = null;
        didPanRef.current = false;
        setIsPanning(false);
        return;
      }
      session.isPanning = true;
      didPanRef.current = true;
      setIsPanning(true);
    }

    event.preventDefault();
    session.element.scrollLeft = session.startScrollLeft - deltaX;
  }, [enabled]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    endSession(event.pointerId, false);
  }, [endSession]);

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    endSession(event.pointerId, true);
  }, [endSession]);

  const onLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    endSession(event.pointerId, true);
  }, [endSession]);

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!enabled || !didPanRef.current) return;
    didPanRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, [enabled]);

  useEffect(() => () => {
    const session = sessionRef.current;
    if (session) releasePointerCapture(session);
    sessionRef.current = null;
    didPanRef.current = false;
    setIsPanning(false);
  }, [scrollElement, enabled]);

  return {
    isPanning,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
    onClickCapture,
  };
}
