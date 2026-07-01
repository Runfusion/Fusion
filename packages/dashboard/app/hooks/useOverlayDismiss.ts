import { createContext, createElement, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";

const ModalDismissPreferenceContext = createContext(false);

export function ModalDismissPreferenceProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return createElement(ModalDismissPreferenceContext.Provider, { value: enabled }, children);
}

export function useModalDismissPreference(): boolean {
  return useContext(ModalDismissPreferenceContext);
}

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
export function useOverlayDismiss(onClose: () => void, options?: { enabled?: boolean }): {
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseUp: (e: React.MouseEvent) => void;
  onTouchStart: () => void;
  onTouchEnd: () => void;
} {
  const contextEnabled = useModalDismissPreference();
  /*
  FNXC:ModalDismissal 2026-06-29-00:00:
  Modal backdrop dismissal is globally default-off to prevent accidental data loss. Components using this helper keep explicit close, cancel, and Escape paths, while backdrop mouse/touch dismissal only runs when the global preference is enabled.
  */
  const dismissEnabled = options?.enabled ?? contextEnabled;
  const startedOnOverlayRef = useRef(false);
  const lastTouchAtRef = useRef(0);

  const markTouch = useCallback(() => {
    lastTouchAtRef.current = Date.now();
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (!dismissEnabled) {
      startedOnOverlayRef.current = false;
      return;
    }
    // Android/webview may emit compatibility mouse events right after touchend.
    // Ignore those so a newly-mounted overlay is not dismissed immediately.
    if (Date.now() - lastTouchAtRef.current < 500) {
      startedOnOverlayRef.current = false;
      return;
    }
    startedOnOverlayRef.current = e.target === e.currentTarget;
  }, [dismissEnabled]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const handleDocumentTouch = () => {
      lastTouchAtRef.current = Date.now();
    };

    document.addEventListener("touchstart", handleDocumentTouch, { passive: true });
    document.addEventListener("touchend", handleDocumentTouch, { passive: true });

    return () => {
      document.removeEventListener("touchstart", handleDocumentTouch);
      document.removeEventListener("touchend", handleDocumentTouch);
    };
  }, []);

  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const shouldClose = dismissEnabled && startedOnOverlayRef.current && e.target === e.currentTarget;
      startedOnOverlayRef.current = false;
      if (shouldClose) onClose();
    },
    [dismissEnabled, onClose],
  );

  return { onMouseDown, onMouseUp, onTouchStart: markTouch, onTouchEnd: markTouch };
}
