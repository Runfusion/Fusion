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
FNXC:BoardNavigation 2026-08-20-04:47:
Desktop and tablet Board navigation restores primary-mouse click-drag panning from safe,
noninteractive descendants such as empty-column text. Interactive, editable, native-draggable,
and task-card descendants keep their native behavior. Mobile owns touch scrolling and column snap,
so this hook is disabled there; edge proximity and stationary pointers never continue scrolling.
*/
function isExcludedBoardPanTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return Boolean(
    target.closest(
      "button, a, input, textarea, select, option, label, summary, [contenteditable='true'], [draggable='true'], [data-id], [role='button'], [role='link'], [role='textbox'], [role='menuitem'], [role='checkbox'], [role='combobox'], [role='radio'], [role='slider'], [role='switch']",
    ),
  );
}

function releasePointerCapture(session: BoardMousePanSession): void {
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

    didPanRef.current = false;
    sessionRef.current = {
      element,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: element.scrollLeft,
      isPanning: false,
    };
    element.setPointerCapture?.(event.pointerId);
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
