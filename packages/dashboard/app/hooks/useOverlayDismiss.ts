import { useCallback, useRef } from "react";

/**
 * Returns props for a modal-overlay element that dismisses only when a real
 * overlay click happens — i.e. both mousedown AND mouseup land on the overlay
 * itself.
 *
 * This avoids a subtle dismiss-during-resize bug: when a user drags the
 * native CSS `resize: both` grip from inside a modal and releases the mouse
 * over the overlay, the synthesised click event targets the common ancestor
 * (the overlay). A naive `onClick` handler that checks `e.target === e.currentTarget`
 * is fooled and closes the modal mid-resize.
 *
 * Spread the returned props on the overlay element. The inner modal element
 * does NOT need to stopPropagation — mousedown on the modal sets the ref to
 * `false`, so the overlay's mouseup handler bails.
 */
export function useOverlayDismiss(onClose: () => void): {
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseUp: (e: React.MouseEvent) => void;
} {
  const startedOnOverlayRef = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    startedOnOverlayRef.current = e.target === e.currentTarget;
  }, []);

  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const shouldClose = startedOnOverlayRef.current && e.target === e.currentTarget;
      startedOnOverlayRef.current = false;
      if (shouldClose) onClose();
    },
    [onClose],
  );

  return { onMouseDown, onMouseUp };
}
