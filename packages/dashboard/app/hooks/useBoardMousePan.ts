import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

const BOARD_MOUSE_PAN_THRESHOLD = 4;

type BoardMousePanSession = {
  element: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  isPanning: boolean;
  isCaptured: boolean;
};

export interface BoardMousePanBindings {
  isPanning: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
}

/*
FNXC:BoardNavigation 2026-08-21-18:12:
FN-115 keeps native card activation responsible for stationary and below-threshold mouse input.
Desktop and tablet Board capture begins only after horizontal pan intent, so card bodies/text still
open the configured detail destination while controls, editing, native drag sources, and mobile
column-snap ownership remain native.
*/
function isExcludedBoardPanTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return Boolean(
    target.closest(
      ".card-editing, button, a, input, textarea, select, option, label, summary, [contenteditable='true'], [draggable='true'], [role='button'], [role='link'], [role='textbox'], [role='menuitem'], [role='checkbox'], [role='combobox'], [role='radio'], [role='slider'], [role='switch']",
    ),
  );
}

function capturePointer(session: BoardMousePanSession): boolean {
  try {
    if (typeof session.element.setPointerCapture !== "function") return false;
    session.element.setPointerCapture(session.pointerId);
    session.isCaptured = true;
    return true;
  } catch {
    // FNXC:BoardNavigation 2026-08-21-18:55: FN-115 returns this uncaptured candidate to native activation when the browser declines capture.
    return false;
  }
}

function releasePointerCapture(session: BoardMousePanSession): void {
  if (!session.isCaptured) return;
  const { element, pointerId } = session;
  try {
    if (element.hasPointerCapture?.(pointerId)) {
      element.releasePointerCapture?.(pointerId);
    }
  } catch {
    // Browser teardown may release capture before React's cleanup; terminal cleanup is idempotent.
  }
}

export function useBoardMousePan(boardElement: HTMLElement | null, enabled: boolean): BoardMousePanBindings {
  const sessionRef = useRef<BoardMousePanSession | null>(null);
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
      || isExcludedBoardPanTarget(event.target)
      || element.scrollWidth <= element.clientWidth
    ) {
      return;
    }

    /*
    FNXC:BoardNavigation 2026-08-21-21:32:
    FN-115 fences the one active mouse candidate by pointer ID. A late or mismatched down event
    must not replace the candidate whose eventual native click or captured pan still owns cleanup.
    */
    if (sessionRef.current) return;

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
  }, [enabled]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled) return;
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - session.startX;
    const deltaY = event.clientY - session.startY;
    if (!session.isPanning) {
      if (Math.abs(deltaX) < BOARD_MOUSE_PAN_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY)) {
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
  }, [boardElement, enabled]);

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
