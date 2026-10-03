import { useEffect, useRef, useState } from "react";
import { isKeyboardFocusableInputType } from "../utils/viewportOffset";

function isKeyboardFocusableElement(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return isKeyboardFocusableInputType(element.type);
  return element instanceof HTMLElement && element.isContentEditable === true;
}

/**
 * Reports the focus transition that precedes a settled visual-viewport keyboard sample.
 * This intentionally shares the ICB predicate so non-text controls never hide mobile chrome.
 */
export function useKeyboardFocusPending(enabled: boolean, keyboardOpen = false): boolean {
  const [pending, setPending] = useState(false);
  const keyboardOpenRef = useRef(keyboardOpen);
  const acknowledgedFocusRef = useRef(false);
  keyboardOpenRef.current = keyboardOpen;

  useEffect(() => {
    if (keyboardOpen) {
      acknowledgedFocusRef.current = true;
      setPending(false);
    }
  }, [keyboardOpen]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      acknowledgedFocusRef.current = false;
      setPending(false);
      return;
    }

    const clear = () => {
      acknowledgedFocusRef.current = false;
      setPending(false);
    };
    const beginFocusTransition = () => {
      const scale = window.visualViewport?.scale ?? 1;
      if (scale > 1.01 || !isKeyboardFocusableElement(document.activeElement)) {
        clear();
        return;
      }

      if (keyboardOpenRef.current) {
        acknowledgedFocusRef.current = true;
        setPending(false);
        return;
      }

      acknowledgedFocusRef.current = false;
      setPending(true);
    };
    const updateViewport = () => {
      const scale = window.visualViewport?.scale ?? 1;
      if (scale > 1.01 || !isKeyboardFocusableElement(document.activeElement)) {
        clear();
        return;
      }

      if (keyboardOpenRef.current || acknowledgedFocusRef.current) {
        setPending(false);
      }
    };
    const viewport = window.visualViewport;
    window.addEventListener("focusin", beginFocusTransition);
    window.addEventListener("focusout", clear);
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    beginFocusTransition();
    return () => {
      window.removeEventListener("focusin", beginFocusTransition);
      window.removeEventListener("focusout", clear);
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
    };
  }, [enabled]);

  /*
  FNXC:ViewportChrome 2026-10-01-05:33:
  Focus can hide mobile chrome only until measured keyboard state acknowledges the opening. iOS can retain textarea focus after dismissal, so a closing VisualViewport event must not recreate pending state or keep navigation off-screen.
  */
  return pending;
}
