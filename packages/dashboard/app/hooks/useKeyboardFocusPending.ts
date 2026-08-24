import { useEffect, useState } from "react";
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
export function useKeyboardFocusPending(enabled: boolean): boolean {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setPending(false);
      return;
    }

    const update = () => {
      const scale = window.visualViewport?.scale ?? 1;
      setPending(scale <= 1.01 && isKeyboardFocusableElement(document.activeElement));
    };
    const viewport = window.visualViewport;
    window.addEventListener("focusin", update);
    window.addEventListener("focusout", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    update();
    return () => {
      window.removeEventListener("focusin", update);
      window.removeEventListener("focusout", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [enabled]);

  return pending;
}
